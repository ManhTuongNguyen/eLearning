"""Tests for the shared OpenAI-compatible provider strategy (TASK-AUDIT-013).

OpenRouter, OpenAI, 9Router, and generic OpenAI-compatible deployments share
one implementation (``llm.openai_compatible.OpenAICompatibleProvider``); each
concrete provider only contributes its identity and default endpoint. These
tests prove that reuse end-to-end: identical wire behavior across subclasses,
per-provider attribution in logs/errors, and correct default endpoints.
"""

import json

import httpx
from django.test import SimpleTestCase

from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError, LLMError
from llm.ninerouter import NineRouterProvider
from llm.openai import OpenAIProvider
from llm.openai_compatible import OpenAICompatibleProvider
from llm.openrouter import OpenRouterProvider
from llm.types import CompletionRequest, Message, StreamDelta, StreamStart

API_KEY = "sk-compat-test-key"


def make_provider(
    cls: type[OpenAICompatibleProvider],
    handler,
    *,
    base_url: str | None = None,
) -> OpenAICompatibleProvider:
    return cls(
        api_key=API_KEY,
        base_url=base_url,
        default_model="vendor/main",
        connect_timeout=2.0,
        read_timeout=5.0,
        client=httpx.Client(
            base_url=base_url or cls.default_base_url,
            transport=httpx.MockTransport(handler),
        ),
    )


def completion_body(model: str = "vendor/main", text: str = "Hello!") -> dict[str, object]:
    return {
        "id": "gen-1",
        "model": model,
        "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
    }


def simple_request(**kwargs: object) -> CompletionRequest:
    defaults: dict[str, object] = {"messages": (Message(role="user", content="Hi"),)}
    defaults.update(kwargs)
    return CompletionRequest(**defaults)  # type: ignore[arg-type]


class SharedStrategyTests(SimpleTestCase):
    """Every OpenAI-compatible provider hits /chat/completions identically."""

    def test_each_provider_posts_bearer_auth_to_its_default_endpoint(self) -> None:
        for cls in (OpenRouterProvider, OpenAIProvider, NineRouterProvider):
            with self.subTest(provider=cls.provider_name):
                seen: list[httpx.Request] = []

                def handler(request: httpx.Request, seen: list = seen) -> httpx.Response:
                    seen.append(request)
                    return httpx.Response(200, json=completion_body())

                provider = make_provider(cls, handler)
                response = provider.complete(simple_request())

                request = seen[-1]
                self.assertTrue(
                    str(request.url).startswith(cls.default_base_url),
                    f"{request.url} must target {cls.default_base_url}",
                )
                self.assertTrue(request.url.path.endswith("/chat/completions"))
                self.assertEqual(request.headers["Authorization"], f"Bearer {API_KEY}")
                payload = json.loads(request.content.decode())
                self.assertEqual(payload["model"], "vendor/main")
                self.assertEqual(payload["stream"], False)
                self.assertEqual(response.text, "Hello!")

    def test_explicit_base_url_overrides_the_default(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request, seen: list = seen) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=completion_body())

        provider = make_provider(OpenAIProvider, handler, base_url="https://proxy.example/v1")
        provider.complete(simple_request())

        self.assertTrue(
            str(seen[-1].url).startswith("https://proxy.example/v1"),
            f"{seen[-1].url} must target the overridden base URL",
        )

    def test_generic_provider_requires_an_explicit_base_url(self) -> None:
        with self.assertRaises(ValueError):
            OpenAICompatibleProvider(api_key=API_KEY, default_model="vendor/main")

    def test_streaming_is_shared_across_providers(self) -> None:
        sse = (
            'data: {"model": "served/model", "choices": [{"delta": {"content": "He"}}]}\n\n'
            'data: {"model": "served/model", "choices": [{"delta": {"content": "y"}}]}\n\n'
            "data: [DONE]\n\n"
        )
        for cls in (OpenRouterProvider, OpenAIProvider, NineRouterProvider):
            with self.subTest(provider=cls.provider_name):
                provider = make_provider(
                    cls,
                    lambda _r, sse=sse: httpx.Response(200, text=sse),
                )
                events = list(provider.stream(simple_request()))
                self.assertEqual(
                    [type(event) for event in events], [StreamStart, StreamDelta, StreamDelta]
                )
                self.assertEqual("".join(e.text for e in events[1:]), "Hey")

    def test_error_attribution_names_the_concrete_provider(self) -> None:
        for cls in (OpenRouterProvider, OpenAIProvider, NineRouterProvider):
            with self.subTest(provider=cls.provider_name):
                provider = make_provider(
                    cls,
                    lambda _r: httpx.Response(
                        503, json={"error": {"message": "capacity exhausted"}}
                    ),
                )
                with self.assertRaises(LLMAvailabilityError) as ctx:
                    provider.complete(simple_request())
                self.assertEqual(ctx.exception.provider, cls.provider_name)

    def test_invalid_keys_fail_without_retryable_fallback_confusion(self) -> None:
        provider = make_provider(
            OpenAIProvider,
            lambda _r: httpx.Response(401, json={"error": {"message": "bad key"}}),
        )
        with self.assertRaises(LLMAuthenticationError) as ctx:
            provider.complete(simple_request())
        self.assertFalse(ctx.exception.retryable)
        self.assertNotIn(API_KEY, str(ctx.exception))


class ModelCatalogTests(SimpleTestCase):
    """The shared /models listing normalizes identically for all subclasses."""

    def test_list_models_normalizes_entries(self) -> None:
        body = {
            "data": [
                {
                    "id": "vendor/model-a",
                    "name": "Model A",
                    "description": "First.",
                    "context_length": 8192,
                },
                {"name": "missing id"},
            ]
        }
        provider = make_provider(OpenAIProvider, lambda _r: httpx.Response(200, json=body))
        models = provider.list_models()
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0].id, "vendor/model-a")

    def test_list_models_failure_is_normalized(self) -> None:
        provider = make_provider(
            NineRouterProvider,
            lambda _r: httpx.Response(500, text="boom"),
        )
        with self.assertRaises(LLMError) as ctx:
            provider.list_models()
        self.assertEqual(ctx.exception.provider, "ninerouter")
