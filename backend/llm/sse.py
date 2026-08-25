"""Server-Sent Events transport for the application streaming protocol.

This module converts :class:`~llm.types.StreamingEvent` sequences (as
produced by :class:`llm.streaming.StreamingCompletionService`) into the
wire-level SSE format consumed by clients:

.. code-block:: text

    event: start
    data: {"model": "vendor/model"}

    event: delta
    data: {"text": "Hello"}

    event: completed
    data: {"text": "Hello", "model": "vendor/model", "delta_count": 1}

    event: error
    data: {"error": "openrouter [model]: boom", "retryable": true}

``start``, ``delta`` and ``completed`` map one-to-one onto the normalized
application events; ``error`` is the defined failure frame, emitted exactly
once as the final frame whenever the stream terminates with a
:class:`~llm.types.StreamFailed`. Every payload is a single-line JSON
document, so each frame is always an ``event`` line, a ``data`` line and a
blank separator. Frames are produced lazily so clients receive deltas as
soon as the application service yields them.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator

from django.http import StreamingHttpResponse

from llm.types import (
    StreamCompleted,
    StreamDelta,
    StreamFailed,
    StreamingEvent,
    StreamStart,
)

CONTENT_TYPE = "text/event-stream"


def encode_sse_event(event_name: str, data: dict[str, object]) -> str:
    """Encode one SSE frame: ``event`` line, single-line JSON ``data``, blank terminator."""
    return f"event: {event_name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def _frame_for(event: StreamingEvent) -> str:
    if isinstance(event, StreamStart):
        return encode_sse_event("start", {"model": event.model})
    if isinstance(event, StreamDelta):
        return encode_sse_event("delta", {"text": event.text})
    if isinstance(event, StreamCompleted):
        return encode_sse_event(
            "completed",
            {"text": event.text, "model": event.model, "delta_count": event.delta_count},
        )
    if isinstance(event, StreamFailed):
        return encode_sse_event(
            "error",
            {"error": str(event.error), "retryable": event.error.retryable},
        )
    raise TypeError(f"Unknown streaming event type {type(event).__name__}.")


def iter_sse_frames(events: Iterable[StreamingEvent]) -> Iterator[bytes]:
    """Lazily translate application events into encoded SSE frames."""
    for event in events:
        yield _frame_for(event).encode("utf-8")


def sse_streaming_response(events: Iterable[StreamingEvent]) -> StreamingHttpResponse:
    """Build a Django streaming response speaking the SSE protocol above.

    The response carries ``text/event-stream`` plus headers that keep caches
    and reverse proxies from buffering or storing the stream, and it ends as
    soon as the underlying events are exhausted (i.e. after the terminal
    ``completed``/``error`` frame).
    """
    response = StreamingHttpResponse(
        streaming_content=iter_sse_frames(events),
        content_type=CONTENT_TYPE,
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response


__all__ = ["CONTENT_TYPE", "encode_sse_event", "iter_sse_frames", "sse_streaming_response"]
