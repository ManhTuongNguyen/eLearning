"""End-to-end vocabulary lifecycle tests (TASK-108).

The unit-level pieces — the save API (``test_vocabulary_save_api``),
post-commit scheduling (``test_vocabulary_enrichment_scheduling``), the
enrichment task (``test_vocabulary_enrichment``), the list API
(``test_vocabulary_list_api``) and the CSV export
(``test_vocabulary_csv_export``/``test_vocabulary_export_api``) — are covered
individually. This module integrates them through the REAL pipeline:

    POST /api/v1/vocabulary/
        → pending row persisted synchronously
        → schedule_vocabulary_enrichment (on-commit hook)
        → real enrich_vocabulary_item task (eagerly applied, scripted provider)
        → enriched row visible through GET /api/v1/vocabulary/
        → enriched card exported through GET /api/v1/vocabulary/export/

Acceptance items exercised end to end: immediate save, transaction-rollback
safety, exactly-one Celery enqueue per committed save, enrichment (including
retryable recovery and permanent-failure status), user ownership isolation and
Anki CSV export built from genuinely enriched data.
"""

from __future__ import annotations

import csv
import io

import pytest
from django.contrib.auth import get_user_model
from django.db import connection, transaction
from rest_framework.test import APIClient

from conversations.models import Message, Session
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse
from vocabulary import tasks as vocab_tasks
from vocabulary.models import VocabularyItem
from vocabulary.tasks import enrich_vocabulary_item, schedule_vocabulary_enrichment

pytestmark = pytest.mark.django_db

SAVE_URL = "/api/v1/vocabulary/"
EXPORT_URL = "/api/v1/vocabulary/export/"
SERVED_MODEL = "served/integration-model"

ENRICHMENT_JSON = (
    '{"definition": "to leave on a journey", '
    '"translation": "begin a trip", '
    '"pronunciation": "/set \u0252f/", '
    '"part_of_speech": "phrasal verb", '
    '"example": "We set off at dawn."}'
)


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
        raise AssertionError("vocabulary enrichment never streams")


class EagerEnrichmentTask:
    """Runs the real task inline whenever the scheduler calls .delay().

    Stands in for the broker hop only: the task body, retry machinery and
    persistence stay real. Records enqueue order so scheduling guarantees
    (exactly one post-commit enqueue per committed save) stay observable.
    """

    def __init__(self) -> None:
        self.enqueued: list[int] = []

    def delay(self, vocabulary_id: int) -> None:
        self.enqueued.append(vocabulary_id)
        enrich_vocabulary_item.apply(args=[vocabulary_id])


def flush_on_commit_callbacks() -> int:
    """Run (and drain) pending on-commit hooks; return how many ran.

    Django 6 removed captureOnCommitCallbacks and pytest-django never
    commits, so hooks are drained manually — entries are ``(sids, func,
    robust)`` tuples. Draining stands in for the transaction committing.
    """
    pending, connection.run_on_commit = connection.run_on_commit, []
    for _sids, func, _robust in pending:
        func()
    return len(pending)


def response(text: str) -> CompletionResponse:
    return CompletionResponse(text=text, model=SERVED_MODEL)


def export_rows(api) -> list[list[str]]:
    """Fetch the export and round-trip it through the stdlib CSV reader."""
    text = api.get(EXPORT_URL).content.decode("utf-8")
    return list(csv.reader(io.StringIO(text, newline="")))


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="bob", email="bob@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(user=user, title="Trips", topic="Traveling", learning_level="B2")


@pytest.fixture
def message(session):
    return Message.append(session, role=Message.Role.USER, content="We set off at dawn")


@pytest.fixture
def stranger_session(stranger):
    return Session.objects.create(user=stranger, title="Secret", topic="X")


