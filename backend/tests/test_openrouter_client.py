"""Tests for the OpenRouter client (llm.openrouter), HTTP fully mocked."""

import json
import logging
from collections.abc import Callable, Iterator

import httpx
from django.test import SimpleTestCase, override_settings

from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.openrouter import DEFAULT_BASE_URL, OpenRouterProvider
from llm.types import CompletionRequest, Message, StreamDelta, StreamStart

API_KEY = "sk-test-secret-123"
BASE_URL = "https://openrouter.example/api/v1"
MODEL = "vendor/primary"


def make_provider(handler: Callable[[httpx.Request], httpx.Response]) -> OpenRouterProvider:
    return OpenRouterProvider(
        api_key=API_KEY,
        base_url=BASE_URL,
        default_model=MODEL,
        timeout=5.0,
        client=httpx.Client(base_url=BASE_URL, transport=httpx.MockTransport(handler)),
    )


def simple_request(**kwargs: object) -> CompletionRequest:
    defaults: dict[str, object] = {"messages": (Message(role="user", content="Hi"),)}
    defaults.update(kwargs)
    return CompletionRequest(**defaults)  # type: ignore[arg-type]


def completion_body(
    *,
    model: str = MODEL,
    text: str = "Hello!",
    finish_reason: str | None = "stop",
    request_id: str | None = "gen-body-1",
) -> dict[str, object]:
    body: dict[str, object] = {
        "model": model,
        "choices": [{"message": {"content": text}, "finish_reason": finish_reason}],
    }
    if request_id is not None:
        body["id"] = request_id
    return body


class CapturingHandler:
    """MockTransport handler that records requests and returns a canned response."""

    def __init__(self, response_factory: Callable[[httpx.Request], httpx.Response]) -> None:
        self.response_factory = response_factory
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.response_factory(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


class ConstructionTests(SimpleTestCase):
    """Constructor validation and ownership semantics."""

    def test_blank_api_key_is_rejected(self) -> None:
        for key in ("", "   "):
            with self.assertRaises(ValueError):
                OpenRouterProvider(api_key=key, default_model=MODEL)

    def test_blank_model_and_base_url_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            OpenRouterProvider(api_key=API_KEY, default_model="  ")
        with self.assertRaises(ValueError):
            OpenRouterProvider(api_key=API_KEY, default_model=MODEL, base_url=" ")

    def test_non_positive_timeout_is_rejected(self) -> None:
        for timeout in (0, -1):
            with self.assertRaises(ValueError):
                OpenRouterProvider(api_key=API_KEY, default_model=MODEL, timeout=timeout)

    def test_close_only_closes_owned_client(self) -> None:
        owned = OpenRouterProvider(api_key=API_KEY, default_model=MODEL)
        injected_client = httpx.Client(
            transport=httpx.MockTransport(lambda _r: httpx.Response(200))
        )
        injected = OpenRouterProvider(
            api_key=API_KEY,
            default_model=MODEL,
            client=injected_client,
        )

        owned.close()
        injected.close()

        self.assertTrue(owned._client.is_closed)
        self.assertFalse(injected_client.is_closed)


class CompleteSuccessTests(SimpleTestCase):
    """Successful non-streaming completions over mocked HTTP."""

    def test_successful_completion_is_normalized(self) -> None:
        handler = CapturingHandler(
            lambda _r: httpx.Response(
                200,
                json=completion_body(text="Hello!", finish_reason="stop"),
                headers={"x-request-id": "req-header-1"},
            )
        )
        provider = make_provider(handler)

        response = provider.complete(simple_request())

        self.assertEqual(response.text, "Hello!")
        self.assertEqual(response.model, MODEL)
        self.assertEqual(response.finish_reason, "stop")
        self.assertEqual(response.request_id, "req-header-1")

        request = handler.last
        self.assertEqual(request.method, "POST")
        self.assertEqual(str(request.url), f"{BASE_URL}/chat/completions")
        self.assertEqual(request.headers["Authorization"], f"Bearer {API_KEY}")
        payload = json.loads(request.content)
        self.assertEqual(payload["model"], MODEL)
        self.assertEqual(payload["stream"], False)
        self.assertEqual(payload["messages"], [{"role": "user", "content": "Hi"}])
        self.assertNotIn("temperature", payload)

    def test_request_level_model_override_wins(self) -> None:
        handler = CapturingHandler(
            lambda _r: httpx.Response(200, json=completion_body(model="vendor/override"))
        )
        provider = make_provider(handler)

        response = provider.complete(simple_request(model="vendor/override"))

        payload = json.loads(handler.last.content)
        self.assertEqual(payload["model"], "vendor/override")
        self.assertEqual(response.model, "vendor/override")

    def test_temperature_forwarded_when_provided(self) -> None:
        handler = CapturingHandler(lambda _r: httpx.Response(200, json=completion_body()))
        provider = make_provider(handler)

        provider.complete(simple_request(temperature=0.3))

        self.assertEqual(json.loads(handler.last.content)["temperature"], 0.3)

    def test_request_id_falls_back_to_body_id_without_header(self) -> None:
        handler = CapturingHandler(lambda _r: httpx.Response(200, json=completion_body()))
        provider = make_provider(handler)

        response = provider.complete(simple_request())

        self.assertEqual(response.request_id, "gen-body-1")


class CompleteResponseShapeTests(SimpleTestCase):
    """Malformed 200 responses normalize to LLMResponseError."""

    def make_handler(self, raw: bytes | str) -> CapturingHandler:
        return CapturingHandler(lambda _r: httpx.Response(200, content=raw))

    def test_missing_choices_raise_response_error(self) -> None:
        provider = make_provider(self.make_handler(json.dumps({"model": MODEL})))

        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())

    def test_non_string_content_raises_response_error(self) -> None:
        body = {"model": MODEL, "choices": [{"message": {"content": 42}, "finish_reason": "stop"}]}
        provider = make_provider(self.make_handler(json.dumps(body)))

        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())

    def test_malformed_json_raises_response_error(self) -> None:
        provider = make_provider(self.make_handler("<html>gateway</html>"))

        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())


