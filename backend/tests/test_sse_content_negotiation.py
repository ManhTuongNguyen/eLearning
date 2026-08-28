"""Regression tests for SSE content negotiation (TASK-AUDIT-001).

The chat streaming endpoint returned HTTP 406 whenever the mobile client sent
``Accept: text/event-stream``: DRF negotiates in ``APIView.initial()`` before
authentication, and no registered renderer declared the SSE media type. These
tests pin the fixed behavior across every SSE endpoint:

- ``Accept: text/event-stream`` streams normally (no 406) with the documented
  frame protocol, delivered incrementally.
- Pre-stream rejections (auth/validation/ownership) stay plain DRF JSON, not
  SSE — the client parses error bodies as JSON (chatStream.ts).
- Provider failures still terminate the stream with a single clean error
  frame.
- Unrelated invalid media types (``application/xml``) still negotiate to 406 —
  the fix is not a bypass for arbitrary Accept headers.
"""

import json

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

import llm.views
from conversations.models import Message, Session
from llm.exceptions import LLMAuthenticationError
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

SECRET_TEXT = "SECRET-NEGOTIATION-TEXT-MARKER"
SERVED_MODEL = "served/negotiation"
SSE_ACCEPT = "text/event-stream"


def stream_url(pk) -> str:
    return reverse("conversations:session-message-stream", kwargs={"pk": pk})


def retry_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-retry",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


LLM_STREAM_URL = reverse("llm:stream")


class ScriptedProvider(LLMProvider):
    """Fake provider yielding one scripted outcome and recording progress."""

    def __init__(self, *, script: object = ()) -> None:
        self.script = script
        self.stream_requests: list[CompletionRequest] = []
        self.produced: list[StreamEvent] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        raise AssertionError("Negotiation tests never call complete()")

    def stream(self, request: CompletionRequest):
        self.stream_requests.append(request)
        if isinstance(self.script, Exception):
            raise self.script
        for event in self.script:
            self.produced.append(event)
            yield event


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="cara", email="cara@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="oscar", email="oscar@example.com", password="pw-123456"
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
def authed_api(api, user):
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


def parse_frame(raw: bytes) -> tuple[str, dict]:
    lines = [line for line in raw.decode("utf-8").split("\n") if line != ""]
    assert len(lines) == 2, f"frame must be one event line + one data line: {raw!r}"
    event_line, data_line = lines
    assert event_line.startswith("event: "), raw
    assert data_line.startswith("data: "), raw
    return event_line.removeprefix("event: "), json.loads(data_line.removeprefix("data: "))


def read_frames(response) -> list[tuple[str, dict]]:
    return [parse_frame(chunk) for chunk in response.streaming_content]


