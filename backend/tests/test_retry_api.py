"""Tests for the failed-generation retry endpoint (conversations.MessageRetryView, TASK-042).

Covers authenticated-only access, ownership 404s without existence leaks,
the MVP rule that ONLY failed assistant messages are retryable (successful,
pending, and user targets are 409 conflicts with zero writes), in-place
replacement of the failed row without duplicating the user message, the SSE
frame protocol shared with the stream endpoint, re-retry after another
failure, post-commit summary scheduling, and log hygiene.
"""

import json
import logging

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.urls import reverse
from rest_framework.test import APIClient

import conversations.chat as chat_module
import llm.views
from conversations.chat import RetryService
from conversations.models import Message, Session
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError
from llm.provider import LLMProvider
from llm.sse import CONTENT_TYPE
from llm.streaming import StreamingCompletionService
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    StreamDelta,
    StreamEvent,
    StreamStart,
)

pytestmark = pytest.mark.django_db

SECRET_TEXT = "SECRET-RETRY-USER-MARKER"
STREAMED_TEXT = "STREAMED-RETRY-ASSISTANT-MARKER"
PARTIAL_TEXT = "PARTIAL-OUTPUT-MARKER"
EARLIER_QUESTION = "EARLIER-QUESTION-MARKER"
EARLIER_ANSWER = "EARLIER-ANSWER-MARKER"
LATER_TEXT = "LATER-TURN-MARKER"
SERVED_MODEL = "served/chat"

SUCCESS_SCRIPT = (
    StreamStart(model=SERVED_MODEL),
    StreamDelta(text="Hello"),
    StreamDelta(text=", world"),
)


class MidStreamFailure:
    """Script emitting prefix events and then raising."""

    def __init__(self, prefix: tuple[StreamEvent, ...], error: Exception) -> None:
        self.prefix = prefix
        self.error = error


class ScriptedProvider(LLMProvider):
    """Fake provider yielding one scripted outcome and recording progress."""

    def __init__(self, *, script: object = ()) -> None:
        self.script = script
        self.stream_requests: list[CompletionRequest] = []
        self.produced: list[StreamEvent] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        raise AssertionError("Retry tests never call complete()")

    def stream(self, request: CompletionRequest):
        self.stream_requests.append(request)
        if isinstance(self.script, Exception):
            raise self.script
        if isinstance(self.script, MidStreamFailure):
            for event in self.script.prefix:
                self.produced.append(event)
                yield event
            raise self.script.error
        for event in self.script:
            self.produced.append(event)
            yield event


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
    return Session.objects.create(
        user=user, title="Traveling", topic="Planning a trip to Lisbon", learning_level="B2"
    )


