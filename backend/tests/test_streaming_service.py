"""Tests for the application-service streaming layer (llm.streaming)."""

from dataclasses import FrozenInstanceError

from django.test import SimpleTestCase

from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.streaming import StreamingCompletionService
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    Message,
    StreamCompleted,
    StreamDelta,
    StreamEvent,
    StreamFailed,
    StreamingEvent,
    StreamStart,
)

SERVED_MODEL = "served/a"

REQUEST = CompletionRequest(messages=(Message(role="user", content="Hi"),))


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
        self.produced: list[object] = []
        self.closed = False

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        raise AssertionError("streaming service tests never call complete()")

    def stream(self, request: CompletionRequest):
        self.stream_requests.append(request)
        return self._run()

    def _run(self):
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

    def close(self) -> None:
        self.closed = True


def make_service(script: object) -> tuple[StreamingCompletionService, ScriptedProvider]:
    provider = ScriptedProvider(script=script)
    return StreamingCompletionService(provider=provider), provider


def terminal_events(events: list[StreamingEvent]) -> list[StreamingEvent]:
    return [event for event in events if isinstance(event, (StreamCompleted, StreamFailed))]


class TerminalEventTypeTests(SimpleTestCase):
    """Shape of the service-level event vocabulary."""

    def test_terminal_events_are_frozen(self) -> None:
        completed = StreamCompleted(text="done", model=SERVED_MODEL, delta_count=2)
        failed = StreamFailed(error=LLMError("boom"), text="par")

        for event in (completed, failed):
            with self.subTest(event=type(event).__name__):
                with self.assertRaises(FrozenInstanceError):
                    event.text = "mutated"  # type: ignore[misc]

    def test_stream_failed_defaults_to_empty_partial_text(self) -> None:
        failed = StreamFailed(error=LLMError("boom"))

        self.assertEqual(failed.text, "")

    def test_streaming_event_union_accepts_all_four_event_types(self) -> None:
        events: list[StreamingEvent] = [
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="hi"),
            StreamCompleted(text="hi", model=SERVED_MODEL, delta_count=1),
            StreamFailed(error=LLMResponseError("bad")),
        ]

        for event in events:
            with self.subTest(event=type(event).__name__):
                self.assertIsInstance(event, StreamingEvent)


class HappyPathTests(SimpleTestCase):
    """Successful streams terminate with exactly one StreamCompleted."""

    def test_full_stream_passes_events_through_and_completes_with_joined_text(self) -> None:
        start = StreamStart(model=SERVED_MODEL)
        delta_one = StreamDelta(text="Hello")
        delta_two = StreamDelta(text=", world!")
        service, _ = make_service((start, delta_one, delta_two))

        events = list(service.stream(REQUEST))

        self.assertIs(events[0], start)
        self.assertIs(events[1], delta_one)
        self.assertIs(events[2], delta_two)
        terminals = terminal_events(events)
        self.assertEqual(len(terminals), 1)
        self.assertEqual(
            terminals[0],
            StreamCompleted(text="Hello, world!", model=SERVED_MODEL, delta_count=2),
        )

    def test_completed_model_is_the_server_served_model_not_the_requested_pin(self) -> None:
        service, _ = make_service((StreamStart(model="other/b"), StreamDelta(text="hey")))

        events = list(
            service.stream(CompletionRequest(messages=REQUEST.messages, model="pinned/a"))
        )

        completed = terminal_events(events)[0]
        assert isinstance(completed, StreamCompleted)
        self.assertEqual(completed.model, "other/b")

    def test_zero_delta_stream_is_still_a_complete_message(self) -> None:
        service, _ = make_service((StreamStart(model=SERVED_MODEL),))

        events = list(service.stream(REQUEST))

        self.assertEqual(terminal_events(events), [StreamCompleted(text="", model=SERVED_MODEL)])

    def test_request_is_forwarded_untouched_to_the_provider(self) -> None:
        service, provider = make_service((StreamStart(model=SERVED_MODEL),))

        list(service.stream(REQUEST))

        self.assertEqual(provider.stream_requests, [REQUEST])


class ProviderFailureTests(SimpleTestCase):
    """Every LLMError terminates as StreamFailed carrying partial output."""

    def test_pre_stream_failure_emits_single_failed_event_without_text(self) -> None:
        error = LLMAuthenticationError("bad key")
        service, _ = make_service(error)

        events = list(service.stream(REQUEST))

        self.assertEqual(len(events), 1)
        failed = events[0]
        assert isinstance(failed, StreamFailed)
        self.assertIs(failed.error, error)
        self.assertEqual(failed.text, "")
        self.assertFalse(failed.error.retryable)

    def test_mid_stream_failure_preserves_deltas_and_partial_text(self) -> None:
        error = LLMAvailabilityError("mid-stream collapse")
        delivered = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="Par"),
            StreamDelta(text="tial"),
        )
        service, _ = make_service(MidStreamFailure(prefix=delivered, error=error))
        received: list[StreamingEvent] = []

        for event in service.stream(REQUEST):
            received.append(event)

        terminals = terminal_events(received)
        self.assertEqual(len(terminals), 1)
        failed = terminals[0]
        assert isinstance(failed, StreamFailed)
        self.assertIs(failed.error, error)
        self.assertTrue(failed.error.retryable)
        self.assertEqual(failed.text, "Partial")
        self.assertEqual(received[:-1], list(delivered))


