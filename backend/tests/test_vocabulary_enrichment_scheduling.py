"""Tests for post-commit enrichment scheduling (vocabulary.tasks, TASK-067).

Covers the registered task's identity, the placeholder body contract that
TASK-068 replaces, the ``schedule_vocabulary_enrichment`` commit-hook
semantics (nothing enqueued before COMMIT, exactly one enqueue after,
rolled-back transactions never enqueue) and the save-view wiring: new
schedules enqueue once post-commit while duplicates, validation failures
and source-message 404s schedule nothing.
"""

import pytest
from django.contrib.auth import get_user_model
from django.db import DEFAULT_DB_ALIAS, connections, transaction
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from vocabulary import tasks as vocab_tasks
from vocabulary.models import VocabularyItem
from vocabulary.tasks import enrich_vocabulary_item, schedule_vocabulary_enrichment

SAVE_URL = "/api/v1/vocabulary/"


class FakeTask:
    """Stand-in for the registered task when testing the scheduler."""

    def __init__(self) -> None:
        self.enqueued: list[int] = []

    def delay(self, vocabulary_id: int) -> None:
        self.enqueued.append(vocabulary_id)


def flush_on_commit_callbacks() -> None:
    """Run (and drain) the current connection's pending on-commit hooks.

    Django 6 removed ``captureOnCommitCallbacks``; under pytest-django tests
    never commit, so hooks registered during a test are drained manually
    exactly like the removed helper did.
    """
    connection = connections[DEFAULT_DB_ALIAS]
    pending, connection.run_on_commit = connection.run_on_commit, []
    for entry in pending:
        entry[1]()


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def chat_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def item(user):
    return VocabularyItem.objects.create(
        user=user, expression="set off", normalized_expression="set off"
    )


@pytest.fixture
def fake_task(monkeypatch):
    fake = FakeTask()
    monkeypatch.setattr(vocab_tasks, "enrich_vocabulary_item", fake)
    return fake


# ---------------------------------------------------------------------------
# Registered task.
# ---------------------------------------------------------------------------


class EnrichVocabularyItemConfiguration(SimpleTestCase):
    def test_name_is_stable(self) -> None:
        assert enrich_vocabulary_item.name == "vocabulary.enrich_vocabulary_item"


@pytest.mark.django_db
class TestEnrichVocabularyItemBody:
    def test_placeholder_body_is_a_graceful_no_op(self, item):
        result = enrich_vocabulary_item.apply(args=[item.pk])

        assert result.state == "SUCCESS"
        assert result.result is False
        item.refresh_from_db()
        assert item.is_pending


# ---------------------------------------------------------------------------
# Scheduler semantics: enqueue exactly once, only after commit.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestScheduleVocabularyEnrichment:
    def test_enqueues_exactly_once_after_commit(self, item, fake_task):
        schedule_vocabulary_enrichment(item.pk)
        assert fake_task.enqueued == []

        flush_on_commit_callbacks()

        assert fake_task.enqueued == [item.pk]

        flush_on_commit_callbacks()
        assert fake_task.enqueued == [item.pk]

    def test_each_scheduling_registers_its_own_hook(self, item, fake_task):
        other = VocabularyItem.objects.create(
            user=item.user, expression="wanderlust", normalized_expression="wanderlust"
        )
        schedule_vocabulary_enrichment(item.pk)
        schedule_vocabulary_enrichment(other.pk)

        flush_on_commit_callbacks()

        assert sorted(fake_task.enqueued) == sorted([item.pk, other.pk])

    def test_rolled_back_transaction_never_enqueues(self, item, fake_task):
        with transaction.atomic():
            schedule_vocabulary_enrichment(item.pk)
            transaction.set_rollback(True)

        flush_on_commit_callbacks()

        assert fake_task.enqueued == []


# ---------------------------------------------------------------------------
# Save-path wiring.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSavePathScheduling:
    def test_successful_save_enqueues_exactly_one_task_after_commit(self, chat_api, fake_task):
        response = chat_api.post(SAVE_URL, {"expression": "Serendipity"}, format="json")

        assert response.status_code == 201
        assert fake_task.enqueued == []

        flush_on_commit_callbacks()

        assert fake_task.enqueued == [response.data["id"]]

    def test_duplicate_save_schedules_no_new_enrichment(self, chat_api, fake_task):
        first = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        second = chat_api.post(SAVE_URL, {"expression": "  SET OFF  "}, format="json")

        assert first.status_code == 201
        assert second.status_code == 200
        assert second.data["id"] == first.data["id"]

        flush_on_commit_callbacks()

        assert fake_task.enqueued == [first.data["id"]]

    def test_rejected_and_failed_requests_schedule_nothing(self, chat_api, fake_task, db):
        blank = chat_api.post(SAVE_URL, {"expression": ""}, format="json")
        missing_source = chat_api.post(
            SAVE_URL, {"expression": "set off", "source_message_id": 99999}, format="json"
        )

        assert blank.status_code == 400
        assert missing_source.status_code == 404

        flush_on_commit_callbacks()

        assert fake_task.enqueued == []

    def test_anonymous_requests_schedule_nothing(self, api, fake_task):
        response = api.post(SAVE_URL, {"expression": "set off"}, format="json")

        assert response.status_code == 401

        flush_on_commit_callbacks()

        assert fake_task.enqueued == []
