"""End-to-end memory lifecycle tests (TASK-107).

The unit-level pieces of the conversation memory — window selection
(``test_window``), trigger math (``test_summary_trigger``), the summarizer
service (``test_summarizer``) and the Celery task (``test_summary_tasks``) —
are covered individually. This module integrates them through the REAL
request-side pipeline:

    UserMessageService.create_turn
        → real finalize (assistant row persisted)
        → real schedule_session_summary_update (on-commit enqueue)
        → eager update_session_summary (scripted summary provider)
        → SessionSummaryTrigger compaction
        → next turn's context built from the compacted session

Acceptance items exercised end to end: recent message selection, summary
trigger, summary boundaries, rolling summary updates and duplicate summary
prevention (including the duplicate-enqueue source created by retries).

Window/threshold are shrunk via settings so a handful of turns crosses the
compaction threshold; the math is identical to the production defaults.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.db import connection

from conversations import tasks as summary_tasks
from conversations.chat import RetryService, UserMessageService, finalize_turn
from conversations.context import SUMMARY_HEADER
from conversations.models import Session
from conversations.summarizer import ARCHIVED_MESSAGES_HEADER, PREVIOUS_SUMMARY_HEADER
from conversations.tasks import update_session_summary
from llm.exceptions import LLMAvailabilityError
from llm.provider import LLMProvider
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    StreamCompleted,
    StreamDelta,
    StreamFailed,
    StreamStart,
)

pytestmark = pytest.mark.django_db

WINDOW = 4
THRESHOLD = 3

SUMMARY_ONE = "Turns 1-2: learner greets the tutor and asks about travel small talk."
SUMMARY_TWO = "Through turn 4: learner books a role-play at a Lisbon cafe; prefers past tense."

SERVED_MODEL = "served/memory-model"


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


class EagerSummaryTask:
    """Runs the real task inline whenever request-side code calls .delay().

    Stands in for the broker hop only: the task body, trigger, row locks and
    persistence all stay real. Records how many times maintenance was
    enqueued so duplicate scheduling can be observed.
    """

    def __init__(self) -> None:
        self.enqueued: list[int] = []

    def delay(self, session_id: int) -> None:
        self.enqueued.append(session_id)
        update_session_summary.apply(args=[session_id])


def flush_on_commit_callbacks() -> int:
    """Run (and drain) pending on-commit hooks; return how many ran.

    Django 6 removed captureOnCommitCallbacks and pytest-django never
    commits, so hooks are drained manually — entries are ``(sids, func,
    robust)`` tuples. Draining is recursive: the turn hook calls the real
    ``schedule_session_summary_update``, which itself registers a further
    on-commit hook (it runs immediately in production autocommit, but the
    test's outer atomic block queues it again).
    """
    total = 0
    while True:
        pending, connection.run_on_commit = connection.run_on_commit, []
        if not pending:
            return total
        for _sids, func, _robust in pending:
            func()
        total += len(pending)


def archived_lines(request: CompletionRequest) -> list[str]:
    """The labeled ``role: content`` lines inside one summarizer prompt."""
    user_text = request.messages[-1].content
    body = user_text.split(ARCHIVED_MESSAGES_HEADER, 1)[1]
    body = body.rsplit("Write the updated summary", 1)[0]
    return [line.strip() for line in body.strip().splitlines() if line.strip()]


def run_turn(session, user, text: str, *, fail: bool = False, finalize: bool = True):
    """One full chat turn through the real services.

    Creates the turn, then drives the real ``finalize_turn`` persistence: a
    completed stream by default, a failed stream when ``fail=True``, or an
    abandoned stream (assistant row left pending) when ``finalize=False``.
    """
    prepared = UserMessageService().create_turn(session_id=session.pk, user=user, text=text)
    if not finalize:
        return prepared
    if fail:
        events: list = [StreamFailed(error=LLMAvailabilityError("stream aborted"), text="")]
    else:
        events = [
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="..."),
            StreamCompleted(text=f"echo {text}", model=SERVED_MODEL, delta_count=1),
        ]
    list(finalize_turn(prepared.assistant_message, iter(events)))
    return prepared


@pytest.fixture(autouse=True)
def memory_settings(settings):
    """Shrink the window and threshold so a few turns cross compaction."""
    settings.CONTEXT_RECENT_MESSAGE_WINDOW = WINDOW
    settings.CONTEXT_SUMMARY_TRIGGER_THRESHOLD = THRESHOLD


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="memory-user", email="memory@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(
        user=user, title="Traveling", topic="Planning a trip to Lisbon", learning_level="B2"
    )


@pytest.fixture
def provider(monkeypatch) -> ScriptedProvider:
    """Scripted summary provider wired into the real task provider seam."""
    scripted = ScriptedProvider()
    monkeypatch.setattr(summary_tasks, "get_summary_provider", lambda: scripted)
    return scripted


@pytest.fixture
def summary_task(monkeypatch) -> EagerSummaryTask:
    """Eager stand-in for the registered task behind the real scheduler."""
    task = EagerSummaryTask()
    monkeypatch.setattr(summary_tasks, "update_session_summary", task)
    return task


class TestMemoryLifecycle:
    def test_short_conversation_never_triggers_summary(self, session, user, provider, summary_task):
        for index in range(1, THRESHOLD + 1):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()

        assert provider.requests == []
        assert summary_task.enqueued == [session.pk] * THRESHOLD
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_threshold_crossing_compacts_exactly_once(self, session, user, provider, summary_task):
        provider.outcomes.append(CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL))
        for index in range(1, 6):  # compaction first fires while storing turn 4
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()
            if index < 4:
                assert provider.requests == []
                session.refresh_from_db()
                assert session.summary_message_boundary == 0

        assert summary_task.enqueued == [session.pk] * 5
        assert len(provider.requests) == 1
        assert archived_lines(provider.requests[0]) == [
            "user: hi 1",
            "assistant: echo hi 1",
            "user: hi 2",
            "assistant: echo hi 2",
        ]
        session.refresh_from_db()
        assert session.summary == SUMMARY_ONE
        assert session.summary_message_boundary == 4

    def test_context_after_compaction_carries_summary_and_excludes_archived_turns(
        self, session, user, provider, summary_task
    ):
        provider.outcomes.append(CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL))
        for index in range(1, 5):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()

        prepared = run_turn(session, user, "hi 5")

        messages = prepared.request.messages
        assert SUMMARY_HEADER in messages[0].content
        assert SUMMARY_ONE in messages[0].content
        assert [(m.role, m.content) for m in messages[1:-1]] == [
            ("user", "hi 3"),
            ("assistant", "echo hi 3"),
            ("user", "hi 4"),
            ("assistant", "echo hi 4"),
        ]
        joined = "\n".join(m.content for m in messages)
        for archived in ("hi 1", "echo hi 1", "hi 2", "echo hi 2"):
            assert archived not in joined

    def test_rolling_summary_advances_across_two_compactions(
        self, session, user, provider, summary_task
    ):
        provider.outcomes.extend(
            [
                CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL),
                CompletionResponse(text=SUMMARY_TWO, model=SERVED_MODEL),
            ]
        )
        for index in range(1, 7):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()

        assert len(provider.requests) == 2
        assert archived_lines(provider.requests[0]) == [
            "user: hi 1",
            "assistant: echo hi 1",
            "user: hi 2",
            "assistant: echo hi 2",
        ]
        second_prompt = provider.requests[1].messages[-1].content
        assert PREVIOUS_SUMMARY_HEADER in second_prompt
        assert SUMMARY_ONE in second_prompt
        assert archived_lines(provider.requests[1]) == [
            "user: hi 3",
            "assistant: echo hi 3",
            "user: hi 4",
            "assistant: echo hi 4",
        ]
        session.refresh_from_db()
        assert session.summary == SUMMARY_TWO
        assert session.summary_message_boundary == 8

    def test_duplicate_enqueues_and_reruns_never_resummarize(
        self, session, user, provider, summary_task
    ):
        provider.outcomes.extend(
            [
                CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL),
                CompletionResponse(text=SUMMARY_TWO, model=SERVED_MODEL),
            ]
        )
        for index in range(1, 7):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()

        # Turn 5's own enqueue ran right after compaction 1 and found nothing
        # left above the threshold; extra drains and direct task reruns must
        # stay no-ops as well.
        assert flush_on_commit_callbacks() == 0
        assert update_session_summary.apply(args=[session.pk]).result is False
        assert update_session_summary.apply(args=[session.pk]).result is False

        assert len(provider.requests) == 2
        session.refresh_from_db()
        assert session.summary == SUMMARY_TWO
        assert session.summary_message_boundary == 8

    def test_pending_and_failed_generations_stay_out_of_memory(
        self, session, user, provider, summary_task
    ):
        provider.outcomes.extend(
            [
                CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL),
                CompletionResponse(text=SUMMARY_TWO, model=SERVED_MODEL),
            ]
        )
        for index in range(1, 5):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()

        run_turn(session, user, "hi 5", fail=True)  # assistant row FAILED, blank
        run_turn(session, user, "hi 6", finalize=False)  # assistant row PENDING
        flush_on_commit_callbacks()

        # The failed/pending rows still counted toward the boundary math but
        # contributed nothing to the summarizer prompt for range 5-8.
        assert len(provider.requests) == 2
        assert archived_lines(provider.requests[1]) == [
            "user: hi 3",
            "assistant: echo hi 3",
            "user: hi 4",
            "assistant: echo hi 4",
        ]
        session.refresh_from_db()
        assert session.summary_message_boundary == 8

        prepared = run_turn(session, user, "hi 7")
        messages = prepared.request.messages
        # The user rows of the failed/pending turns stay in context; only
        # their assistant generations (failed blank row, pending row) are
        # excluded from history and from the summarizer prompt.
        assert [(m.role, m.content) for m in messages[1:-1]] == [
            ("user", "hi 5"),
            ("user", "hi 6"),
        ]
        assert SUMMARY_TWO in messages[0].content

    def test_retry_scheduling_never_duplicates_summary_work(
        self, session, user, provider, summary_task
    ):
        provider.outcomes.extend(
            [
                CompletionResponse(text=SUMMARY_ONE, model=SERVED_MODEL),
                CompletionResponse(text=SUMMARY_TWO, model=SERVED_MODEL),
            ]
        )
        for index in range(1, 5):
            run_turn(session, user, f"hi {index}")
            flush_on_commit_callbacks()
        failed = run_turn(session, user, "hi 5", fail=True)
        flush_on_commit_callbacks()

        RetryService().prepare_retry(
            session_id=session.pk, message_id=failed.assistant_message.pk, user=user
        )
        # One scheduling = the turn hook plus its enqueue hook (recursive drain).
        assert flush_on_commit_callbacks() == 2
        assert len(provider.requests) == 1  # retry enqueue was a no-op

        session.refresh_from_db()
        assert session.summary_message_boundary == 4

        run_turn(session, user, "hi 6")
        flush_on_commit_callbacks()

        assert len(provider.requests) == 2
        session.refresh_from_db()
        assert session.summary_message_boundary == 8
        assert session.summary == SUMMARY_TWO
