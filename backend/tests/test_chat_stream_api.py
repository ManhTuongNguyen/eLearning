"""Tests for the streaming chat endpoint (conversations.MessageStreamView, TASK-041).

Covers authenticated-only access, ownership 404s without existence leaks,
body validation before any write, the SSE frame protocol with incrementally
delivered chunks, persistence of the final assistant message onto the pending
row (complete or failed/retryable), and log hygiene (message text never
logged).
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
from conversations.chat import UserMessageService
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

SECRET_TEXT = "SECRET-TURN-TEXT-MARKER"
STREAMED_TEXT = "STREAMED-ASSISTANT-MARKER"
SERVED_MODEL = "served/chat"


def stream_url(pk) -> str:
    return reverse("conversations:session-message-stream", kwargs={"pk": pk})


LITERAL_URL = "/api/v1/sessions/not-an-int/messages/stream/"


def body(text: str = SECRET_TEXT) -> dict:
    return {"text": text}


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
        raise AssertionError("Chat stream tests never call complete()")

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


# ---------------------------------------------------------------------------
# Authentication and methods.
# ---------------------------------------------------------------------------


class TestAuthenticationAndMethods:
    def test_anonymous_post_is_rejected_without_writes(self, api, session):
        response = api.post(stream_url(session.pk), body(), format="json")

        assert response.status_code == 401
        assert Message.objects.count() == 0

    @pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
    def test_other_methods_are_not_allowed(self, chat_api, session, method):
        response = getattr(chat_api, method)(stream_url(session.pk))

        assert response.status_code == 405
        assert Message.objects.count() == 0


# ---------------------------------------------------------------------------
# Ownership and routing (no existence leak, nothing written).
# ---------------------------------------------------------------------------


class TestOwnership:
    def test_strangers_session_is_an_indistinguishable_404(
        self, chat_api, install_provider, session, stranger_session
    ):
        provider = install_provider(())

        response = chat_api.post(stream_url(stranger_session.pk), body(), format="json")

        assert response.status_code == 404
        assert "detail" in response.data
        assert provider.stream_requests == []
        assert Message.objects.count() == 0

    def test_missing_session_is_404(self, chat_api, install_provider, session):
        provider = install_provider(())

        response = chat_api.post(stream_url(99999), body(), format="json")

        assert response.status_code == 404
        assert provider.stream_requests == []
        assert Message.objects.count() == 0

    def test_non_int_pk_never_matches_the_route(self, chat_api, session):
        response = chat_api.post(LITERAL_URL, body(), format="json")

        assert response.status_code == 404
        assert Message.objects.count() == 0


# ---------------------------------------------------------------------------
# Body validation (rejected before any write or provider call).
# ---------------------------------------------------------------------------


class TestBodyValidation:
    @pytest.mark.parametrize("payload", [{}, {"text": ""}, {"text": "   \n\t "}])
    def test_invalid_text_is_rejected_without_writes(
        self, chat_api, install_provider, session, payload
    ):
        provider = install_provider(())

        response = chat_api.post(stream_url(session.pk), payload, format="json")

        assert response.status_code == 400
        assert "text" in response.json()
        assert provider.stream_requests == []
        assert Message.objects.count() == 0

    def test_numeric_text_is_coerced_like_charfields_do(self, chat_api, install_provider, session):
        install_provider((StreamStart(model=SERVED_MODEL),))

        response = chat_api.post(stream_url(session.pk), {"text": 42}, format="json")

        assert response.status_code == 200
        assert read_frames(response)[-1][0] == "completed"
        user_row = Message.objects.get(session=session, sequence=1)
        assert user_row.content == "42"

    def test_unknown_payload_fields_are_ignored(self, chat_api, install_provider, session):
        install_provider((StreamStart(model=SERVED_MODEL),))
        payload = {
            "text": SECRET_TEXT,
            "role": "system",
            "status": "failed",
            "model": "attacker/tiny-model",
        }

        response = chat_api.post(stream_url(session.pk), payload, format="json")

        assert response.status_code == 200
        read_frames(response)
        user_row = Message.objects.get(session=session, sequence=1)
        assert user_row.role == Message.Role.USER
        assert user_row.status == Message.Status.COMPLETE


# ---------------------------------------------------------------------------
# Successful streams.
# ---------------------------------------------------------------------------


class TestSuccessStream:
    SUCCESS_SCRIPT = (
        StreamStart(model=SERVED_MODEL),
        StreamDelta(text="Hello"),
        StreamDelta(text=", world"),
    )

    def test_frame_protocol_matches_the_documented_shapes(
        self, chat_api, install_provider, session
    ):
        provider = install_provider(self.SUCCESS_SCRIPT)

        response = chat_api.post(stream_url(session.pk), body(), format="json")

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
        assert [m.role for m in forwarded.messages] == ["system", "user"]
        assert forwarded.messages[-1].content == SECRET_TEXT

    def test_both_rows_are_persisted_with_consecutive_sequences(
        self, chat_api, install_provider, session
    ):
        install_provider(self.SUCCESS_SCRIPT)

        response = chat_api.post(stream_url(session.pk), body(), format="json")
        read_frames(response)

        user_row = Message.objects.get(session=session, sequence=1)
        assistant_row = Message.objects.get(session=session, sequence=2)
        assert user_row.role == Message.Role.USER
        assert user_row.status == Message.Status.COMPLETE
        assert user_row.content == SECRET_TEXT
        assert assistant_row.role == Message.Role.ASSISTANT
        assert assistant_row.status == Message.Status.COMPLETE
        assert assistant_row.content == "Hello, world"
        assert not assistant_row.is_retryable

    def test_text_arrives_incrementally(self, chat_api, install_provider, session):
        start = StreamStart(model=SERVED_MODEL)
        delta_one = StreamDelta(text="one")
        delta_two = StreamDelta(text="two")
        provider = install_provider((start, delta_one, delta_two))

        response = chat_api.post(stream_url(session.pk), body(), format="json")
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
        with pytest.raises(StopIteration):
            next(frames)

    def test_persistence_happens_before_the_terminal_frame(
        self, chat_api, install_provider, session
    ):
        install_provider(self.SUCCESS_SCRIPT)

        response = chat_api.post(stream_url(session.pk), body(), format="json")
        iterator = response.streaming_content
        names = []
        for chunk in iterator:
            names.append(parse_frame(chunk)[0])
            if names[-1] == "completed":
                # The client just observed `completed`; the row must already
                # carry the full message.
                assistant_row = Message.objects.get(session=session, sequence=2)
                assert assistant_row.status == Message.Status.COMPLETE
                assert assistant_row.content == "Hello, world"

        assert names[-1] == "completed"

    def test_zero_delta_completion_persists_an_empty_complete_row(
        self, chat_api, install_provider, session
    ):
        install_provider((StreamStart(model=SERVED_MODEL),))

        response = chat_api.post(stream_url(session.pk), body(), format="json")

        frames = read_frames(response)
        assert frames[-1] == ("completed", {"text": "", "model": SERVED_MODEL, "delta_count": 0})
        assistant_row = Message.objects.get(session=session, sequence=2)
        assert assistant_row.status == Message.Status.COMPLETE
        assert assistant_row.content == ""

    def test_response_speaks_sse(self, chat_api, install_provider, session):
        install_provider(self.SUCCESS_SCRIPT)

        response = chat_api.post(stream_url(session.pk), body(), format="json")

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        assert response.headers["Cache-Control"] == "no-cache"
        assert response.headers["X-Accel-Buffering"] == "no"

    def test_summary_update_is_scheduled_exactly_once_after_commit(
        self, chat_api, install_provider, session, summary_schedule
    ):
        install_provider(self.SUCCESS_SCRIPT)

        response = chat_api.post(stream_url(session.pk), body(), format="json")
        read_frames(response)

        assert summary_schedule == []
        callbacks = drain_on_commit_callbacks()
        assert len(callbacks) == 1
        for callback in callbacks:
            callback()
        assert summary_schedule == [session.pk]


# ---------------------------------------------------------------------------
# Failed streams (clear error representation, retryable generation state).
# ---------------------------------------------------------------------------


class TestFailedStream:
    def test_pre_stream_failure_emits_one_error_frame_and_marks_the_row_failed(
        self, chat_api, install_provider, session
    ):
        error = LLMAuthenticationError("bad key")
        install_provider(error)

        response = chat_api.post(stream_url(session.pk), body(), format="json")

        frames = read_frames(response)
        assert frames == [("error", {"error": str(error), "retryable": False})]
        user_row = Message.objects.get(session=session, sequence=1)
        assistant_row = Message.objects.get(session=session, sequence=2)
        assert user_row.status == Message.Status.COMPLETE
        assert user_row.content == SECRET_TEXT
        assert assistant_row.status == Message.Status.FAILED
        assert assistant_row.content == ""
        assert assistant_row.is_retryable

    def test_mid_stream_failure_delivers_deltas_then_the_error_frame(
        self, chat_api, install_provider, session
    ):
        error = LLMAvailabilityError("upstream collapsed")
        prefix = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="Par"),
            StreamDelta(text="tial"),
        )
        install_provider(MidStreamFailure(prefix=prefix, error=error))

        response = chat_api.post(stream_url(session.pk), body(), format="json")

        iterator = response.streaming_content
        frames = []
        with pytest.raises(StopIteration):
            while True:
                frames.append(parse_frame(next(iterator)))

        assert [name for name, _ in frames[:3]] == ["start", "delta", "delta"]
        (name, data) = frames[-1]
        assert name == "error"
        assert data == {"error": str(error), "retryable": True}
        assert set(data) == {"error", "retryable"}
        assistant_row = Message.objects.get(session=session, sequence=2)
        assert assistant_row.status == Message.Status.FAILED
        assert assistant_row.is_retryable

    def test_partial_output_is_never_persisted_as_a_complete_message(
        self, chat_api, install_provider, session
    ):
        error = LLMAvailabilityError("upstream collapsed")
        prefix = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text=STREAMED_TEXT),
        )
        install_provider(MidStreamFailure(prefix=prefix, error=error))

        response = chat_api.post(stream_url(session.pk), body(), format="json")
        read_frames(response)

        assistant_row = Message.objects.get(session=session, sequence=2)
        assert STREAMED_TEXT not in assistant_row.content
        rows = list(Message.objects.filter(session=session).order_by("sequence"))
        assert [(row.sequence, row.role, row.status) for row in rows] == [
            (1, Message.Role.USER, Message.Status.COMPLETE),
            (2, Message.Role.ASSISTANT, Message.Status.FAILED),
        ]


# ---------------------------------------------------------------------------
# Wiring and log hygiene.
# ---------------------------------------------------------------------------


class TestWiring:
    def test_user_message_service_seam_is_cached(self):
        from conversations.views import get_user_message_service

        assert isinstance(get_user_message_service(), UserMessageService)
        assert get_user_message_service() is get_user_message_service()


class TestLogHygiene:
    def test_no_message_text_is_logged_on_success_or_failure(
        self, chat_api, install_provider, session, caplog
    ):
        with caplog.at_level(logging.INFO):
            install_provider(
                (
                    StreamStart(model=SERVED_MODEL),
                    StreamDelta(text=STREAMED_TEXT),
                )
            )
            read_frames(chat_api.post(stream_url(session.pk), body(), format="json"))

            install_provider(LLMAvailabilityError("upstream collapsed"))
            read_frames(chat_api.post(stream_url(session.pk), body(), format="json"))

        assert SECRET_TEXT not in caplog.text
        assert STREAMED_TEXT not in caplog.text