@pytest.fixture
def stranger_session(stranger):
    return Session.objects.create(
        user=stranger, title="Secret", topic="Stranger topic", learning_level="A1"
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def summary_schedule(monkeypatch):
    """Neutralize Celery scheduling; record enqueued session ids."""
    calls: list[int] = []
    monkeypatch.setattr(
        chat_module, "schedule_session_summary_update", lambda sid: calls.append(sid)
    )
    return calls


@pytest.fixture
def chat_api(api, user, summary_schedule):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def install_provider(monkeypatch):
    """Patch the streaming-service seam; hand back the scripted provider."""

    def install(script: object) -> ScriptedProvider:
        provider = ScriptedProvider(script=script)
        monkeypatch.setattr(
            llm.views,
            "get_streaming_service",
            lambda: StreamingCompletionService(provider=provider),
        )
        return provider

    return install


def retry_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-retry",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


def drain_on_commit_callbacks():
    """Run and clear pending transaction.on_commit callbacks."""
    callbacks, connection.run_on_commit = connection.run_on_commit, []
    return [func for _sids, func, _robust in callbacks]


def parse_frame(raw: bytes) -> tuple[str, dict]:
    lines = [line for line in raw.decode("utf-8").split("\n") if line != ""]
    assert len(lines) == 2, f"frame must be one event line + one data line: {raw!r}"
    event_line, data_line = lines
    assert event_line.startswith("event: "), raw
    assert data_line.startswith("data: "), raw
    return event_line.removeprefix("event: "), json.loads(data_line.removeprefix("data: "))


def read_frames(response) -> list[tuple[str, dict]]:
    return [parse_frame(chunk) for chunk in response.streaming_content]


def append_completed_turn(session, *, question, answer):
    question_row = Message.append(session, role=Message.Role.USER, content=question)
    answer_row = Message.append(
        session,
        role=Message.Role.ASSISTANT,
        content=answer,
        status=Message.Status.COMPLETE,
    )
    return question_row, answer_row


def append_failed_turn(session, *, user_text=SECRET_TEXT):
    user_row = Message.append(session, role=Message.Role.USER, content=user_text)
    failed_row = Message.append(session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED)
    return user_row, failed_row


# ---------------------------------------------------------------------------
# Authentication and methods.
# ---------------------------------------------------------------------------


class TestAuthenticationAndMethods:
    def test_anonymous_post_is_rejected_without_changes(self, api, session):
        user_row, failed_row = append_failed_turn(session)

        response = api.post(retry_url(session.pk, failed_row.pk))

        assert response.status_code == 401
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.FAILED
        assert failed_row.content == ""
        assert user_row.content == SECRET_TEXT
        assert Message.objects.count() == 2

    @pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
    def test_other_methods_are_not_allowed(self, chat_api, session, method):
        _user_row, failed_row = append_failed_turn(session)

        response = getattr(chat_api, method)(retry_url(session.pk, failed_row.pk))

        assert response.status_code == 405
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.FAILED


# ---------------------------------------------------------------------------
# Ownership and routing (no existence leak, nothing changed).
# ---------------------------------------------------------------------------


class TestOwnership:
    def test_strangers_session_is_an_indistinguishable_404(
        self, chat_api, install_provider, session, stranger_session
    ):
        provider = install_provider(())
        _rows, (_stranger_user, stranger_failed) = (
            append_failed_turn(session),
            append_failed_turn(stranger_session),
        )

        response = chat_api.post(retry_url(stranger_session.pk, stranger_failed.pk))

        assert response.status_code == 404
        assert "detail" in response.data
        assert provider.stream_requests == []
        assert Message.objects.count() == 4

    def test_missing_session_is_404(self, chat_api, install_provider, session):
        provider = install_provider(())
        _user_row, failed_row = append_failed_turn(session)

        response = chat_api.post(retry_url(99999, failed_row.pk))

        assert response.status_code == 404
        assert provider.stream_requests == []

    def test_foreign_message_inside_own_session_is_an_indistinguishable_404(
        self, chat_api, install_provider, session, stranger_session
    ):
        provider = install_provider(())
        _my_user, my_failed = append_failed_turn(session)
        _foreign_user, foreign_failed = append_failed_turn(stranger_session)

        response = chat_api.post(retry_url(session.pk, foreign_failed.pk))

        assert response.status_code == 404
        assert provider.stream_requests == []
        my_failed.refresh_from_db()
        assert my_failed.status == Message.Status.FAILED

    def test_missing_message_is_404(self, chat_api, install_provider, session):
        provider = install_provider(())
        append_failed_turn(session)

        response = chat_api.post(retry_url(session.pk, 99999))

        assert response.status_code == 404
        assert provider.stream_requests == []

    def test_non_int_session_pk_never_matches_the_route(self, chat_api, session):
        _user_row, failed_row = append_failed_turn(session)

        response = chat_api.post(f"/api/v1/sessions/not-an-int/messages/{failed_row.pk}/retry/")

        assert response.status_code == 404
        assert Message.objects.count() == 2

    def test_non_int_message_pk_never_matches_the_route(self, chat_api, session):
        append_failed_turn(session)

        response = chat_api.post(f"/api/v1/sessions/{session.pk}/messages/not-an-int/retry/")

        assert response.status_code == 404
        assert Message.objects.count() == 2


# ---------------------------------------------------------------------------
# MVP retry rule: only failed assistant messages are retryable (409 conflicts).
# ---------------------------------------------------------------------------


class TestOnlyFailedAssistantMessagesAreRetryable:
    def test_successful_assistant_message_cannot_be_retried(
        self, chat_api, install_provider, session
    ):
        provider = install_provider(())
        _question, answer = append_completed_turn(
            session, question=SECRET_TEXT, answer=STREAMED_TEXT
        )

        response = chat_api.post(retry_url(session.pk, answer.pk))

        assert response.status_code == 409
        assert response.data["detail"] == "Only failed assistant messages can be retried."
        assert provider.stream_requests == []
        answer.refresh_from_db()
        assert answer.status == Message.Status.COMPLETE
        assert answer.content == STREAMED_TEXT

    def test_pending_assistant_message_cannot_be_retried(self, chat_api, install_provider, session):
        provider = install_provider(())
        user_row = Message.append(session, role=Message.Role.USER, content=SECRET_TEXT)
        pending_row = Message.append(session, role=Message.Role.ASSISTANT)

        response = chat_api.post(retry_url(session.pk, pending_row.pk))

        assert response.status_code == 409
        assert provider.stream_requests == []
        pending_row.refresh_from_db()
        assert pending_row.status == Message.Status.PENDING
        user_row.refresh_from_db()
        assert user_row.content == SECRET_TEXT

    def test_user_message_target_cannot_be_retried(self, chat_api, install_provider, session):
        provider = install_provider(())
        user_row, failed_row = append_failed_turn(session)

        response = chat_api.post(retry_url(session.pk, user_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == "Only failed assistant messages can be retried."
        assert provider.stream_requests == []
        user_row.refresh_from_db()
        assert user_row.role == Message.Role.USER
        assert user_row.content == SECRET_TEXT
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.FAILED

    def test_orphaned_failed_row_without_a_user_prompt_is_rejected(
        self, chat_api, install_provider, session
    ):
        provider = install_provider(())
        orphan = Message.append(session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED)

        response = chat_api.post(retry_url(session.pk, orphan.pk))

        assert response.status_code == 409
        assert "no user message" in response.data["detail"]
        assert provider.stream_requests == []
        orphan.refresh_from_db()
        assert orphan.status == Message.Status.FAILED


# ---------------------------------------------------------------------------
# Successful retries (SSE protocol, in-place replacement, context shape).
# ---------------------------------------------------------------------------


class TestSuccessfulRetry:
    def test_frame_protocol_matches_the_documented_shapes(
        self, chat_api, install_provider, session
    ):
        append_completed_turn(session, question=EARLIER_QUESTION, answer=EARLIER_ANSWER)
        _user_row, failed_row = append_failed_turn(session)
        provider = install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))

        assert response.status_code == 200
        frames = read_frames(response)
        assert frames[0] == ("start", {"model": SERVED_MODEL})
        assert frames[1] == ("delta", {"text": "Hello"})
        assert frames[2] == ("delta", {"text": ", world"})
        assert frames[-1] == (
            "completed",
            {"text": "Hello, world", "model": SERVED_MODEL, "delta_count": 2},
        )
        (forwarded,) = provider.stream_requests
        assert forwarded.model is None
        assert forwarded.temperature is None
        assert [m.role for m in forwarded.messages] == ["system", "user", "assistant", "user"]
        assert forwarded.messages[1].content == EARLIER_QUESTION
        assert forwarded.messages[2].content == EARLIER_ANSWER
        assert forwarded.messages[-1].content == SECRET_TEXT

    def test_failed_row_is_replaced_in_place_without_duplicating_the_user_message(
        self, chat_api, install_provider, session
    ):
        user_row, failed_row = append_failed_turn(session)
        install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        read_frames(response)

        assert Message.objects.count() == 2
        user_row.refresh_from_db()
        assert user_row.sequence == 1
        assert user_row.role == Message.Role.USER
        assert user_row.status == Message.Status.COMPLETE
        assert user_row.content == SECRET_TEXT
        failed_row.refresh_from_db()
        assert failed_row.pk == failed_row.pk
        assert failed_row.sequence == 2
        assert failed_row.role == Message.Role.ASSISTANT
        assert failed_row.status == Message.Status.COMPLETE
        assert failed_row.content == "Hello, world"
        assert not failed_row.is_retryable

    def test_text_arrives_incrementally(self, chat_api, install_provider, session):
        _user_row, failed_row = append_failed_turn(session)
        start = StreamStart(model=SERVED_MODEL)
        delta_one = StreamDelta(text="one")
        delta_two = StreamDelta(text="two")
        provider = install_provider((start, delta_one, delta_two))

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        frames = response.streaming_content

        assert parse_frame(next(frames)) == ("start", {"model": SERVED_MODEL})
        assert provider.produced == [start]
        assert parse_frame(next(frames)) == ("delta", {"text": "one"})
        assert provider.produced == [start, delta_one]
        assert parse_frame(next(frames)) == ("delta", {"text": "two"})
        assert provider.produced == [start, delta_one, delta_two]
        terminal = parse_frame(next(frames))
        assert terminal == (
            "completed",
            {"text": "onetwo", "model": SERVED_MODEL, "delta_count": 2},
        )

    def test_persistence_happens_before_the_terminal_frame(
        self, chat_api, install_provider, session
    ):
        _user_row, failed_row = append_failed_turn(session)
        install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        iterator = response.streaming_content
        names = []
        for chunk in iterator:
            names.append(parse_frame(chunk)[0])
            if names[-1] == "completed":
                retried = Message.objects.get(pk=failed_row.pk)
                assert retried.status == Message.Status.COMPLETE
                assert retried.content == "Hello, world"

        assert names[-1] == "completed"

    def test_zero_delta_completion_persists_an_empty_complete_row(
        self, chat_api, install_provider, session
    ):
        _user_row, failed_row = append_failed_turn(session)
        install_provider((StreamStart(model=SERVED_MODEL),))

        response = chat_api.post(retry_url(session.pk, failed_row.pk))

        frames = read_frames(response)
        assert frames[-1] == ("completed", {"text": "", "model": SERVED_MODEL, "delta_count": 0})
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.COMPLETE
        assert failed_row.content == ""

    def test_response_speaks_sse(self, chat_api, install_provider, session):
        _user_row, failed_row = append_failed_turn(session)
        install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        assert response.headers["Cache-Control"] == "no-cache"
        assert response.headers["X-Accel-Buffering"] == "no"

    def test_history_stops_at_the_retried_turn_and_later_rows_are_untouched(
        self, chat_api, install_provider, session
    ):
        append_completed_turn(session, question=EARLIER_QUESTION, answer=EARLIER_ANSWER)
        _user_row, failed_row = append_failed_turn(session)
        later_question, later_answer = append_completed_turn(
            session, question=LATER_TEXT, answer=LATER_TEXT + "-answer"
        )
        provider = install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        read_frames(response)

        (forwarded,) = provider.stream_requests
        rendered = [m.content for m in forwarded.messages]
        assert EARLIER_QUESTION in rendered
        assert LATER_TEXT not in "".join(rendered)
        failed_row.refresh_from_db()
        assert failed_row.sequence == 4
        assert failed_row.status == Message.Status.COMPLETE
        assert failed_row.content == "Hello, world"
        later_question.refresh_from_db()
        later_answer.refresh_from_db()
        assert later_question.status == Message.Status.COMPLETE
        assert later_answer.content == LATER_TEXT + "-answer"


# ---------------------------------------------------------------------------
# Failed retries (clear error representation, row stays retryable).
# ---------------------------------------------------------------------------


class TestFailedRetry:
    def test_pre_stream_failure_emits_one_error_frame_and_marks_the_row_failed_again(
        self, chat_api, install_provider, session
    ):
        error = LLMAuthenticationError("bad key")
        user_row, failed_row = append_failed_turn(session)
        install_provider(error)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))

        frames = read_frames(response)
        assert frames == [("error", {"error": str(error), "retryable": False})]
        user_row.refresh_from_db()
        assert user_row.status == Message.Status.COMPLETE
        assert user_row.content == SECRET_TEXT
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.FAILED
        assert failed_row.content == ""
        assert failed_row.is_retryable

    def test_mid_stream_failure_delivers_deltas_then_the_error_frame(
        self, chat_api, install_provider, session
    ):
        error = LLMAvailabilityError("upstream collapsed")
        prefix = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="Par"),
            StreamDelta(text="tial"),
        )
        _user_row, failed_row = append_failed_turn(session)
        install_provider(MidStreamFailure(prefix=prefix, error=error))

        response = chat_api.post(retry_url(session.pk, failed_row.pk))

        iterator = response.streaming_content
        frames = []
        with pytest.raises(StopIteration):
            while True:
                frames.append(parse_frame(next(iterator)))

        assert [name for name, _ in frames[:3]] == ["start", "delta", "delta"]
        (name, data) = frames[-1]
        assert name == "error"
        assert data == {"error": str(error), "retryable": True}
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.FAILED
        assert failed_row.is_retryable

    def test_partial_output_is_never_persisted_as_a_complete_message(
        self, chat_api, install_provider, session
    ):
        error = LLMAvailabilityError("upstream collapsed")
        prefix = (StreamStart(model=SERVED_MODEL), StreamDelta(text=PARTIAL_TEXT))
        _user_row, failed_row = append_failed_turn(session)
        install_provider(MidStreamFailure(prefix=prefix, error=error))

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        read_frames(response)

        failed_row.refresh_from_db()
        assert PARTIAL_TEXT not in failed_row.content
        rows = list(Message.objects.filter(session=session).order_by("sequence"))
        assert [(row.sequence, row.role, row.status) for row in rows] == [
            (1, Message.Role.USER, Message.Status.COMPLETE),
            (2, Message.Role.ASSISTANT, Message.Status.FAILED),
        ]

    def test_a_row_that_failed_again_can_be_retried_until_it_succeeds(
        self, chat_api, install_provider, session
    ):
        _user_row, failed_row = append_failed_turn(session)
        first_failure = LLMAvailabilityError("still down")
        install_provider(first_failure)

        first_response = chat_api.post(retry_url(session.pk, failed_row.pk))
        assert read_frames(first_response)[-1][0] == "error"

        install_provider(SUCCESS_SCRIPT)
        second_response = chat_api.post(retry_url(session.pk, failed_row.pk))
        second_frames = read_frames(second_response)
        assert second_frames[-1][0] == "completed"
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.COMPLETE
        assert failed_row.content == "Hello, world"
        assert Message.objects.count() == 2


