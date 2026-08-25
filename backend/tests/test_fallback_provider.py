"""Tests for model fallback (llm.fallback), driven through fake providers."""

from dataclasses import dataclass
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from llm.config import ModelConfiguration
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    Message,
    StreamDelta,
    StreamEvent,
    StreamStart,
)

MODEL_A = "vendor/a"
MODEL_B = "vendor/b"
MODEL_C = "vendor/c"

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

RESPONSE_A = CompletionResponse(text="From A", model="served/a", finish_reason="stop")
RESPONSE_B = CompletionResponse(text="From B", model="served/b")
RESPONSE_C = CompletionResponse(text="From C", model=MODEL_C)

EVENTS_B = (StreamStart(model="served/b"), StreamDelta(text="Hello"), StreamDelta(text="!"))
DEFAULT_RESPONSE = CompletionResponse(text="default", model="vendor/default")
DEFAULT_EVENTS = (StreamStart(model="vendor/default"), StreamDelta(text="hi"))


@dataclass
class StreamFailure:
    """Scripted stream that raises as soon as iteration starts."""

    error: Exception


@dataclass
class MidStreamFailure:
    """Scripted stream emitting events and then raising."""

    prefix: tuple[StreamEvent, ...]
    error: Exception


class ScriptedProvider(LLMProvider):
    """Fake provider scripting outcomes per requested model."""

    def __init__(
        self,
        *,
        complete_outcomes: dict[str, CompletionResponse | LLMError] | None = None,
        stream_scripts: dict[str, tuple[StreamEvent, ...] | StreamFailure | MidStreamFailure]
        | None = None,
    ) -> None:
        self.complete_outcomes = complete_outcomes or {}
        self.stream_scripts = stream_scripts or {}
        self.complete_calls: list[str | None] = []
        self.stream_calls: list[str | None] = []
        self.complete_requests: list[CompletionRequest] = []
        self.stream_requests: list[CompletionRequest] = []
        self.closed = False

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.complete_calls.append(request.model)
        self.complete_requests.append(request)
        outcome = self.complete_outcomes.get(request.model, DEFAULT_RESPONSE)
        if isinstance(outcome, LLMError):
            raise outcome
        return outcome

    def stream(self, request: CompletionRequest):
        self.stream_calls.append(request.model)
        self.stream_requests.append(request)
        return self._run_stream(self.stream_scripts.get(request.model))

    def _run_stream(self, script):  # noqa: ANN202 - generator helper
        if isinstance(script, StreamFailure):
            raise script.error
        if isinstance(script, MidStreamFailure):
            yield from script.prefix
            raise script.error
        yield from DEFAULT_EVENTS if script is None else script

    def close(self) -> None:
        self.closed = True


def make_request(**kwargs: object) -> CompletionRequest:
    defaults: dict[str, object] = {"messages": (Message(role="user", content="Hi"),)}
    defaults.update(kwargs)
    return CompletionRequest(**defaults)  # type: ignore[arg-type]


def consume(events) -> list[StreamEvent]:  # noqa: ANN001 - test helper
    return list(events)


class ConstructionTests(SimpleTestCase):
    """Constructor validation and chain normalization."""

    def test_empty_model_chain_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            FallbackProvider(provider=ScriptedProvider(), models=[])

    def test_blank_model_names_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            FallbackProvider(provider=ScriptedProvider(), models=["vendor/a", "   "])
        with self.assertRaises(ValueError):
            FallbackProvider(provider=ScriptedProvider(), models=[""])

    def test_models_are_stripped_and_order_preserved(self) -> None:
        fallback = FallbackProvider(provider=ScriptedProvider(), models=[" vendor/a ", MODEL_B])

        self.assertEqual(fallback.models, (MODEL_A, MODEL_B))
        self.assertEqual(fallback.primary_model, MODEL_A)


