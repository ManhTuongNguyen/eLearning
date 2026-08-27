"""Query-efficiency regression tests for chat generation (TASK-102).

Locks in the database-access contract of the chat generation flow:

- the query count of ``UserMessageService.create_turn`` and
  ``RetryService.prepare_retry`` does not grow with conversation length
  (no N+1),
- the recent-message history is bounded in SQL (``LIMIT``) for both the
  streaming turn and the suggestions endpoint — long conversations never
  transfer more rows than the configured window holds,
- persisting the terminal stream event stays a single ``UPDATE``,
- the performance indexes declared on ``Message`` and ``Session`` exist in
  the actual database schema.
"""

from __future__ import annotations

import json

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from rest_framework.test import APIClient

import conversations.views as views_module
from conversations.chat import RetryService, UserMessageService, finalize_turn
from conversations.models import Message, Session
from conversations.suggestions import SuggestionService
from llm.exceptions import LLMAvailabilityError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse, StreamCompleted, StreamFailed

pytestmark = pytest.mark.django_db

REPLIES = ["First suggestion.", "Second suggestion.", "Third suggestion."]


def seed_complete_messages(session, count: int, *, start_sequence: int = 1) -> None:
    """Insert ``count`` alternating complete turns with one bulk query.

    Sequences are assigned explicitly so seeding itself stays query-free and
    cannot pollute the measured query counts.
    """
    Message.objects.bulk_create(
        Message(
            session=session,
            role=Message.Role.USER if index % 2 == 0 else Message.Role.ASSISTANT,
            status=Message.Status.COMPLETE,
            content=f"turn {start_sequence + index}",
            sequence=start_sequence + index,
        )
        for index in range(count)
    )


class ScriptedProvider(LLMProvider):
    """Fake provider returning one scripted suggestion completion."""

    def __init__(self) -> None:
        self.requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.requests.append(request)
        return CompletionResponse(text=json.dumps({"replies": list(REPLIES)}), model="vendor/model")

    def stream(self, request: CompletionRequest):
        raise AssertionError("Suggestions never call stream()")


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


def measured_query_count(user, run, *, history_turns: int) -> int:
    """Build a session with ``history_turns`` seeded turns, run, count queries."""
    session = Session.objects.create(user=user, title="T", topic="D")
    seed_complete_messages(session, history_turns)
    with CaptureQueriesContext(connection) as context:
        run(session)
    return len(context.captured_queries)


# ---------------------------------------------------------------------------
# create_turn: no N+1.
# ---------------------------------------------------------------------------


class TestCreateTurnQueryCount:
    def test_query_count_is_constant_regardless_of_history_size(self, user):
        service = UserMessageService()

        def turn(session):
            service.create_turn(session_id=session.pk, user=user, text="new turn")

        short = measured_query_count(user, turn, history_turns=4)
        long = measured_query_count(user, turn, history_turns=40)

        assert short == long
        # session lock + 2x(sequence MAX + INSERT) + bounded history SELECT.
        assert short <= 10

    def test_history_fetch_is_bounded_in_sql(self, user, settings):
        settings.CONTEXT_RECENT_MESSAGE_WINDOW = 5
        session = Session.objects.create(user=user, title="T", topic="D")
        seed_complete_messages(session, 30)
        service = UserMessageService()

        with CaptureQueriesContext(connection) as context:
            prepared = service.create_turn(session_id=session.pk, user=user, text="new turn")

        select_queries = [
            query["sql"] for query in context.captured_queries if query["sql"].startswith("SELECT")
        ]
        bounded = [
            sql
            for sql in select_queries
            if "conversations_message" in sql and "LIMIT" in sql.upper()
        ]
        assert bounded, select_queries
        assert len(prepared.request.messages) == 7  # system + 5 windowed + current


# ---------------------------------------------------------------------------
# prepare_retry: no N+1.
# ---------------------------------------------------------------------------


class TestRetryQueryCount:
    def test_query_count_is_constant_regardless_of_history_size(self, user):
        service = RetryService()

        def retry(session):
            failed = Message.objects.create(
                session=session,
                role=Message.Role.ASSISTANT,
                status=Message.Status.FAILED,
                sequence=session.messages.count() + 1,
            )
            service.prepare_retry(session_id=session.pk, message_id=failed.pk, user=user)

        short = measured_query_count(user, retry, history_turns=4)
        long = measured_query_count(user, retry, history_turns=40)

        assert short == long
        # session lock + message lock + predecessor + reset UPDATE + bounded history.
        assert short <= 10


