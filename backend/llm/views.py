"""HTTP layer exposing LLM streaming over Server-Sent Events."""

from __future__ import annotations

from collections.abc import Iterator
from functools import lru_cache

from rest_framework import serializers
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView

from api.negotiation import ServerSentEventNegotiation
from llm.fallback import FallbackProvider
from llm.sse import sse_streaming_response
from llm.streaming import StreamingCompletionService
from llm.types import VALID_ROLES, CompletionRequest, StreamingEvent


class StreamRequestSerializer(serializers.Serializer):
    """Validates the POST body of the SSE stream endpoint.

    ``messages`` maps directly onto :class:`llm.types.Message` rules;
    ``temperature`` is optional and bounded to the common 0.0–2.0 range.
    Clients cannot pin a model — the server-side chain (primary model plus
    configured fallbacks) always decides which model serves the request.
    """

    messages = serializers.ListField(
        child=serializers.DictField(allow_empty=False),
        allow_empty=False,
    )
    temperature = serializers.FloatField(required=False, min_value=0.0, max_value=2.0)

    def validate_messages(self, value: list[dict]) -> list[dict]:
        cleaned: list[dict] = []
        for index, item in enumerate(value):
            role = item.get("role")
            content = item.get("content")
            if role not in VALID_ROLES:
                raise serializers.ValidationError(
                    f"messages[{index}].role must be one of: {', '.join(sorted(VALID_ROLES))}."
                )
            if not isinstance(content, str) or not content.strip():
                raise serializers.ValidationError(
                    f"messages[{index}].content must be a non-blank string."
                )
            cleaned.append({"role": role, "content": content})
        return cleaned

    def to_completion_request(self) -> CompletionRequest:
        return CompletionRequest.from_texts(
            [(item["role"], item["content"]) for item in self.validated_data["messages"]],
            temperature=self.validated_data.get("temperature"),
        )


@lru_cache(maxsize=1)
def _settings_streaming_service() -> StreamingCompletionService:
    return StreamingCompletionService(provider=FallbackProvider.from_settings())


def get_streaming_service() -> StreamingCompletionService:
    """Return the process-wide settings-driven streaming service (test seam)."""
    return _settings_streaming_service()


class LLMStreamView(APIView):
    """Stream an LLM completion as Server-Sent Events.

    Body: ``{"messages": [{"role", "content"}, ...], "temperature"?: float}``.
    The response is a lazily generated ``text/event-stream`` whose frames map
    onto :data:`llm.types.StreamingEvent`; it terminates with exactly one
    ``completed`` (success) or ``error`` (failure) frame.
    """

    permission_classes = [IsAuthenticated]
    content_negotiation_class = ServerSentEventNegotiation

    def post(self, request) -> object:
        serializer = StreamRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        completion_request = serializer.to_completion_request()
        events: Iterator[StreamingEvent] = get_streaming_service().stream(completion_request)
        return sse_streaming_response(events)


__all__ = ["LLMStreamView", "StreamRequestSerializer", "get_streaming_service"]
