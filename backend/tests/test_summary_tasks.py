"""Tests for asynchronous summary maintenance (conversations.tasks, TASK-039)."""

import logging

import pytest
from django.contrib.auth import get_user_model
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.test import SimpleTestCase, override_settings

from conversations import tasks as summary_tasks
from conversations.models import Message, Session
from conversations.summarizer import PREVIOUS_SUMMARY_HEADER
from conversations.tasks import (
    SUMMARY_UPDATE_BACKOFF_MAX_SECONDS,
    SUMMARY_UPDATE_BACKOFF_SECONDS,
    SUMMARY_UPDATE_MAX_RETRIES,
    get_summary_provider,
    schedule_session_summary_update,
    summarize_session,
    update_session_summary,
)
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError, LLMResponseError
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

WINDOW = 20
THRESHOLD = 40

SUMMARY_ONE = "First forty turns: learner plans a trip to Lisbon and prefers past-tense practice."
SUMMARY_TWO = "Through turn eighty: trip booked for April; learner still confuses present perfect."

SECRET_SUMMARY = "SECRET-SUMMARY-TEXT"
SERVED_MODEL = "served/tasks-model"

ARCHIVED_HEADER = (
    "These messages have just left the recent window and must now be folded into the summary:"
)
WRITE_PREFIX = "Write the updated summary covering everything"