# ---------------------------------------------------------------------------
# finalize_turn: terminal persistence stays a single UPDATE.
# ---------------------------------------------------------------------------


def make_pending_assistant(session, sequence: int) -> Message:
    return Message.objects.create(
        session=session,
        role=Message.Role.ASSISTANT,
        status=Message.Status.PENDING,
        sequence=sequence,
    )


class TestFinalizeTurnPersistence:
    def test_completed_stream_persists_with_single_update(self, user):
        session = Session.objects.create(user=user, title="T", topic="D")
        pending = make_pending_assistant(session, sequence=1)

        with CaptureQueriesContext(connection) as context:
            list(finalize_turn(pending, iter([StreamCompleted(text="done", model="m")])))

        updates = [
            query["sql"] for query in context.captured_queries if query["sql"].startswith("UPDATE")
        ]
        assert len(updates) == 1
        pending.refresh_from_db()
        assert pending.content == "done"
        assert pending.status == Message.Status.COMPLETE

    def test_failed_stream_persists_with_single_update(self, user):
        session = Session.objects.create(user=user, title="T", topic="D")
        pending = make_pending_assistant(session, sequence=1)
        failure = StreamFailed(error=LLMAvailabilityError("provider down"))

        with CaptureQueriesContext(connection) as context:
            list(finalize_turn(pending, iter([failure])))

        updates = [
            query["sql"] for query in context.captured_queries if query["sql"].startswith("UPDATE")
        ]
        assert len(updates) == 1
        pending.refresh_from_db()
        assert pending.content == ""
        assert pending.status == Message.Status.FAILED


# ---------------------------------------------------------------------------
# Suggestions endpoint: history fetch bounded in SQL.
# ---------------------------------------------------------------------------


class TestSuggestionsSqlBound:
    def test_suggestions_fetch_only_window_in_sql(self, user, settings, monkeypatch):
        settings.CONTEXT_RECENT_MESSAGE_WINDOW = 5
        provider = ScriptedProvider()
        monkeypatch.setattr(
            views_module,
            "get_suggestion_service",
            lambda: SuggestionService(provider=provider),
        )
        session = Session.objects.create(user=user, title="T", topic="D")
        seed_complete_messages(session, 30)
        target = Message.objects.create(
            session=session,
            role=Message.Role.ASSISTANT,
            status=Message.Status.COMPLETE,
            content="Tell me about Lisbon.",
            sequence=31,
        )
        client = APIClient()
        client.force_authenticate(user=user)
        url = reverse(
            "conversations:session-message-suggestions",
            kwargs={"pk": session.pk, "message_pk": target.pk},
        )

        with CaptureQueriesContext(connection) as context:
            response = client.post(url)

        assert response.status_code == 200
        assert response.json() == {"replies": list(REPLIES)}
        select_queries = [
            query["sql"] for query in context.captured_queries if query["sql"].startswith("SELECT")
        ]
        bounded = [
            sql
            for sql in select_queries
            if "conversations_message" in sql and "LIMIT" in sql.upper()
        ]
        assert bounded, select_queries
        assert len(provider.requests) == 1


# ---------------------------------------------------------------------------
# Declared performance indexes exist in the schema.
# ---------------------------------------------------------------------------


class TestIndexesExist:
    def test_model_meta_declares_performance_indexes(self):
        message_fields = {tuple(index.fields) for index in Message._meta.indexes}
        assert ("session", "status", "sequence") in message_fields
        session_fields = {tuple(index.fields) for index in Session._meta.indexes}
        assert ("user", "-updated_at") in session_fields

    def test_message_history_index_exists_in_schema(self):
        with connection.cursor() as cursor:
            constraints = connection.introspection.get_constraints(cursor, Message._meta.db_table)
        matches = [
            definition
            for definition in constraints.values()
            if definition["index"]
            and not definition["unique"]
            and definition["columns"] == ["session_id", "status", "sequence"]
        ]
        assert matches

    def test_session_listing_index_exists_in_schema(self):
        with connection.cursor() as cursor:
            constraints = connection.introspection.get_constraints(cursor, Session._meta.db_table)
        matches = [
            definition
            for definition in constraints.values()
            if definition["index"]
            and not definition["unique"]
            and definition["columns"] == ["user_id", "updated_at"]
        ]
        assert matches