@pytest.fixture
def stranger_message(stranger_session):
    return Message.append(
        stranger_session, role=Message.Role.ASSISTANT, content="stranger words", status="complete"
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def chat_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def stranger_api(db, stranger):
    client = APIClient()
    client.force_authenticate(user=stranger)
    return client


@pytest.fixture
def provider(monkeypatch) -> ScriptedProvider:
    """Scripted enrichment provider wired into the real task provider seam."""
    scripted = ScriptedProvider()
    monkeypatch.setattr(vocab_tasks, "get_enrichment_provider", lambda: scripted)
    return scripted


@pytest.fixture
def eager(monkeypatch) -> EagerEnrichmentTask:
    """Eager stand-in for the registered task behind the real scheduler."""
    task = EagerEnrichmentTask()
    monkeypatch.setattr(vocab_tasks, "enrich_vocabulary_item", task)
    return task


# ---------------------------------------------------------------------------
# Save → enqueue → enrich → list/export lifecycle.
# ---------------------------------------------------------------------------


class TestSavedVocabularyLifecycle:
    def test_save_responds_immediately_with_pending_row_and_one_queued_job(self, chat_api, eager):
        """The save returns before enrichment; exactly one job waits post-commit."""
        response = chat_api.post(SAVE_URL, {"expression": "Set Off"}, format="json")

        assert response.status_code == 201
        assert response.data["status"] == VocabularyItem.Status.PENDING
        assert response.data["definition"] == ""
        assert eager.enqueued == []  # nothing reaches the broker before commit

        assert flush_on_commit_callbacks() == 1
        assert eager.enqueued == [response.data["id"]]

    def test_enrichment_result_flows_through_list_and_export(self, chat_api, provider, eager):
        provider.outcomes.append(response(ENRICHMENT_JSON))
        saved = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        flush_on_commit_callbacks()

        item = VocabularyItem.objects.get(pk=saved.data["id"])
        assert item.is_enriched
        assert item.definition == "to leave on a journey"
        assert item.translation == "begin a trip"
        assert item.pronunciation == "/set \u0252f/"
        assert item.part_of_speech == "phrasal verb"
        assert item.example == "We set off at dawn."

        listed = chat_api.get(SAVE_URL).data["results"]
        assert [(row["expression"], row["status"]) for row in listed] == [
            ("set off", VocabularyItem.Status.COMPLETE)
        ]
        assert listed[0]["definition"] == "to leave on a journey"

        assert export_rows(chat_api) == [
            ["Front", "Back", "Example", "Pronunciation"],
            ["set off", "to leave on a journey", "We set off at dawn.", "/set \u0252f/"],
        ]

    def test_enrichment_prompt_carries_expression_and_source_session_level(
        self, chat_api, provider, eager, message
    ):
        provider.outcomes.append(response(ENRICHMENT_JSON))
        saved = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": message.pk},
            format="json",
        )
        flush_on_commit_callbacks()

        item = VocabularyItem.objects.get(pk=saved.data["id"])
        assert item.source_message == message
        assert item.source_session == message.session
        assert item.is_enriched

        prompt = provider.requests[0].messages[-1].content
        assert 'The learner\'s expression: "set off"' in prompt
        assert "B2" in prompt  # resolved from the source session, not AUTO


# ---------------------------------------------------------------------------
# Rollback safety and failed saves.
# ---------------------------------------------------------------------------


class TestRollbackSafety:
    def test_rolled_back_save_leaves_no_row_and_enqueues_nothing(self, user, eager):
        """A transaction that rolls back persists nothing and schedules nothing."""
        with transaction.atomic():
            item = VocabularyItem.objects.create(
                user=user, expression="set off", normalized_expression="set off"
            )
            schedule_vocabulary_enrichment(item.pk)
            transaction.set_rollback(True)

        flush_on_commit_callbacks()

        assert eager.enqueued == []
        assert VocabularyItem.objects.count() == 0

    def test_rejected_save_requests_write_nothing_and_schedule_nothing(
        self, chat_api, eager, stranger_message
    ):
        blank = chat_api.post(SAVE_URL, {"expression": "   "}, format="json")
        foreign_source = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": stranger_message.pk},
            format="json",
        )

        assert blank.status_code == 400
        assert foreign_source.status_code == 404

        flush_on_commit_callbacks()

        assert eager.enqueued == []
        assert VocabularyItem.objects.count() == 0

    def test_duplicate_save_enqueues_only_the_original_job(self, chat_api, eager):
        first = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        chat_api.post(SAVE_URL, {"expression": "  SET OFF "}, format="json")

        assert flush_on_commit_callbacks() == 1

        assert eager.enqueued == [first.data["id"]]
        assert VocabularyItem.objects.count() == 1


# ---------------------------------------------------------------------------
# Enrichment resilience through the real scheduling pipeline.
# ---------------------------------------------------------------------------