class HttpFailureMappingTests(SimpleTestCase):
    """HTTP status codes normalize to the documented exception classes."""

    CASES = (
        (400, LLMBadRequestError, False),
        (401, LLMAuthenticationError, False),
        (403, LLMAuthenticationError, False),
        (404, LLMBadRequestError, False),
        (408, LLMTimeoutError, True),
        (422, LLMBadRequestError, False),
        (429, LLMAvailabilityError, True),
        (500, LLMAvailabilityError, True),
        (503, LLMAvailabilityError, True),
    )

    def test_status_mapping_matrix_for_complete(self) -> None:
        for status, expected_class, retryable in self.CASES:
            with self.subTest(status=status):
                body = json.dumps({"error": {"message": f"boom {status}"}})
                provider = make_provider(lambda _r, s=status, b=body: httpx.Response(s, content=b))

                with self.assertRaises(LLMError) as ctx:
                    provider.complete(simple_request())

                self.assertIsInstance(ctx.exception, expected_class)
                self.assertEqual(ctx.exception.retryable, retryable)
                self.assertEqual(ctx.exception.provider, "openrouter")
                self.assertEqual(ctx.exception.model, MODEL)
                self.assertIn(f"boom {status}", str(ctx.exception))

    def test_unexpected_status_maps_to_response_error(self) -> None:
        provider = make_provider(lambda _r: httpx.Response(302, content=b""))

        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())

    def test_openrouter_error_payload_message_is_extracted(self) -> None:
        body = json.dumps({"error": {"message": "Insufficient credits", "code": 402}})
        provider = make_provider(lambda _r: httpx.Response(402, content=body))

        with self.assertRaises(LLMError) as ctx:
            provider.complete(simple_request())

        self.assertIn("Insufficient credits", ctx.exception.message)

    def test_plain_text_error_body_becomes_snippet(self) -> None:
        provider = make_provider(lambda _r: httpx.Response(502, content=b"Bad gateway"))

        with self.assertRaises(LLMAvailabilityError) as ctx:
            provider.complete(simple_request())

        self.assertIn("Bad gateway", ctx.exception.message)

    def test_long_error_body_is_truncated(self) -> None:
        long_text = "x" * 5000
        provider = make_provider(lambda _r: httpx.Response(500, content=long_text.encode()))

        with self.assertRaises(LLMAvailabilityError) as ctx:
            provider.complete(simple_request())

        self.assertLessEqual(len(ctx.exception.message), 301)


