"""Tests for the LLM provider abstraction (llm.provider / llm.types / llm.exceptions)."""

import dataclasses
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

from django.test import SimpleTestCase

import llm.exceptions
import llm.provider
import llm.types
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.provider import LLMProvider
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    Message,
    ModelInfo,
    StreamDelta,
    StreamStart,
)


class FakeScriptedProvider(LLMProvider):
    """Deterministic provider used to prove the interface is mockable."""

    def __init__(
        self,
        response: CompletionResponse | None = None,
        events: tuple[StreamStart | StreamDelta, ...] | None = None,
        stream_error: LLMError | None = None,
    ) -> None:
        self.response = response or CompletionResponse(text="Hello!", model="fake/model")
        self.events = events or (StreamStart(model="fake/model"), StreamDelta(text="Hello!"))
        self.stream_error = stream_error
        self.received_request: CompletionRequest | None = None

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.received_request = request
        return self.response

    def stream(self, request: CompletionRequest) -> Iterator[StreamStart | StreamDelta]:
        self.received_request = request
        yield from self.events
        if self.stream_error is not None:
            raise self.stream_error


class MessageTests(SimpleTestCase):
    """Message validation and immutability."""

    def test_valid_roles_are_accepted(self) -> None:
        for role in ("system", "user", "assistant"):
            self.assertEqual(Message(role=role, content="hi").role, role)

    def test_invalid_role_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Message(role="tool", content="hi")

    def test_blank_content_is_rejected(self) -> None:
        for content in ("", "   \n\t "):
            with self.assertRaises(ValueError):
                Message(role="user", content=content)

    def test_message_is_frozen(self) -> None:
        message = Message(role="user", content="hi")

        with self.assertRaises(dataclasses.FrozenInstanceError):
            message.content = "changed"


class CompletionRequestTests(SimpleTestCase):
    """CompletionRequest validation and normalization."""

    def test_requires_at_least_one_message(self) -> None:
        with self.assertRaises(ValueError):
            CompletionRequest(messages=[])

    def test_list_messages_are_normalized_to_tuple(self) -> None:
        request = CompletionRequest(messages=[Message(role="user", content="hi")])

        self.assertIsInstance(request.messages, tuple)
        self.assertEqual(len(request.messages), 1)

    def test_model_override_must_be_non_empty(self) -> None:
        for model in ("", "   "):
            with self.assertRaises(ValueError):
                CompletionRequest(
                    messages=(Message(role="user", content="hi"),),
                    model=model,
                )

        request = CompletionRequest(
            messages=(Message(role="user", content="hi"),),
            model="vendor/name",
        )
        self.assertEqual(request.model, "vendor/name")

    def test_temperature_bounds_are_enforced(self) -> None:
        base = (Message(role="user", content="hi"),)

        for temperature in (-0.1, 2.01):
            with self.assertRaises(ValueError):
                CompletionRequest(messages=base, temperature=temperature)

        for temperature in (0.0, 1.7, 2.0):
            self.assertEqual(
                CompletionRequest(messages=base, temperature=temperature).temperature,
                temperature,
            )

    def test_from_texts_builds_typed_messages(self) -> None:
        request = CompletionRequest.from_texts(
            [("system", "You help."), ("user", "Hi")],
            model="vendor/name",
        )

        self.assertEqual(
            [message.role for message in request.messages],
            ["system", "user"],
        )
        self.assertEqual(request.model, "vendor/name")


class CompletionResponseTests(SimpleTestCase):
    """CompletionResponse shape."""

    def test_defaults_keep_optional_metadata_empty(self) -> None:
        response = CompletionResponse(text="ok", model="fake/model")

        self.assertIsNone(response.finish_reason)
        self.assertIsNone(response.request_id)

    def test_response_is_frozen(self) -> None:
        response = CompletionResponse(text="ok", model="fake/model")

        with self.assertRaises(dataclasses.FrozenInstanceError):
            response.text = "changed"


class StreamEventTests(SimpleTestCase):
    """Stream event normalization rules."""

    def test_empty_delta_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            StreamDelta(text="")


class ModelInfoTests(SimpleTestCase):
    """ModelInfo normalized-shape rules."""

    def test_defaults_keep_optional_metadata_empty(self) -> None:
        model = ModelInfo(id="vendor/model")

        self.assertEqual(model.name, "")
        self.assertIsNone(model.description)
        self.assertIsNone(model.context_length)
        self.assertIsNone(model.created)

    def test_blank_id_is_rejected(self) -> None:
        for model_id in ("", "   "):
            with self.assertRaises(ValueError):
                ModelInfo(id=model_id)

    def test_model_info_is_frozen(self) -> None:
        model = ModelInfo(id="vendor/model")

        with self.assertRaises(dataclasses.FrozenInstanceError):
            model.id = "changed"


