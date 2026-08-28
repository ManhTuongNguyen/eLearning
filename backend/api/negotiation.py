"""Content negotiation for endpoints served outside DRF's renderer contract.

DRF's default negotiation rejects any ``Accept`` media type that no registered
renderer declares with an HTTP 406 in ``APIView.initial()`` — before
authentication and before the view handler runs. Some endpoints answer
successful requests with a plain Django response instead of a DRF ``Response``
(SSE streams carry ``llm.sse.CONTENT_TYPE``; the vocabulary CSV export carries
``text/csv``), so for them negotiation only has to *not reject* the requested
media type and to select a renderer for the JSON error responses.

This module provides those narrow overrides. They are applied per-view via
``content_negotiation_class``, so global negotiation is untouched:

- ``Accept: text/event-stream`` (stream views) and ``Accept: text/csv``
  (vocabulary export) are accepted; the renderer selected is JSON so that
  error responses keep the standard JSON error body the mobile client parses
  (see ``mobile/src/api/chatStream.ts`` and ``mobile/src/api/vocabulary.ts``).
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
CSV_MEDIA_TYPE = "text/csv"
JSON_MEDIA_TYPE = "application/json"


class JsonFallbackNegotiation(DefaultContentNegotiation):
    """Default negotiation extended with one extra plain-response media type.

    Base class for views that answer successful requests with a plain Django
    response outside DRF's renderer contract. Subclasses set
    :attr:`extra_media_type` to the media type their success responses carry.
    Errors stay DRF ``Response`` objects and are rendered as JSON, preserving
    the API-wide error contract.
    """

    extra_media_type: str

    def select_renderer(self, request, renderers, format_suffix=None):
        """Select a renderer, treating the extra media type as acceptable.

        Falls back to the JSON renderer when the default negotiation finds no
        match but the client explicitly accepts :attr:`extra_media_type`.
        Raises :class:`~rest_framework.exceptions.NotAcceptable` otherwise.
        """
        try:
            return super().select_renderer(request, renderers, format_suffix)
        except exceptions.NotAcceptable:
            for media_type_set in order_by_precedence(self.get_accept_list(request)):
                for media_type in media_type_set:
                    if media_type_matches(self.extra_media_type, media_type):
                        json_renderer = _json_renderer(renderers)
                        if json_renderer is not None:
                            return json_renderer, json_renderer.media_type
            raise


class ServerSentEventNegotiation(JsonFallbackNegotiation):
    """Default negotiation extended with acceptance of ``text/event-stream``.

    Use on views that answer successful requests with a plain SSE
    ``StreamingHttpResponse``.
    """

    extra_media_type = SSE_MEDIA_TYPE


class CsvNegotiation(JsonFallbackNegotiation):
    """Default negotiation extended with acceptance of ``text/csv``.

    Use on views that answer successful requests with a plain
    ``HttpResponse`` carrying ``text/csv`` (the vocabulary CSV export).
    """

    extra_media_type = CSV_MEDIA_TYPE


def _json_renderer(renderers):
    """Return the registered ``application/json`` renderer, if any."""
    for renderer in renderers:
        if media_type_matches(JSON_MEDIA_TYPE, renderer.media_type):
            return renderer
    return None


__all__ = [
    "CSV_MEDIA_TYPE",
    "CsvNegotiation",
    "SSE_MEDIA_TYPE",
    "ServerSentEventNegotiation",
]