class TestEnrichmentResilience:
    def test_transient_failure_retries_inline_and_completes(self, chat_api, provider, eager):
        provider.outcomes.extend([LLMAvailabilityError("upstream down"), response(ENRICHMENT_JSON)])
        saved = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        flush_on_commit_callbacks()

        assert len(provider.requests) == 2
        item = VocabularyItem.objects.get(pk=saved.data["id"])
        assert item.is_enriched
        assert item.definition == "to leave on a journey"

    def test_permanent_failure_marks_failed_keeps_row_and_recovers_on_new_run(
        self, chat_api, provider, eager
    ):
        """Auth failure abandons without deleting; a later run still completes it."""
        provider.outcomes.extend(
            [LLMAuthenticationError("provider rejected credentials"), response(ENRICHMENT_JSON)]
        )
        saved = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        flush_on_commit_callbacks()

        item = VocabularyItem.objects.get(pk=saved.data["id"])
        assert item.status == VocabularyItem.Status.FAILED
        assert item.expression == "set off"
        assert item.definition == ""
        statuses = [
            (row["expression"], row["status"]) for row in chat_api.get(SAVE_URL).data["results"]
        ]
        assert statuses == [("set off", VocabularyItem.Status.FAILED)]

        # A later re-enrichment attempt (worker retry or new schedule) succeeds.
        schedule_vocabulary_enrichment(item.pk)
        flush_on_commit_callbacks()

        item.refresh_from_db()
        assert item.is_enriched
        assert export_rows(chat_api)[1] == [
            "set off",
            "to leave on a journey",
            "We set off at dawn.",
            "/set \u0252f/",
        ]


# ---------------------------------------------------------------------------
# Ownership isolation across users.
# ---------------------------------------------------------------------------


class TestUserIsolation:
    def test_saved_vocabulary_stays_isolated_between_users(
        self, chat_api, stranger_api, provider, eager, user, stranger
    ):
        provider.outcomes.extend([response(ENRICHMENT_JSON), response(ENRICHMENT_JSON)])
        mine = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        theirs = stranger_api.post(SAVE_URL, {"expression": "SET OFF"}, format="json")
        flush_on_commit_callbacks()

        assert mine.data["id"] != theirs.data["id"]

        mine_rows = chat_api.get(SAVE_URL).data["results"]
        theirs_rows = stranger_api.get(SAVE_URL).data["results"]
        assert [(row["expression"], row["id"]) for row in mine_rows] == [
            ("set off", mine.data["id"])
        ]
        assert [(row["expression"], row["id"]) for row in theirs_rows] == [
            ("SET OFF", theirs.data["id"])
        ]
        assert VocabularyItem.objects.get(pk=mine.data["id"]).user == user
        assert VocabularyItem.objects.get(pk=theirs.data["id"]).user == stranger

        assert [row[0] for row in export_rows(chat_api)[1:]] == ["set off"]
        assert [row[0] for row in export_rows(stranger_api)[1:]] == ["SET OFF"]

    def test_foreign_source_message_is_unusable_end_to_end(
        self, chat_api, eager, stranger_message, message
    ):
        stranger_attempt = chat_api.post(
            SAVE_URL,
            {"expression": "stolen", "source_message_id": stranger_message.pk},
            format="json",
        )
        own_attempt = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": message.pk},
            format="json",
        )
        flush_on_commit_callbacks()

        assert stranger_attempt.status_code == 404
        assert own_attempt.status_code == 201
        item = VocabularyItem.objects.get(pk=own_attempt.data["id"])
        assert item.source_message == message
        assert eager.enqueued == [own_attempt.data["id"]]
        assert VocabularyItem.objects.filter(expression="stolen").exists() is False


# ---------------------------------------------------------------------------
# CSV export built from genuinely enriched pipeline data.
# ---------------------------------------------------------------------------


class TestCsvExportEndToEnd:
    def test_export_contains_enriched_and_pending_cards_in_save_order(
        self, chat_api, provider, eager
    ):
        provider.outcomes.extend([response(ENRICHMENT_JSON)])
        enriched = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        flush_on_commit_callbacks()
        pending = chat_api.post(SAVE_URL, {"expression": "gobsmacked"}, format="json")

        rows = export_rows(chat_api)

        assert rows[0] == ["Front", "Back", "Example", "Pronunciation"]
        assert rows[1] == [
            "gobsmacked",
            "",
            "",
            "",
        ]  # newest first: the still-pending save leads
        assert rows[2] == [
            "set off",
            "to leave on a journey",
            "We set off at dawn.",
            "/set \u0252f/",
        ]
        assert VocabularyItem.objects.get(pk=pending.data["id"]).is_pending
        assert VocabularyItem.objects.get(pk=enriched.data["id"]).is_enriched