class CompleteFallbackTests(SimpleTestCase):
    """Non-streaming fallback semantics."""

    def test_primary_success_returns_response_without_extra_attempts(self) -> None:
        inner = ScriptedProvider(complete_outcomes={MODEL_A: RESPONSE_A})
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        response = fallback.complete(make_request())

        self.assertEqual(response, RESPONSE_A)
        self.assertEqual(inner.complete_calls, [MODEL_A])

    def test_retryable_primary_failure_invokes_fallback(self) -> None:
        inner = ScriptedProvider(
            complete_outcomes={
                MODEL_A: LLMAvailabilityError("upstream overloaded"),
                MODEL_B: RESPONSE_B,
            }
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        response = fallback.complete(make_request())

        self.assertEqual(response, RESPONSE_B)
        self.assertEqual(inner.complete_calls, [MODEL_A, MODEL_B])

    def test_each_retryable_error_class_triggers_fallback(self) -> None:
        for error in (
            LLMRequestError("connection reset"),
            LLMTimeoutError("too slow"),
            LLMAvailabilityError("capacity"),
        ):
            with self.subTest(error=type(error).__name__):
                inner = ScriptedProvider(complete_outcomes={MODEL_A: error, MODEL_B: RESPONSE_B})
                fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

                self.assertEqual(fallback.complete(make_request()), RESPONSE_B)
                self.assertEqual(inner.complete_calls, [MODEL_A, MODEL_B])

    def test_fallback_follows_configured_order_across_three_models(self) -> None:
        inner = ScriptedProvider(
            complete_outcomes={
                MODEL_A: LLMAvailabilityError("down"),
                MODEL_B: LLMTimeoutError("timed out"),
                MODEL_C: RESPONSE_C,
            }
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B, MODEL_C])

        response = fallback.complete(make_request())

        self.assertEqual(response, RESPONSE_C)
        self.assertEqual(inner.complete_calls, [MODEL_A, MODEL_B, MODEL_C])

    def test_non_retryable_errors_abort_immediately_without_fallback(self) -> None:
        for error in (
            LLMBadRequestError("invalid payload"),
            LLMAuthenticationError("bad key"),
            LLMResponseError("garbage body"),
            LLMError("unknown permanent failure"),
        ):
            with self.subTest(error=type(error).__name__):
                inner = ScriptedProvider(complete_outcomes={MODEL_A: error})
                fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

                with self.assertRaises(type(error)) as ctx:
                    fallback.complete(make_request())

                self.assertIs(ctx.exception, error)
                self.assertEqual(inner.complete_calls, [MODEL_A])

    def test_all_models_failing_returns_normalized_availability_error(self) -> None:
        inner = ScriptedProvider(
            complete_outcomes={
                MODEL_A: LLMAvailabilityError("a is down"),
                MODEL_B: LLMTimeoutError("b timed out"),
                MODEL_C: LLMRequestError("c unreachable"),
            }
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B, MODEL_C])

        with self.assertRaises(LLMAvailabilityError) as ctx:
            fallback.complete(make_request())

        self.assertTrue(ctx.exception.retryable)
        message = ctx.exception.message
        for fragment in ("vendor/a: a is down", "vendor/b: b timed out", "vendor/c: c unreachable"):
            self.assertIn(fragment, message)
        self.assertIsInstance(ctx.exception.__cause__, LLMRequestError)

    def test_single_model_chain_failure_is_still_normalized(self) -> None:
        inner = ScriptedProvider(complete_outcomes={MODEL_A: LLMAvailabilityError("only one")})
        fallback = FallbackProvider(provider=inner, models=[MODEL_A])

        with self.assertRaises(LLMAvailabilityError):
            fallback.complete(make_request())

    def test_request_shape_is_preserved_on_fallback_attempts(self) -> None:
        messages = (Message(role="system", content="Be brief."), Message(role="user", content="Hi"))
        request = make_request(messages=messages, temperature=0.7)
        inner = ScriptedProvider(
            complete_outcomes={MODEL_A: LLMAvailabilityError("down"), MODEL_B: RESPONSE_B}
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        fallback.complete(request)

        self.assertEqual(len(inner.complete_requests), 2)
        first, second = inner.complete_requests
        self.assertEqual(first.messages, messages)
        self.assertEqual(first.temperature, 0.7)
        self.assertEqual(second.model, MODEL_B)
        self.assertEqual(second.messages, messages)
        self.assertEqual(second.temperature, 0.7)

    def test_explicit_model_pin_bypasses_the_chain(self) -> None:
        inner = ScriptedProvider(complete_outcomes={MODEL_B: LLMAvailabilityError("pinned failed")})
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        with self.assertRaises(LLMAvailabilityError):
            fallback.complete(make_request(model=MODEL_B))

        self.assertEqual(inner.complete_calls, [MODEL_B])

    def test_explicit_model_pin_with_success_works(self) -> None:
        inner = ScriptedProvider(complete_outcomes={MODEL_C: RESPONSE_C})
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        response = fallback.complete(make_request(model=MODEL_C))  # type: ignore[arg-type]

        self.assertEqual(response.text, "From C")


class StreamFallbackTests(SimpleTestCase):
    """Streaming fallback semantics."""

    def test_primary_stream_success_passes_events_through(self) -> None:
        primary_events = (StreamStart(model="served/a"), StreamDelta(text="Hey"))
        inner = ScriptedProvider(stream_scripts={MODEL_A: primary_events})
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        self.assertEqual(consume(fallback.stream(make_request())), list(primary_events))
        self.assertEqual(inner.stream_calls, [MODEL_A])

    def test_probe_failure_on_primary_falls_back_to_next_stream(self) -> None:
        inner = ScriptedProvider(
            stream_scripts={
                MODEL_A: StreamFailure(LLMAvailabilityError("a overloaded")),
                MODEL_B: EVENTS_B,
            }
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        events = consume(fallback.stream(make_request()))

        self.assertEqual(events, list(EVENTS_B))
        self.assertEqual(events[0].model, "served/b")
        self.assertEqual(inner.stream_calls, [MODEL_A, MODEL_B])

    def test_mid_stream_failure_propagates_without_fallback(self) -> None:
        failure = LLMAvailabilityError("mid-stream collapse")
        prefix = (StreamStart(model="served/a"), StreamDelta(text="Par"))
        inner = ScriptedProvider(
            stream_scripts={MODEL_A: MidStreamFailure(prefix=prefix, error=failure)}
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])
        received: list[StreamEvent] = []

        with self.assertRaises(LLMAvailabilityError) as ctx:
            for event in fallback.stream(make_request()):
                received.append(event)

        self.assertIs(ctx.exception, failure)
        self.assertEqual(received, list(prefix))
        self.assertEqual(inner.stream_calls, [MODEL_A])

    def test_non_retryable_probe_failure_aborts_immediately(self) -> None:
        inner = ScriptedProvider(
            stream_scripts={MODEL_A: StreamFailure(LLMBadRequestError("bad model"))}
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        with self.assertRaises(LLMBadRequestError):
            consume(fallback.stream(make_request()))

        self.assertEqual(inner.stream_calls, [MODEL_A])

    def test_stream_all_models_failing_raises_aggregate_error(self) -> None:
        inner = ScriptedProvider(
            stream_scripts={
                MODEL_A: StreamFailure(LLMAvailabilityError("a down")),
                MODEL_B: StreamFailure(LLMTimeoutError("b slow")),
            }
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        with self.assertRaises(LLMAvailabilityError) as ctx:
            consume(fallback.stream(make_request()))

        self.assertTrue(ctx.exception.retryable)
        self.assertIn("vendor/a: a down", ctx.exception.message)
        self.assertIn("vendor/b: b slow", ctx.exception.message)

    def test_stream_explicit_model_pin_bypasses_the_chain(self) -> None:
        inner = ScriptedProvider(
            stream_scripts={MODEL_B: StreamFailure(LLMRequestError("pinned down"))}
        )
        fallback = FallbackProvider(provider=inner, models=[MODEL_A, MODEL_B])

        with self.assertRaises(LLMAvailabilityError) as ctx:
            consume(fallback.stream(make_request(model=MODEL_B)))

        self.assertIn("vendor/b: pinned down", ctx.exception.message)
        self.assertEqual(inner.stream_calls, [MODEL_B])


class LifecycleAndWiringTests(SimpleTestCase):
    """Resource handling and settings-driven construction."""

    def test_close_delegates_to_inner_provider(self) -> None:
        inner = ScriptedProvider()
        fallback = FallbackProvider(provider=inner, models=[MODEL_A])

        fallback.close()

        self.assertTrue(inner.closed)

    def test_close_is_safe_when_inner_has_no_close(self) -> None:
        fallback = FallbackProvider(provider=object(), models=[MODEL_A])  # type: ignore[arg-type]

        fallback.close()

    def test_context_manager_closes_inner_provider(self) -> None:
        inner = ScriptedProvider()

        with FallbackProvider(provider=inner, models=[MODEL_A]) as fallback:
            self.assertIs(fallback.provider, inner)

        self.assertTrue(inner.closed)

    def test_from_settings_builds_openrouter_chain_from_configuration(self) -> None:
        inner = Mock(spec=LLMProvider)
        config = ModelConfiguration(
            api_key="sk-test",
            base_url=DEFAULT_BASE_URL,
            timeout_seconds=30.0,
            primary_model="vendor/main",
            fallback_models=("vendor/f1", "vendor/f2"),
        )
        with (
            patch("llm.fallback.load_model_configuration", return_value=config),
            patch("llm.fallback.OpenRouterProvider", return_value=inner) as factory,
        ):
            fallback = FallbackProvider.from_settings()

        factory.assert_called_once_with(
            api_key="sk-test",
            base_url=DEFAULT_BASE_URL,
            default_model="vendor/main",
            timeout=30.0,
        )
        self.assertIs(fallback.provider, inner)
        self.assertEqual(fallback.models, ("vendor/main", "vendor/f1", "vendor/f2"))
