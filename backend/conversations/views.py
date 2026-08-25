"""HTTP API for conversation sessions."""

from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from conversations.models import Session
from conversations.serializers import SessionCreateSerializer, SessionSerializer
from conversations.topics import TopicGenerationService
from learning.models import Profile
from llm.exceptions import LLMError
from llm.fallback import FallbackProvider


@lru_cache(maxsize=1)
def _settings_topic_service() -> TopicGenerationService:
    return TopicGenerationService(provider=FallbackProvider.from_settings())


def get_topic_service() -> TopicGenerationService:
    """Return the process-wide settings-driven topic service (test seam)."""
    return _settings_topic_service()


class SessionCreateView(APIView):
    """Create a conversation session for the authenticated user.

    Body: ``{"topic_hint"?: str}``. The learner's English level comes from
    their learning profile (provisioned on first access). The flow is:

    1. Generate a topic from level + hint.
    2. Generate the sample conversation for that topic.
    3. Persist the session.

    All LLM work happens before the single session write, so provider
    failures never leave corrupt or half-filled sessions behind.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request) -> Response:
        serializer = SessionCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        hint = serializer.to_hint()
        profile, _ = Profile.objects.get_or_create(user=request.user)
        service = get_topic_service()
        try:
            topic = service.generate(level=profile.level, hint=hint)
            sample = service.generate_sample(topic=topic, level=profile.level)
        except LLMError as exc:
            return self._error_response(exc)
        session = Session.objects.create(
            user=request.user,
            title=topic.title,
            topic=topic.description,
            topic_hint=hint,
            learning_level=profile.level,
        )
        data = SessionSerializer(session).data
        data["sample_conversation"] = asdict(sample)
        return Response(data, status=status.HTTP_201_CREATED)

    @staticmethod
    def _error_response(exc: LLMError) -> Response:
        code = status.HTTP_503_SERVICE_UNAVAILABLE if exc.retryable else status.HTTP_502_BAD_GATEWAY
        return Response({"detail": str(exc)}, status=code)


__all__ = ["SessionCreateView", "get_topic_service"]