# ---------------------------------------------------------------------------
# Wiring and log hygiene.
# ---------------------------------------------------------------------------


class TestWiring:
    def test_retry_service_seam_is_cached(self):
        from conversations.views import get_retry_service

        assert isinstance(get_retry_service(), RetryService)
        assert get_retry_service() is get_retry_service()


class TestLogHygiene:
    def test_no_message_text_is_logged_on_success_or_failure(
        self, chat_api, install_provider, session, caplog
    ):
        _user_row, failed_row = append_failed_turn(session)
        with caplog.at_level(logging.INFO):
            install_provider(
                (
                    StreamStart(model=SERVED_MODEL),
                    StreamDelta(text=STREAMED_TEXT),
                )
            )
            read_frames(chat_api.post(retry_url(session.pk, failed_row.pk)))

            _second_user_row, second_failed_row = append_failed_turn(session)
            install_provider(LLMAvailabilityError("upstream collapsed"))
            read_frames(chat_api.post(retry_url(session.pk, second_failed_row.pk)))

        assert SECRET_TEXT not in caplog.text
        assert STREAMED_TEXT not in caplog.text


class TestSummarySchedule:
    def test_summary_update_is_scheduled_exactly_once_after_commit(
        self, chat_api, install_provider, session, summary_schedule
    ):
        _user_row, failed_row = append_failed_turn(session)
        install_provider(SUCCESS_SCRIPT)

        response = chat_api.post(retry_url(session.pk, failed_row.pk))
        read_frames(response)

        assert summary_schedule == []
        callbacks = drain_on_commit_callbacks()
        assert len(callbacks) == 1
        for callback in callbacks:
            callback()
        assert summary_schedule == [session.pk]
