"""HTTP API for conversation sessions."""

from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache

from rest_framework import generics, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

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


class SessionCollectionView(generics.ListAPIView):
    """List and create conversation sessions for the authenticated user.

    GET returns the caller's sessions only, paginated via the global DRF
    pagination settings, most recently updated first (the model's default
    ordering).

    POST body: ``{"topic_hint"?: str}``. The learner's English level comes
    from their learning profile (provisioned on first access). The flow is:

    1. Generate a topic from level + hint.
    2. Generate the sample conversation for that topic.
    3. Persist the session.

    All LLM work happens before the single session write, so provider
    failures never leave corrupt or half-filled sessions behind.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = SessionSerializer

    def get_queryset(self):
        return Session.objects.filter(user=self.request.user)

    def post(self, request, *args, **kwargs) -> Response:
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


__all__ = ["SessionCollectionView", "get_topic_service"]