class ProviderInterfaceTests(SimpleTestCase):
    """The ABC itself and consumption through the abstraction only."""

    def test_interface_cannot_be_instantiated(self) -> None:
        with self.assertRaises(TypeError):
            LLMProvider()  # type: ignore[abstract]

    def test_partial_implementation_is_rejected(self) -> None:
        class OnlyStreaming(LLMProvider):
            def stream(self, request: CompletionRequest) -> Iterator[StreamStart | StreamDelta]:
                yield StreamStart(model="fake/model")

        with self.assertRaises(TypeError):
            OnlyStreaming()  # type: ignore[abstract]

    def test_consumer_works_against_any_implementation(self) -> None:
        """Application code depends only on the interface, never a vendor."""

        def build_greeting(provider: LLMProvider) -> str:
            request = CompletionRequest.from_texts([("system", "Be brief."), ("user", "Greet me")])
            return provider.complete(request).text

        fake = FakeScriptedProvider()
        mocked = Mock(spec=LLMProvider)
        mocked.complete.return_value = CompletionResponse(text="Mocked!", model="mocked/model")

        self.assertEqual(build_greeting(fake), "Hello!")
        assert fake.received_request is not None
        self.assertEqual(len(fake.received_request.messages), 2)
        self.assertEqual(build_greeting(mocked), "Mocked!")

    def test_stream_is_consumed_incrementally_through_the_interface(self) -> None:
        provider = FakeScriptedProvider(
            events=(
                StreamStart(model="fake/other"),
                StreamDelta(text="Hel"),
                StreamDelta(text="lo"),
                StreamDelta(text=" there"),
            )
        )
        request = CompletionRequest(messages=(Message(role="user", content="Greet me"),))

        events = list(provider.stream(request))
        start, deltas = events[0], events[1:]

        self.assertEqual(provider.received_request, request)
        self.assertEqual(start.model, "fake/other")
        self.assertTrue(all(isinstance(delta, StreamDelta) for delta in deltas))
        self.assertEqual("".join(delta.text for delta in deltas), "Hello there")

    def test_stream_failure_raises_normalized_error_after_deltas(self) -> None:
        failure = LLMAvailabilityError("upstream overloaded", provider="fake")
        provider = FakeScriptedProvider(stream_error=failure)
        request = CompletionRequest(messages=(Message(role="user", content="Hi"),))
        received: list[str] = []

        with self.assertRaises(LLMAvailabilityError) as ctx:
            for event in provider.stream(request):
                if isinstance(event, StreamDelta):
                    received.append(event.text)

        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(received, ["Hello!"])


class ExceptionHierarchyTests(SimpleTestCase):
    """Normalized error semantics."""

    def test_retryable_defaults_match_failure_classes(self) -> None:
        self.assertFalse(LLMError("x").retryable)
        self.assertTrue(LLMRequestError("x").retryable)
        self.assertTrue(LLMTimeoutError("x").retryable)
        self.assertFalse(LLMAuthenticationError("x").retryable)
        self.assertFalse(LLMBadRequestError("x").retryable)
        self.assertTrue(LLMAvailabilityError("x").retryable)
        self.assertFalse(LLMResponseError("x").retryable)

    def test_all_errors_share_llm_error_base(self) -> None:
        for error_class in (
            LLMRequestError,
            LLMTimeoutError,
            LLMAuthenticationError,
            LLMBadRequestError,
            LLMAvailabilityError,
            LLMResponseError,
        ):
            self.assertTrue(issubclass(error_class, LLMError))

    def test_str_includes_provider_and_model_context(self) -> None:
        error = LLMAuthenticationError("bad key", provider="openrouter", model="a/b")

        self.assertEqual(str(error), "openrouter [a/b]: bad key")
        self.assertFalse(error.retryable)


class AbstractionPurityTests(SimpleTestCase):
    """Acceptance guard: the abstraction must stay free of HTTP/vendor coupling."""

    BANNED_TOKENS = ("httpx", "requests", "urllib", "socket", "openrouter")

    def test_abstraction_modules_import_no_http_or_vendor_libraries(self) -> None:
        modules: tuple[ModuleType, ...] = (llm.types, llm.provider, llm.exceptions)

        for module in modules:
            lines = Path(module.__file__).read_text(encoding="utf-8").splitlines()
            imports = "\n".join(
                line.strip() for line in lines if line.strip().startswith(("import ", "from "))
            ).lower()
            for token in self.BANNED_TOKENS:
                self.assertNotIn(token, imports)