class TestChatStreamNegotiation:
    """POST /api/v1/sessions/{id}/messages/stream/ with Accept: text/event-stream."""

    def test_sse_accept_streams_instead_of_406(self, authed_api, install_provider, session):
        install_provider(
            (
                StreamStart(model=SERVED_MODEL),
                StreamDelta(text="Hello"),
                StreamDelta(text=", world"),
            )
        )

        response = authed_api.post(
            stream_url(session.pk),
            {"text": SECRET_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        frames = read_frames(response)
        assert frames == [
            ("start", {"model": SERVED_MODEL}),
            ("delta", {"text": "Hello"}),
            ("delta", {"text": ", world"}),
            (
                "completed",
                {"text": "Hello, world", "model": SERVED_MODEL, "delta_count": 2},
            ),
        ]

    def test_sse_accept_delivers_chunks_incrementally(self, authed_api, install_provider, session):
        start = StreamStart(model=SERVED_MODEL)
        delta = StreamDelta(text="one")
        provider = install_provider((start, delta))

        response = authed_api.post(
            stream_url(session.pk), {"text": SECRET_TEXT}, format="json", HTTP_ACCEPT=SSE_ACCEPT
        )
        frames = response.streaming_content

        assert parse_frame(next(frames)) == ("start", {"model": SERVED_MODEL})
        assert provider.produced == [start]
        assert parse_frame(next(frames)) == ("delta", {"text": "one"})
        assert provider.produced == [start, delta]

    def test_sse_accept_provider_failure_emits_clean_error_frame(
        self, authed_api, install_provider, session
    ):
        error = LLMAuthenticationError("bad key")
        install_provider(error)

        response = authed_api.post(
            stream_url(session.pk), {"text": SECRET_TEXT}, format="json", HTTP_ACCEPT=SSE_ACCEPT
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        assert read_frames(response) == [("error", {"error": str(error), "retryable": False})]

    def test_sse_accept_anonymous_is_401_json_not_406(self, api, session):
        response = api.post(
            stream_url(session.pk),
            {"text": SECRET_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 401
        assert response.headers["Content-Type"].startswith("application/json")
        assert "detail" in response.json()

    def test_sse_accept_validation_error_is_400_json(self, authed_api, install_provider, session):
        install_provider(())

        response = authed_api.post(
            stream_url(session.pk), {"text": "   "}, format="json", HTTP_ACCEPT=SSE_ACCEPT
        )

        assert response.status_code == 400
        assert response.headers["Content-Type"].startswith("application/json")
        assert "text" in response.json()
        assert Message.objects.count() == 0

    def test_sse_accept_foreign_session_is_404_json(
        self, authed_api, install_provider, session, stranger_session
    ):
        install_provider(())

        response = authed_api.post(
            stream_url(stranger_session.pk),
            {"text": SECRET_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 404
        assert response.headers["Content-Type"].startswith("application/json")
        assert "detail" in response.json()
        assert Message.objects.count() == 0

    def test_unrelated_invalid_accept_is_still_406(self, authed_api, install_provider, session):
        install_provider(())

        response = authed_api.post(
            stream_url(session.pk),
            {"text": SECRET_TEXT},
            format="json",
            HTTP_ACCEPT="application/xml",
        )

        assert response.status_code == 406


class TestRetryStreamNegotiation:
    """POST .../messages/{pk}/retry/ with Accept: text/event-stream."""

    def test_sse_accept_streams_the_retry_instead_of_406(
        self, authed_api, install_provider, session
    ):
        user_row = Message.append(session, role=Message.Role.USER, content=SECRET_TEXT)
        failed_row = Message.append(
            session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED
        )
        install_provider(
            (
                StreamStart(model=SERVED_MODEL),
                StreamDelta(text="Fixed"),
            )
        )

        response = authed_api.post(retry_url(session.pk, failed_row.pk), HTTP_ACCEPT=SSE_ACCEPT)

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        frames = read_frames(response)
        assert frames[0] == ("start", {"model": SERVED_MODEL})
        assert frames[-1] == (
            "completed",
            {"text": "Fixed", "model": SERVED_MODEL, "delta_count": 1},
        )
        failed_row.refresh_from_db()
        assert failed_row.status == Message.Status.COMPLETE
        assert failed_row.content == "Fixed"
        assert user_row.content == SECRET_TEXT

    def test_sse_accept_anonymous_retry_is_401_json_not_406(self, api, session):
        Message.append(session, role=Message.Role.USER, content=SECRET_TEXT)
        failed_row = Message.append(
            session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED
        )

        response = api.post(retry_url(session.pk, failed_row.pk), HTTP_ACCEPT=SSE_ACCEPT)

        assert response.status_code == 401
        assert response.headers["Content-Type"].startswith("application/json")
        assert "detail" in response.json()


class TestLLMStreamNegotiation:
    """POST /api/v1/llm/stream/ with Accept: text/event-stream."""

    def test_sse_accept_streams_instead_of_406(self, authed_api, install_provider):
        install_provider((StreamStart(model=SERVED_MODEL),))

        response = authed_api.post(
            LLM_STREAM_URL,
            {"messages": [{"role": "user", "content": "Hi"}]},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        frames = read_frames(response)
        assert frames[0] == ("start", {"model": SERVED_MODEL})
        assert frames[-1][0] == "completed"

    def test_sse_accept_anonymous_is_401_json_not_406(self, api):
        response = api.post(
            LLM_STREAM_URL,
            {"messages": [{"role": "user", "content": "Hi"}]},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 401
        assert response.headers["Content-Type"].startswith("application/json")
