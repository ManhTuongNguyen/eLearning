"""Tests for the Gemini provider (llm.gemini), HTTP fully mocked.

Gemini is the proof that the provider abstraction accommodates integrations
whose API surface genuinely differs from OpenAI-compatible vendors: distinct
paths (``generateContent`` / ``streamGenerateContent``), role mapping
(``assistant`` → ``model``, ``system`` → ``systemInstruction``), key
authentication via ``x-goog-api-key``, and SSE chunks without a ``[DONE]``
terminator. Every failure must land in the shared normalized hierarchy.
"""

import json
import logging
from collections.abc import Callable

import httpx
from django.test import SimpleTestCase

from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.gemini import DEFAULT_BASE_URL, GeminiProvider
from llm.types import CompletionRequest, Message, ModelInfo, StreamDelta, StreamStart

API_KEY = "gem-test-secret-123"
BASE_URL = "https://gemini.example/v1beta"
MODEL = "gemini-integration-primary"


def make_provider(handler: Callable[[httpx.Request], httpx.Response]) -> GeminiProvider:
    return GeminiProvider(
        api_key=API_KEY,
        base_url=BASE_URL,
        default_model=MODEL,
        connect_timeout=2.0,
        read_timeout=5.0,
        client=httpx.Client(base_url=BASE_URL, transport=httpx.MockTransport(handler)),
    )


def simple_request(**kwargs: object) -> CompletionRequest:
    defaults: dict[str, object] = {"messages": (Message(role="user", content="Hi"),)}
    defaults.update(kwargs)
    return CompletionRequest(**defaults)  # type: ignore[arg-type]


def completion_body(
    *,
    model: str = MODEL,
    text: str = "Hello from Gemini!",
    finish_reason: str | None = "STOP",
) -> dict[str, object]:
    candidate: dict[str, object] = {
        "content": {"role": "model", "parts": [{"text": text}]},
    }
    if finish_reason is not None:
        candidate["finishReason"] = finish_reason
    return {
        "candidates": [candidate],
        "modelVersion": model,
        "responseId": "gem-response-1",
    }


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
    """Constructor validation and defaults."""

    def test_blank_api_key_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            GeminiProvider(api_key="  ", default_model=MODEL)

    def test_blank_model_and_base_url_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            GeminiProvider(api_key=API_KEY, default_model="  ")
        with self.assertRaises(ValueError):
            GeminiProvider(api_key=API_KEY, default_model=MODEL, base_url=" ")

    def test_default_base_url_matches_public_api_root(self) -> None:
        self.assertEqual(DEFAULT_BASE_URL, "https://generativelanguage.googleapis.com/v1beta")
        provider = GeminiProvider(api_key=API_KEY, default_model=MODEL)
        self.addCleanup(provider.close)
        self.assertEqual(provider.base_url, DEFAULT_BASE_URL)

    def test_provider_name_is_normalized_on_errors(self) -> None:
        provider = make_provider(lambda _r: httpx.Response(401, text="denied"))
        with self.assertRaises(LLMAuthenticationError) as ctx:
            provider.complete(simple_request())
        self.assertEqual(ctx.exception.provider, "gemini")


class CompleteTests(SimpleTestCase):
    """generateContent mapping: paths, auth, roles, and parsing."""

    def test_complete_posts_to_generate_content_with_key_header(self) -> None:
        handler = CapturingHandler(lambda _r: httpx.Response(200, json=completion_body()))
        provider = make_provider(handler)

        response = provider.complete(
            simple_request(temperature=0.4),
        )

        request = handler.last
        self.assertEqual(request.url.path, f"/v1beta/models/{MODEL}:generateContent")
        self.assertEqual(request.headers["x-goog-api-key"], API_KEY)
        self.assertNotIn("authorization", {k.lower() for k in request.headers})
        payload = json.loads(request.content.decode())
        self.assertEqual(payload["contents"], [{"role": "user", "parts": [{"text": "Hi"}]}])
        self.assertEqual(payload["generationConfig"], {"temperature": 0.4})
        self.assertNotIn("systemInstruction", payload)

        self.assertEqual(response.text, "Hello from Gemini!")
        self.assertEqual(response.model, MODEL)
        self.assertEqual(response.finish_reason, "STOP")
        self.assertEqual(response.request_id, "gem-response-1")

    def test_system_messages_become_system_instruction_and_assistant_becomes_model(self) -> None:
        handler = CapturingHandler(lambda _r: httpx.Response(200, json=completion_body()))
        provider = make_provider(handler)

        provider.complete(
            simple_request(
                messages=(
                    Message(role="system", content="Be helpful."),
                    Message(role="system", content="Stay concise."),
                    Message(role="user", content="Hi"),
                    Message(role="assistant", content="Hello."),
                    Message(role="user", content="Bye"),
                )
            )
        )

        payload = json.loads(handler.last.content.decode())
        self.assertEqual(
            payload["systemInstruction"],
            {"parts": [{"text": "Be helpful.\n\nStay concise."}]},
        )
        self.assertEqual(
            payload["contents"],
            [
                {"role": "user", "parts": [{"text": "Hi"}]},
                {"role": "model", "parts": [{"text": "Hello."}]},
                {"role": "user", "parts": [{"text": "Bye"}]},
            ],
        )

    def test_response_without_text_parts_is_a_response_error(self) -> None:
        provider = make_provider(lambda _r: httpx.Response(200, json={"candidates": []}))
        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())

    def test_malformed_json_is_a_response_error(self) -> None:
        provider = make_provider(lambda _r: httpx.Response(200, text="not-json"))
        with self.assertRaises(LLMResponseError):
            provider.complete(simple_request())


