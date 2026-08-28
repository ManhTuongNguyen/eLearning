"""Content negotiation for Server-Sent Events endpoints.

DRF's default negotiation rejects ``Accept: text/event-stream`` with an
HTTP 406 before the view handler runs: ``APIView.initial()`` negotiates
before authentication, and no registered renderer declares the SSE media
type. The SSE views do not render through DRF at all — they return a plain
Django ``StreamingHttpResponse`` carrying ``llm.sse.CONTENT_TYPE`` — so for
these endpoints negotiation only has to *not reject* an SSE request and to
select a renderer for the JSON error responses.

This module provides that narrow override. It is applied per-view via
``content_negotiation_class``, so global negotiation is untouched:

- ``Accept: text/event-stream`` is accepted (the renderer selected is JSON
  so that pre-stream error responses keep the standard JSON error body the
  mobile client parses — see ``mobile/src/api/chatStream.ts``).
- ``Accept`` values that match a registered renderer keep negotiating
  exactly as before (``application/json``, ``*/*``, ...).
- Anything else (e.g. ``application/xml``) still fails with 406 — this is
  not a bypass for arbitrary media types.
"""

from __future__ import annotations

from rest_framework import exceptions
from rest_framework.negotiation import (
    DefaultContentNegotiation,
    media_type_matches,
    order_by_precedence,
)

SSE_MEDIA_TYPE = "text/event-stream"
JSON_MEDIA_TYPE = "application/json"


class ServerSentEventNegotiation(DefaultContentNegotiation):
    """Default negotiation extended with acceptance of ``text/event-stream``.

    Use on views that answer successful requests with a plain SSE
    ``StreamingHttpResponse``. Errors stay DRF ``Response`` objects and are
    rendered as JSON, preserving the API-wide error contract.
    """

    def select_renderer(self, request, renderers, format_suffix=None):
        """Select a renderer, treating a requested SSE media type as acceptable.

        Falls back to the JSON renderer when the default negotiation finds no
        match but the client explicitly accepts ``text/event-stream``.
        Raises :class:`~rest_framework.exceptions.NotAcceptable` otherwise.
        """
        try:
            return super().select_renderer(request, renderers, format_suffix)
        except exceptions.NotAcceptable:
            for media_type_set in order_by_precedence(self.get_accept_list(request)):
                for media_type in media_type_set:
                    if media_type_matches(SSE_MEDIA_TYPE, media_type):
                        json_renderer = _json_renderer(renderers)
                        if json_renderer is not None:
                            return json_renderer, json_renderer.media_type
            raise


def _json_renderer(renderers):
    """Return the registered ``application/json`` renderer, if any."""
    for renderer in renderers:
        if media_type_matches(JSON_MEDIA_TYPE, renderer.media_type):
            return renderer
    return None


__all__ = ["ServerSentEventNegotiation", "SSE_MEDIA_TYPE"]
