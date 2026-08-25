"""Tests for the SSE endpoint foundation (TASK-025).

Covers authenticated-only access, request validation, transport headers,
lazy incremental delivery over HTTP, the success frame protocol ending in a
clean connection close, and the defined error-event format for failed
streams.
"""

import json

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

import llm.views
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

STREAM_URL = reverse("llm:stream")

SERVED_MODEL = "served/a"

BODY = {"messages": [{"role": "user", "content": "Hi"}]}


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
        raise AssertionError("SSE endpoint tests never call complete()")

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
def user():
    return get_user_model().objects.create_user(
        username="dave",
        email="dave@example.com",
        password="pw-123456",
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def install_service(monkeypatch):
    """Patch the streaming-service seam and hand back the scripted provider."""

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


class TestAuthentication:
    def test_anonymous_post_is_rejected(self, api):
        response = api.post(STREAM_URL, BODY, format="json")

        assert response.status_code == 401

    def test_get_is_not_allowed(self, authed_api):
        response = authed_api.get(STREAM_URL)

        assert response.status_code == 405


class TestValidation:
    def test_missing_messages_is_rejected(self, authed_api, install_service):
        provider = install_service(())

        response = authed_api.post(STREAM_URL, {}, format="json")

        assert response.status_code == 400
        assert "messages" in response.json()
        assert provider.stream_requests == []

    def test_empty_message_list_is_rejected(self, authed_api, install_service):
        provider = install_service(())

        response = authed_api.post(STREAM_URL, {"messages": []}, format="json")

        assert response.status_code == 400
        assert provider.stream_requests == []

    @pytest.mark.parametrize(
        "payload",
        [
            {"role": "robot", "content": "Hi"},
            {"role": "user"},
            {"role": "user", "content": ""},
            {"role": "user", "content": "   "},
            {"role": "user", "content": 42},
            {"content": "Hi"},
        ],
    )
    def test_invalid_message_items_are_rejected(self, authed_api, install_service, payload):
        provider = install_service(())

        response = authed_api.post(STREAM_URL, {"messages": [payload]}, format="json")

        assert response.status_code == 400
        assert provider.stream_requests == []

    @pytest.mark.parametrize("temperature", [-0.1, 2.1, "hot"])
    def test_invalid_temperature_is_rejected(self, authed_api, install_service, temperature):
        provider = install_service(())
        payload = {**BODY, "temperature": temperature}

        response = authed_api.post(STREAM_URL, payload, format="json")

        assert response.status_code == 400
        assert provider.stream_requests == []


class TestTransportHeaders:
    SUCCESS_SCRIPT = (
        StreamStart(model=SERVED_MODEL),
        StreamDelta(text="Hey"),
    )

    def test_success_response_speaks_sse(self, authed_api, install_service):
        install_service(self.SUCCESS_SCRIPT)

        response = authed_api.post(STREAM_URL, BODY, format="json")

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        assert response.headers["Cache-Control"] == "no-cache"
        assert response.headers["X-Accel-Buffering"] == "no"

    def test_failure_response_still_speaks_sse(self, authed_api, install_service):
        install_service(LLMAuthenticationError("bad key"))

        response = authed_api.post(STREAM_URL, BODY, format="json")

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE


class TestSuccessStream:
    def test_frame_sequence_matches_the_documented_protocol(self, authed_api, install_service):
        install_service(
            (
                StreamStart(model=SERVED_MODEL),
                StreamDelta(text="Hello"),
                StreamDelta(text=", world"),
            )
        )

        response = authed_api.post(STREAM_URL, BODY, format="json")

        frames = read_frames(response)
        assert frames[0] == ("start", {"model": SERVED_MODEL})
        assert frames[1] == ("delta", {"text": "Hello"})
        assert frames[2] == ("delta", {"text": ", world"})
        terminals = [(name, data) for name, data in frames if name in ("completed", "error")]
        assert terminals == [
            (
                "completed",
                {"text": "Hello, world", "model": SERVED_MODEL, "delta_count": 2},
            )
        ]
        assert frames[-1][0] == "completed"

    def test_connection_closes_after_the_terminal_frame(self, authed_api, install_service):
        install_service((StreamStart(model=SERVED_MODEL),))

        response = authed_api.post(STREAM_URL, BODY, format="json")

        iterator = response.streaming_content
        consumed = [next(iterator)]
        with pytest.raises(StopIteration):
            while True:
                consumed.append(next(iterator))

        names = [parse_frame(chunk)[0] for chunk in consumed]
        assert names == ["start", "completed"]

    def test_zero_delta_completion_carries_empty_text(self, authed_api, install_service):
        install_service((StreamStart(model=SERVED_MODEL),))

        response = authed_api.post(STREAM_URL, BODY, format="json")

        frames = read_frames(response)
        assert frames[-1] == ("completed", {"text": "", "model": SERVED_MODEL, "delta_count": 0})

    def test_request_is_built_from_body_and_never_pins_a_model(self, authed_api, install_service):
        provider = install_service((StreamStart(model=SERVED_MODEL),))
        payload = {
            "messages": [
                {"role": "system", "content": "You are a tutor."},
                {"role": "user", "content": "Hi"},
            ],
            "temperature": 0.5,
            # Unknown/client-controlled fields are ignored; no model pin exists.
            "model": "attacker/tiny-model",
        }

        response = authed_api.post(STREAM_URL, payload, format="json")

        assert response.status_code == 200
        assert len(read_frames(response)) >= 1
        (forwarded,) = provider.stream_requests
        assert forwarded.model is None
        assert forwarded.temperature == 0.5
        assert [(m.role, m.content) for m in forwarded.messages] == [
            ("system", "You are a tutor."),
            ("user", "Hi"),
        ]


class TestIncrementalDelivery:
    def test_frames_arrive_as_the_provider_produces_events(self, authed_api, install_service):
        start = StreamStart(model=SERVED_MODEL)
        delta_one = StreamDelta(text="one")
        delta_two = StreamDelta(text="two")
        provider = install_service((start, delta_one, delta_two))

        response = authed_api.post(STREAM_URL, BODY, format="json")
        frames = response.streaming_content

        first = next(frames)
        assert parse_frame(first) == ("start", {"model": SERVED_MODEL})
        assert provider.produced == [start]

        second = next(frames)
        assert parse_frame(second) == ("delta", {"text": "one"})
        assert provider.produced == [start, delta_one]

        third = next(frames)
        assert parse_frame(third) == ("delta", {"text": "two"})
        assert provider.produced == [start, delta_one, delta_two]

        fourth = next(frames)
        assert parse_frame(fourth)[0] == "completed"


class TestFailedStream:
    def test_pre_stream_failure_emits_single_error_frame(self, authed_api, install_service):
        error = LLMAuthenticationError("bad key")
        install_service(error)

        response = authed_api.post(STREAM_URL, BODY, format="json")

        frames = read_frames(response)
        assert frames == [("error", {"error": str(error), "retryable": False})]

    def test_mid_stream_failure_delivers_deltas_then_defined_error_frame(
        self, authed_api, install_service
    ):
        error = LLMAvailabilityError("upstream collapsed")
        prefix = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="Par"),
            StreamDelta(text="tial"),
        )
        install_service(MidStreamFailure(prefix=prefix, error=error))

        response = authed_api.post(STREAM_URL, BODY, format="json")

        iterator = response.streaming_content
        frames = []
        with pytest.raises(StopIteration):
            while True:
                frames.append(parse_frame(next(iterator)))

        assert [name for name, _ in frames[:3]] == ["start", "delta", "delta"]
        (error_name, error_data) = frames[-1]
        assert error_name == "error"
        assert error_data == {"error": str(error), "retryable": True}
        assert set(error_data) == {"error", "retryable"}
        assert "Partial" not in error_data["error"]

    def test_error_payload_shape_is_defined(self, authed_api, install_service):
        error = LLMAuthenticationError("bad key")
        install_service(error)

        response = authed_api.post(STREAM_URL, BODY, format="json")

        (_, data) = read_frames(response)[0]
        assert isinstance(data["error"], str)
        assert data["error"] == "llm: bad key"
        assert data["retryable"] is False


class TestUnexpectedException:
    def test_non_llm_errors_are_not_masked_as_error_frames(self, authed_api, install_service):
        boom = ValueError("provider implementation bug")
        prefix = (StreamStart(model=SERVED_MODEL), StreamDelta(text="Par"))
        install_service(MidStreamFailure(prefix=prefix, error=boom))

        response = authed_api.post(STREAM_URL, BODY, format="json")

        iterator = response.streaming_content
        frames = [parse_frame(next(iterator)), parse_frame(next(iterator))]
        with pytest.raises(ValueError) as ctx:
            next(iterator)

        assert ctx.value is boom
        assert [name for name, _ in frames] == ["start", "delta"]