class StreamTests(SimpleTestCase):
    """streamGenerateContent SSE mapping without a [DONE] terminator."""

    @staticmethod
    def sse_response(*chunks: dict[str, object]) -> httpx.Response:
        frames = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
        return httpx.Response(200, text=frames, headers={"content-type": "text/event-stream"})

    def test_stream_emits_start_then_deltas_and_ends_with_the_stream(self) -> None:
        chunks = (
            {"candidates": [{"content": {"parts": [{"text": "Hel"}]}}], "modelVersion": MODEL},
            {"candidates": [{"content": {"parts": [{"text": "lo!"}]}}], "modelVersion": MODEL},
        )
        handler = CapturingHandler(lambda _r: self.sse_response(*chunks))
        provider = make_provider(handler)

        events = list(provider.stream(simple_request()))

        request = handler.last
        self.assertEqual(request.url.path, f"/v1beta/models/{MODEL}:streamGenerateContent")
        self.assertEqual(request.url.params["alt"], "sse")
        self.assertEqual(request.headers["x-goog-api-key"], API_KEY)
        payload = json.loads(request.content.decode())
        self.assertNotIn("stream", payload)
        self.assertEqual(
            [type(event) for event in events],
            [StreamStart, StreamDelta, StreamDelta],
        )
        self.assertEqual(events[0].model, MODEL)
        self.assertEqual("".join(event.text for event in events[1:]), "Hello!")

    def test_stream_error_status_is_normalized(self) -> None:
        provider = make_provider(
            lambda _r: httpx.Response(
                429,
                json={"error": {"code": 429, "message": "quota exhausted"}},
            )
        )
        with self.assertRaises(LLMAvailabilityError):
            list(provider.stream(simple_request()))

    def test_stream_without_events_is_a_response_error(self) -> None:
        provider = make_provider(lambda _r: self.sse_response())
        with self.assertRaises(LLMResponseError):
            list(provider.stream(simple_request()))

    def test_inline_error_chunk_is_normalized_with_its_code(self) -> None:
        provider = make_provider(
            lambda _r: self.sse_response(
                {"error": {"code": 400, "message": "bad generation request"}}
            )
        )
        with self.assertRaises(LLMBadRequestError):
            list(provider.stream(simple_request()))


class ModelDiscoveryTests(SimpleTestCase):
    """The /models catalog normalizes into the shared ModelInfo shape."""

    def test_models_normalize_and_skip_malformed_entries(self) -> None:
        body = {
            "models": [
                {
                    "name": "models/gemini-integration-flash",
                    "displayName": "Integration Flash",
                    "description": "Fast model.",
                    "inputTokenLimit": 1_048_576,
                },
                {"displayName": "no name"},
                "not-an-object",
            ]
        }
        provider = make_provider(lambda _r: httpx.Response(200, json=body))

        models = provider.list_models()

        self.assertEqual(
            models,
            (
                ModelInfo(
                    id="gemini-integration-flash",
                    name="Integration Flash",
                    description="Fast model.",
                    context_length=1_048_576,
                    created=None,
                ),
            ),
        )

    def test_models_failure_is_normalized(self) -> None:
        provider = make_provider(
            lambda _r: httpx.Response(
                403,
                json={"error": {"code": 403, "message": "API key not authorized"}},
            )
        )
        with self.assertRaises(LLMAuthenticationError):
            provider.list_models()


class ErrorNormalizationTests(SimpleTestCase):
    """Failures map onto the shared hierarchy and never leak the key."""

    def test_status_mapping_matches_the_shared_matrix(self) -> None:
        cases = [
            (401, LLMAuthenticationError),
            (403, LLMAuthenticationError),
            (400, LLMBadRequestError),
            (408, LLMTimeoutError),
            (429, LLMAvailabilityError),
            (500, LLMAvailabilityError),
            (418, LLMResponseError),
        ]
        for status, expected in cases:
            with self.subTest(status=status):
                provider = make_provider(
                    lambda _r, status=status: httpx.Response(
                        status, json={"error": {"code": status, "message": f"boom {status}"}}
                    )
                )
                with self.assertRaises(expected) as ctx:
                    provider.complete(simple_request())
                self.assertEqual(ctx.exception.provider, "gemini")
                self.assertIn(f"boom {status}", ctx.exception.message)

    def test_transport_failures_are_retryable_request_errors(self) -> None:
        def failing_handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        provider = make_provider(failing_handler)
        with self.assertRaises(LLMRequestError) as ctx:
            provider.complete(simple_request())
        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(ctx.exception.provider, "gemini")

    def test_errors_and_logs_never_contain_the_api_key(self) -> None:
        handler = CapturingHandler(
            lambda _r: httpx.Response(401, json={"error": {"code": 401, "message": "denied"}})
        )
        provider = make_provider(handler)
        with self.assertLogs("llm.gemini", level=logging.WARNING) as logs:
            with self.assertRaises(LLMError) as ctx:
                provider.complete(simple_request())

        rendered = str(ctx.exception) + "\n" + "\n".join(logs.output)
        self.assertNotIn(API_KEY, rendered)
        for request in handler.requests:
            self.assertNotIn(API_KEY, dict(request.headers).get("error", ""))
