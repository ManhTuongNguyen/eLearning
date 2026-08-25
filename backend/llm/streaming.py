"""Application-service-layer streaming on top of any :class:`LLMProvider`.

While providers signal success by simply exhausting their iterator and
failures by raising ``LLMError`` mid-iteration, application consumers need a
stronger contract: every consumed stream must end with exactly one terminal
event stating whether the assistant message is complete.

:class:`StreamingCompletionService` provides that contract. For each
``stream()`` call it yields

1. exactly one :class:`~llm.types.StreamStart`,
2. zero or more :class:`~llm.types.StreamDelta` events,
3. exactly one terminal event: :class:`~llm.types.StreamCompleted` when the
   provider finished normally (carrying the full accumulated text), or
   :class:`~llm.types.StreamFailed` when the provider raised a normalized
   ``LLMError`` (carrying the error plus any partial text).

Provider contract violations (missing/duplicate start, delta before start,
unknown event types, streams that end without any event) are normalized into
``StreamFailed`` wrapping an :class:`~llm.exceptions.LLMResponseError`. A
consumer must therefore persist a complete assistant message only upon
receiving ``StreamCompleted`` — a failed or abandoned stream never is.
Unexpected non-``LLMError`` exceptions are programming bugs and propagate
unchanged instead of being masked as stream failures.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator

from llm.exceptions import LLMError, LLMResponseError
from llm.provider import LLMProvider
from llm.types import (
    CompletionRequest,
    StreamCompleted,
    StreamDelta,
    StreamFailed,
    StreamingEvent,
    StreamStart,
)

logger = logging.getLogger("llm.streaming")


class StreamingCompletionService:
    """Normalize one provider stream into a total, terminal-event protocol."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def close(self) -> None:
        """Close the wrapped provider when it supports closing."""
        closer = getattr(self.provider, "close", None)
        if callable(closer):
            closer()

    def __enter__(self) -> StreamingCompletionService:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def stream(self, request: CompletionRequest) -> Iterator[StreamingEvent]:
        """Yield normalized events terminating in Completed or Failed."""
        began = time.monotonic()
        chunks: list[str] = []
        started: StreamStart | None = None
        failure: LLMError | None = None
        try:
            for event in self.provider.stream(request):
                if isinstance(event, StreamStart):
                    if started is not None:
                        raise LLMResponseError(
                            "Provider emitted a second stream start.",
                            provider="streaming",
                            model=started.model,
                        )
                    started = event
                elif isinstance(event, StreamDelta):
                    if started is None:
                        raise LLMResponseError(
                            "Provider emitted a delta before the stream start.",
                            provider="streaming",
                        )
                    chunks.append(event.text)
                else:
                    raise LLMResponseError(
                        f"Provider emitted unknown stream event type {type(event).__name__}.",
                        provider="streaming",
                        model=started.model if started else None,
                    )
                yield event
        except LLMError as exc:
            failure = exc
        if failure is not None:
            partial = "".join(chunks)
            logger.warning(
                "stream failed after %.2fs with %d char(s) delivered: %s",
                time.monotonic() - began,
                len(partial),
                failure,
            )
            yield StreamFailed(error=failure, text=partial)
            return
        if started is None:
            exhausted = LLMResponseError(
                "Provider stream ended before emitting any event.",
                provider="streaming",
            )
            logger.warning("stream failed after %.2fs without any event", time.monotonic() - began)
            yield StreamFailed(error=exhausted)
            return
        text = "".join(chunks)
        logger.info(
            "stream completed model=%s chars=%d deltas=%d in %.2fs",
            started.model,
            len(text),
            len(chunks),
            time.monotonic() - began,
        )
        yield StreamCompleted(text=text, model=started.model, delta_count=len(chunks))


__all__ = ["StreamingCompletionService"]