class TransportFailureTests(SimpleTestCase):
    """httpx transport failures normalize to retryable LLM errors."""

    def test_timeout_exception_maps_to_llm_timeout(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("timed out", request=_request)

        provider = make_provider(handler)

        with self.assertRaises(LLMTimeoutError) as ctx:
            provider.complete(simple_request())

        self.assertTrue(ctx.exception.retryable)

    def test_network_error_maps_to_llm_request_error(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=_request)

        provider = make_provider(handler)

        with self.assertRaises(LLMRequestError) as ctx:
            provider.complete(simple_request())

        self.assertTrue(ctx.exception.retryable)


class StreamSuccessTests(SimpleTestCase):
    """Successful SSE streams over mocked HTTP."""

    @staticmethod
    def sse_bytes(*chunks: dict[str, object]) -> Iterator[bytes]:
        for chunk in chunks:
            yield f"data: {json.dumps(chunk)}\n\n".encode()
        yield b"data: [DONE]\n\n"

    def test_stream_emits_start_then_deltas_incrementally(self) -> None:
        chunks = (
            {
                "model": "vendor/served",
                "choices": [{"delta": {"role": "assistant", "content": ""}}],
            },
            {"model": "vendor/served", "choices": [{"delta": {"content": "Hel"}}]},
            {"model": "vendor/served", "choices": [{"delta": {"content": "lo!"}}]},
        )
        handler = CapturingHandler(
            lambda _r: httpx.Response(
                200,
                content=self.sse_bytes(*chunks),
                headers={"Content-Type": "text/event-stream"},
            )
        )
        provider = make_provider(handler)

        events = list(provider.stream(simple_request()))

        start, deltas = events[0], events[1:]
        self.assertIsInstance(start, StreamStart)
        assert isinstance(start, StreamStart)
        self.assertEqual(start.model, "vendor/served")
        self.assertEqual(
            [delta.text for delta in deltas if isinstance(delta, StreamDelta)], ["Hel", "lo!"]
        )

        request = handler.last
        payload = json.loads(request.content)
        self.assertEqual(payload["stream"], True)
        self.assertEqual(str(request.url), f"{BASE_URL}/chat/completions")

    def test_keep_alive_comments_and_blank_lines_are_ignored(self) -> None:
        raw = (
            b": OPENROUTER PROCESSING\n\n"
            b'data: {"model": "vendor/served", "choices": [{"delta": {"content": "ok"}}]}\n'
            b"\n"
            b"data: [DONE]\n\n"
        )
        provider = make_provider(
            lambda _r: httpx.Response(
                200, content=raw, headers={"Content-Type": "text/event-stream"}
            )
        )

        events = list(provider.stream(simple_request()))

        self.assertEqual(len(events), 2)
        self.assertEqual(events[1].text, "ok")  # type: ignore[union-attr]

    def test_empty_deltas_and_usage_chunks_are_skipped(self) -> None:
        chunks = (
            {"model": MODEL, "choices": [{"delta": {"content": ""}}]},
            {"model": MODEL, "choices": [{"delta": {"content": "word"}}]},
            {"model": MODEL, "choices": []},
            {"model": MODEL, "choices": [{"delta": {}, "finish_reason": "stop"}]},
        )
        provider = make_provider(
            lambda _r: httpx.Response(
                200,
                content=self.sse_bytes(*chunks),
                headers={"Content-Type": "text/event-stream"},
            )
        )

        events = list(provider.stream(simple_request()))

        texts = [event.text for event in events if isinstance(event, StreamDelta)]
        self.assertEqual(texts, ["word"])

    def test_start_uses_requested_model_when_chunks_lack_model(self) -> None:
        chunks = ({"choices": [{"delta": {"content": "hey"}}]},)
        provider = make_provider(
            lambda _r: httpx.Response(
                200,
                content=self.sse_bytes(*chunks),
                headers={"Content-Type": "text/event-stream"},
            )
        )

        events = list(provider.stream(simple_request()))

        start = events[0]
        assert isinstance(start, StreamStart)
        self.assertEqual(start.model, MODEL)


class StreamFailureTests(SimpleTestCase):
    """Failed or malformed streams raise normalized errors during iteration."""

    def test_error_status_raises_normalized_error(self) -> None:
        body = json.dumps({"error": {"message": "rate limited"}})
        provider = make_provider(lambda _r: httpx.Response(429, content=body))

        with self.assertRaises(LLMAvailabilityError) as ctx:
            list(provider.stream(simple_request()))

        self.assertTrue(ctx.exception.retryable)
        self.assertIn("rate limited", ctx.exception.message)

    def test_malformed_data_line_raises_response_error(self) -> None:
        raw = b"data: not-json-at-all\n\n"
        provider = make_provider(
            lambda _r: httpx.Response(
                200, content=raw, headers={"Content-Type": "text/event-stream"}
            )
        )

        with self.assertRaises(LLMResponseError):
            list(provider.stream(simple_request()))

    def test_unexpected_sse_line_raises_response_error(self) -> None:
        raw = b"event: error\n\n"
        provider = make_provider(
            lambda _r: httpx.Response(
                200, content=raw, headers={"Content-Type": "text/event-stream"}
            )
        )

        with self.assertRaises(LLMResponseError):
            list(provider.stream(simple_request()))

    def test_empty_stream_raises_response_error(self) -> None:
        provider = make_provider(
            lambda _r: httpx.Response(
                200, content=b"data: [DONE]\n\n", headers={"Content-Type": "text/event-stream"}
            )
        )

        with self.assertRaises(LLMResponseError):
            list(provider.stream(simple_request()))

    def test_mid_stream_transport_error_preserves_partial_deltas(self) -> None:
        def sse_then_fail() -> Iterator[bytes]:
            chunk = {"model": "vendor/served", "choices": [{"delta": {"content": "Hel"}}]}
            yield f"data: {json.dumps(chunk)}\n\n".encode()
            raise httpx.ReadError("connection reset mid-stream")

        provider = make_provider(
            lambda _r: httpx.Response(
                200,
                content=sse_then_fail(),
                headers={"Content-Type": "text/event-stream"},
            )
        )
        received: list[str] = []
        events = provider.stream(simple_request())

        with self.assertRaises(LLMRequestError) as ctx:
            while True:
                try:
                    event = next(events)
                except StopIteration:
                    break
                if isinstance(event, StreamDelta):
                    received.append(event.text)

        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(received, ["Hel"])

    def test_mid_stream_timeout_maps_to_llm_timeout(self) -> None:
        def sse_then_hang() -> Iterator[bytes]:
            yield b'data: {"model": "vendor/served", "choices": [{"delta": {"content": "a"}}]}\n\n'
            raise httpx.ReadTimeout("read timed out")

        provider = make_provider(
            lambda _r: httpx.Response(
                200,
                content=sse_then_hang(),
                headers={"Content-Type": "text/event-stream"},
            )
        )

        with self.assertRaises(LLMTimeoutError):
            list(provider.stream(simple_request()))


class SecretHygieneTests(SimpleTestCase):
    """The API key must never leak through errors, payloads, or logs."""

    def test_no_normalized_error_contains_the_api_key(self) -> None:
        failing_handlers: tuple[Callable[[httpx.Request], httpx.Response], ...] = (
            lambda _r: httpx.Response(401, content=b'{"error": {"message": "bad key"}}'),
            lambda _r: httpx.Response(400, content=b"invalid"),
            lambda _r: httpx.Response(500, content=b"boom"),
            lambda _r: (_ for _ in ()).throw(httpx.ConnectTimeout("t", request=None)),  # type: ignore[arg-type]
            lambda _r: (_ for _ in ()).throw(httpx.ReadError("reset")),
        )

        for handler in failing_handlers:
            for streamed in (False, True):
                with self.subTest(streamed=streamed, handler=handler):
                    provider = make_provider(handler)
                    request = simple_request()
                    with self.assertRaises(LLMError) as ctx:
                        consumed = (
                            provider.stream(request) if streamed else provider.complete(request)
                        )
                        _ = next(iter(consumed)) if streamed else None

                    self.assertNotIn(API_KEY, str(ctx.exception))
                    self.assertNotIn(API_KEY, ctx.exception.message)

    def test_key_appears_only_in_authorization_header(self) -> None:
        sse_body = (
            b'data: {"model": "'
            + MODEL.encode()
            + b'", "choices": [{"delta": {"content": "ok"}}]}\n\n'
            b"data: [DONE]\n\n"
        )

        def factory(request: httpx.Request) -> httpx.Response:
            if json.loads(request.content)["stream"]:
                return httpx.Response(
                    200, content=sse_body, headers={"Content-Type": "text/event-stream"}
                )
            return httpx.Response(200, json=completion_body())

        handler = CapturingHandler(factory)
        provider = make_provider(handler)

        provider.complete(simple_request())
        list(provider.stream(simple_request()))

        self.assertEqual(len(handler.requests), 2)
        for request in handler.requests:
            auth_matches = [value for value in request.headers.values() if API_KEY in value]
            self.assertEqual(len(auth_matches), 1)
            self.assertTrue(auth_matches[0].startswith("Bearer "))
            self.assertNotIn(API_KEY, request.content.decode())

    def test_failure_logs_never_contain_the_api_key(self) -> None:
        provider = make_provider(
            lambda _r: httpx.Response(429, content=b'{"error": {"message": "rl"}}')
        )

        with self.assertLogs("llm.openrouter", level=logging.WARNING) as logs:
            with self.assertRaises(LLMAvailabilityError):
                provider.complete(simple_request())

        joined = "\n".join(logs.output)
        self.assertIn("429", joined)
        self.assertNotIn(API_KEY, joined)


class SettingsWiringTests(SimpleTestCase):
    """from_settings() reads the documented Django settings."""

    @override_settings(
        OPENROUTER_API_KEY="sk-from-settings",
        OPENROUTER_BASE_URL=f"{DEFAULT_BASE_URL}/",
        LLM_PRIMARY_MODEL="settings/model",
        LLM_REQUEST_TIMEOUT_SECONDS=7,
    )
    def test_from_settings_reads_configuration(self) -> None:
        provider = OpenRouterProvider.from_settings()
        self.addCleanup(provider.close)

        self.assertEqual(provider.api_key, "sk-from-settings")
        self.assertEqual(provider.base_url, DEFAULT_BASE_URL)
        self.assertEqual(provider.default_model, "settings/model")
        self.assertEqual(provider.timeout, 7.0)

    def test_default_base_url_constant_matches_documented_api_root(self) -> None:
        self.assertEqual(DEFAULT_BASE_URL, "https://openrouter.ai/api/v1")