class ContractViolationTests(SimpleTestCase):
    """Malformed provider sequences normalize into LLMResponseError failures."""

    def only_terminal(self, service: StreamingCompletionService) -> StreamFailed:
        events = list(service.stream(REQUEST))
        terminals = terminal_events(events)
        self.assertEqual(len(terminals), 1)
        terminal = terminals[0]
        assert isinstance(terminal, StreamFailed)
        return terminal

    def test_stream_without_any_event_fails(self) -> None:
        service, _ = make_service(())

        events = list(service.stream(REQUEST))

        self.assertEqual(len(events), 1)
        failed = events[0]
        assert isinstance(failed, StreamFailed)
        self.assertIsInstance(failed.error, LLMResponseError)
        self.assertIn("before emitting any event", failed.error.message)

    def test_delta_before_start_fails(self) -> None:
        service, _ = make_service((StreamDelta(text="early"),))

        failed = self.only_terminal(service)

        self.assertIsInstance(failed.error, LLMResponseError)
        self.assertIn("delta before the stream start", failed.error.message)

    def test_second_start_fails(self) -> None:
        service, _ = make_service((StreamStart(model="a"), StreamStart(model="b")))

        failed = self.only_terminal(service)

        self.assertIsInstance(failed.error, LLMResponseError)
        self.assertIn("second stream start", failed.error.message)
        self.assertEqual(failed.error.model, "a")

    def test_unknown_event_type_fails_after_prior_events(self) -> None:
        start = StreamStart(model="a")
        service, _ = make_service((start, "junk"))

        events = list(service.stream(REQUEST))

        self.assertIs(events[0], start)
        failed = terminal_events(events)[0]
        assert isinstance(failed, StreamFailed)
        self.assertIn("unknown stream event type str", failed.error.message)


class IncrementalConsumptionTests(SimpleTestCase):
    """Events are pulled lazily so consumers can render chunks as they arrive."""

    def test_events_arrive_incrementally_as_the_provider_produces_them(self) -> None:
        script = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="one"),
            StreamDelta(text="two"),
        )
        service, provider = make_service(script)
        iterator = service.stream(REQUEST)

        first = next(iterator)
        self.assertIs(first, script[0])
        self.assertEqual(provider.produced, [script[0]])

        second = next(iterator)
        self.assertIs(second, script[1])
        self.assertEqual(provider.produced, [script[0], script[1]])

        third = next(iterator)
        self.assertIs(third, script[2])

        fourth = next(iterator)
        self.assertIsInstance(fourth, StreamCompleted)

    def test_abandoned_stream_never_reports_completion(self) -> None:
        script = (
            StreamStart(model=SERVED_MODEL),
            StreamDelta(text="partial"),
            StreamDelta(text=" more"),
        )
        service, _ = make_service(script)

        received = []
        for event in service.stream(REQUEST):
            received.append(event)
            if isinstance(event, StreamDelta):
                break

        self.assertEqual(
            [type(event).__name__ for event in received], ["StreamStart", "StreamDelta"]
        )
        self.assertFalse(any(isinstance(event, StreamCompleted) for event in received))


class UnexpectedExceptionTests(SimpleTestCase):
    """Non-LLMError bugs are not masked as stream failures."""

    def test_unexpected_exception_propagates_after_delivered_events(self) -> None:
        boom = ValueError("provider implementation bug")
        prefix = (StreamStart(model=SERVED_MODEL), StreamDelta(text="Par"))
        service, _ = make_service(MidStreamFailure(prefix=prefix, error=boom))
        received: list[StreamingEvent] = []

        with self.assertRaises(ValueError) as ctx:
            for event in service.stream(REQUEST):
                received.append(event)

        self.assertIs(ctx.exception, boom)
        self.assertEqual(received, list(prefix))
        self.assertEqual(terminal_events(received), [])


class LifecycleTests(SimpleTestCase):
    """Resource handling mirrors the other provider decorators."""

    def test_close_delegates_to_provider(self) -> None:
        service, provider = make_service(())

        service.close()

        self.assertTrue(provider.closed)

    def test_close_is_safe_when_provider_has_no_close(self) -> None:
        service = StreamingCompletionService(provider=object())  # type: ignore[arg-type]

        service.close()

    def test_context_manager_closes_provider(self) -> None:
        _, provider = make_service(())

        with StreamingCompletionService(provider=provider) as service:
            self.assertIs(service.provider, provider)

        self.assertTrue(provider.closed)


class LoggingHygieneTests(SimpleTestCase):
    """Logs identify outcomes without ever containing streamed text."""

    def test_success_log_names_model_but_never_payload_text(self) -> None:
        service, _ = make_service(
            (StreamStart(model=SERVED_MODEL), StreamDelta(text="SECRET-PAYLOAD"))
        )

        with self.assertLogs("llm.streaming", level="INFO") as captured:
            list(service.stream(REQUEST))

        joined = "\n".join(captured.output)
        self.assertIn(f"model={SERVED_MODEL}", joined)
        self.assertNotIn("SECRET-PAYLOAD", joined)

    def test_failure_log_contains_normalized_error_only(self) -> None:
        error = LLMAvailabilityError("upstream down")
        prefix = (StreamStart(model=SERVED_MODEL), StreamDelta(text="SECRET-PAYLOAD"))
        service, _ = make_service(MidStreamFailure(prefix=prefix, error=error))

        with self.assertLogs("llm.streaming", level="WARNING") as captured:
            list(service.stream(REQUEST))

        joined = "\n".join(captured.output)
        self.assertIn("upstream down", joined)
        self.assertNotIn("SECRET-PAYLOAD", joined)