class ScriptedProvider(LLMProvider):
    """Fake provider popping one scripted outcome per call and recording requests."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def stream(self, request: CompletionRequest):
        raise AssertionError("summary maintenance never streams")


def response(text: str) -> CompletionResponse:
    return CompletionResponse(text=text, model=SERVED_MODEL)


def archived_lines(request: CompletionRequest) -> list[str]:
    """The labeled `role: content` lines inside one summarizer prompt."""
    user_text = request.messages[-1].content
    body = user_text.split(ARCHIVED_HEADER, 1)[1]
    body = body.split(WRITE_PREFIX, 1)[0]
    return [line.strip() for line in body.strip().splitlines() if line.strip()]


class FakeTask:
    """Stand-in for the registered task when testing the scheduler."""

    def __init__(self) -> None:
        self.enqueued: list[int] = []

    def delay(self, session_id: int) -> None:
        self.enqueued.append(session_id)


def flush_on_commit_callbacks():
    """Run (and drain) the current connection's pending on-commit hooks.

    Django 6 removed ``captureOnCommitCallbacks``; under pytest-django tests
    never commit, so the hooks registered during a test are drained manually
    exactly like the removed helper did.
    """
    connection = connections[DEFAULT_DB_ALIAS]
    pending, connection.run_on_commit = connection.run_on_commit, []
    for entry in pending:
        entry[1]()


# ---------------------------------------------------------------------------
# Task configuration (no database).
# ---------------------------------------------------------------------------


class UpdateSessionSummaryConfiguration(SimpleTestCase):
    """The registered task carries its reliability contract in its options."""

    def test_name_is_stable(self) -> None:
        assert update_session_summary.name == "conversations.update_session_summary"

    def test_retry_budget_is_bounded(self) -> None:
        assert update_session_summary.max_retries == SUMMARY_UPDATE_MAX_RETRIES == 5

    def test_backoff_is_exponential_with_jitter(self) -> None:
        assert update_session_summary.retry_backoff == SUMMARY_UPDATE_BACKOFF_SECONDS == 5
        assert update_session_summary.retry_backoff_max == SUMMARY_UPDATE_BACKOFF_MAX_SECONDS == 600
        assert update_session_summary.retry_jitter is True

    def test_late_ack_survives_worker_crashes(self) -> None:
        assert update_session_summary.acks_late is True


# ---------------------------------------------------------------------------
# Provider seam.
# ---------------------------------------------------------------------------


class SummaryProviderSeamTests(SimpleTestCase):
    """get_summary_provider mirrors the llm.views service-seam pattern."""

    @override_settings(OPENROUTER_API_KEY="seam-test-key")
    def test_builds_fallback_provider_from_settings(self) -> None:
        provider = get_summary_provider()
        assert isinstance(provider, FallbackProvider)
        assert isinstance(provider, LLMProvider)

    @override_settings(OPENROUTER_API_KEY="seam-test-key")
    def test_provider_identity_is_cached_per_process(self) -> None:
        assert get_summary_provider() is get_summary_provider()


# ---------------------------------------------------------------------------
# Task behavior against the real database (executed eagerly).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestUpdateSessionSummary:
    """update_session_summary executed through Celery's eager apply()."""

    @pytest.fixture
    def user(self, db):
        return get_user_model().objects.create_user(
            username="carol", email="carol@example.com", password="pw-123456"
        )

    @pytest.fixture
    def session(self, user):
        return Session.objects.create(user=user, title="Chat", topic="Traveling")

    def fill(self, session, count, *, offset=0):
        """Append an alternating assistant-first transcript of complete turns."""
        for i in range(offset + 1, offset + count + 1):
            role = Message.Role.ASSISTANT if i % 2 == 1 else Message.Role.USER
            Message.append(session, role=role, content=f"turn {i}", status=Message.Status.COMPLETE)

    def use_provider(self, monkeypatch, *outcomes):
        provider = ScriptedProvider(*outcomes)
        monkeypatch.setattr(summary_tasks, "get_summary_provider", lambda: provider)
        return provider

    def apply_task(self, session_id):
        return update_session_summary.apply(args=[session_id])

    # -- happy path ---------------------------------------------------------

    def test_persists_summary_and_boundary(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        self.use_provider(monkeypatch, response(SUMMARY_ONE))

        result = self.apply_task(session.pk)

        assert result.result is True
        session.refresh_from_db()
        assert session.summary == SUMMARY_ONE
        assert session.summary_message_boundary == THRESHOLD

    def test_threshold_not_crossed_is_a_no_op_without_provider_call(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD - 1)
        provider = self.use_provider(monkeypatch, response(SUMMARY_ONE))

        result = self.apply_task(session.pk)

        assert result.result is False
        assert provider.requests == []
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_missing_session_is_a_graceful_no_op(self, session, monkeypatch):
        provider = self.use_provider(monkeypatch, response(SUMMARY_ONE))
        session_id = session.pk
        session.delete()

        result = self.apply_task(session_id)

        assert result.result is False
        assert provider.requests == []

    # -- retryable failure ----------------------------------------------------
    # Note: eager apply() re-executes retried tasks inline (celery Task.apply
    # follows the Retry signature locally), so one scripted provider sees
    # every attempt of a single .apply() call.

    def test_retryable_failure_is_retried_and_eventually_succeeds(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        provider = self.use_provider(
            monkeypatch,
            LLMAvailabilityError("upstream down"),
            response(SUMMARY_ONE),
        )

        result = self.apply_task(session.pk)

        assert result.state == "SUCCESS"
        assert result.result is True
        assert len(provider.requests) == 2
        session.refresh_from_db()
        assert session.summary == SUMMARY_ONE
        assert session.summary_message_boundary == THRESHOLD

    def test_retry_budget_exhaustion_surfaces_the_original_error_and_keeps_session_usable(
        self, session, monkeypatch
    ):
        self.fill(session, WINDOW + THRESHOLD)
        monkeypatch.setattr(update_session_summary, "max_retries", 0)
        provider = self.use_provider(monkeypatch, *[LLMAvailabilityError("still down")] * 3)

        result = self.apply_task(session.pk)

        assert result.state == "FAILURE"
        assert isinstance(result.result, LLMAvailabilityError)
        assert "still down" in str(result.result)
        assert len(provider.requests) == 1
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_repeated_runs_never_produce_duplicate_ranges(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        provider = self.use_provider(monkeypatch, response(SUMMARY_ONE))

        assert self.apply_task(session.pk).result is True
        assert self.apply_task(session.pk).result is False

        assert len(provider.requests) == 1
        session.refresh_from_db()
        assert session.summary_message_boundary == THRESHOLD
        assert archived_lines(provider.requests[0]) == [
            f"{'assistant' if i % 2 == 1 else 'user'}: turn {i}" for i in range(1, 41)
        ]

    # -- permanent failure ---------------------------------------------------

    def test_non_retryable_failure_completes_without_retry_or_change(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        self.use_provider(monkeypatch, LLMAuthenticationError("provider rejected credentials"))

        result = self.apply_task(session.pk)

        assert result.state == "SUCCESS"
        assert result.result is False
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_unusable_output_failure_completes_without_retry_or_change(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        provider = self.use_provider(
            monkeypatch,
            LLMResponseError("blank completion", provider="summaries", model=SERVED_MODEL),
        )

        result = self.apply_task(session.pk)

        assert result.state == "SUCCESS"
        assert result.result is False
        assert len(provider.requests) == 1
        session.refresh_from_db()
        assert session.summary_message_boundary == 0

    # -- rolling batches ------------------------------------------------------

    def test_second_batch_rolls_previous_summary_forward(self, session, monkeypatch):
        self.fill(session, WINDOW + THRESHOLD)
        self.use_provider(monkeypatch, response(SUMMARY_ONE))
        assert self.apply_task(session.pk).result is True

        self.fill(session, THRESHOLD, offset=WINDOW + THRESHOLD)
        second = self.use_provider(monkeypatch, response(SUMMARY_TWO))

        result = self.apply_task(session.pk)

        assert result.result is True
        session.refresh_from_db()
        assert session.summary == SUMMARY_TWO
        assert session.summary_message_boundary == 2 * THRESHOLD
        assert archived_lines(second.requests[0]) == [
            f"{'assistant' if i % 2 == 1 else 'user'}: turn {i}"
            for i in range(THRESHOLD + 1, 2 * THRESHOLD + 1)
        ]
        assert PREVIOUS_SUMMARY_HEADER in second.requests[0].messages[-1].content

    # -- log hygiene ----------------------------------------------------------

    def test_failure_logs_carry_ids_not_payloads(self, session, monkeypatch, caplog):
        self.fill(session, WINDOW + THRESHOLD)
        self.use_provider(monkeypatch, LLMAvailabilityError("upstream exploded"))
        with caplog.at_level(logging.DEBUG, logger="conversations.tasks"):
            self.apply_task(session.pk)

        joined = "\n".join(f"{r.levelname}:{r.getMessage()}" for r in caplog.records)
        assert f"session={session.pk}" in joined
        assert "upstream exploded" in joined
        assert "turn 1" not in joined
        assert SECRET_SUMMARY not in joined


# ---------------------------------------------------------------------------
# Scheduler: enqueue exactly once, only after commit.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScheduleSessionSummaryUpdate:
    @pytest.fixture
    def user(self, db):
        return get_user_model().objects.create_user(
            username="dave", email="dave@example.com", password="pw-123456"
        )

    @pytest.fixture
    def session(self, user):
        return Session.objects.create(user=user, title="Chat", topic="Traveling")

    @pytest.fixture
    def fake_task(self, monkeypatch):
        fake = FakeTask()
        monkeypatch.setattr(summary_tasks, "update_session_summary", fake)
        return fake

    def test_enqueues_exactly_once_after_commit(self, session, fake_task):
        schedule_session_summary_update(session.pk)
        assert fake_task.enqueued == []

        flush_on_commit_callbacks()

        assert fake_task.enqueued == [session.pk]

        flush_on_commit_callbacks()
        assert fake_task.enqueued == [session.pk]

    def test_rolled_back_transaction_never_enqueues(self, session, fake_task):
        with transaction.atomic():
            schedule_session_summary_update(session.pk)
            transaction.set_rollback(True)

        flush_on_commit_callbacks()

        assert fake_task.enqueued == []


# ---------------------------------------------------------------------------
# Direct body call (worker-free path used by retries and tests elsewhere).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSummarizeSessionBody:
    def test_returns_false_for_missing_session(self, db):
        assert summarize_session(999_999) is False
