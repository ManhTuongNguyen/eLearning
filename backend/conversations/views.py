"""HTTP API for conversation sessions."""

from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache

from django.http import Http404
from django.shortcuts import get_object_or_404
from rest_framework import generics, serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from conversations.chat import RetryService, UserMessageService, finalize_turn
from conversations.models import Message, Session
from conversations.serializers import (
    MessageSerializer,
    SessionCreateSerializer,
    SessionRenameSerializer,
    SessionSerializer,
)
from conversations.topics import TopicGenerationService
from learning.models import Profile
from llm import views as llm_views
from llm.exceptions import LLMError
from llm.fallback import FallbackProvider
from llm.sse import sse_streaming_response


@lru_cache(maxsize=1)
def _settings_topic_service() -> TopicGenerationService:
    return TopicGenerationService(provider=FallbackProvider.from_settings())


def get_topic_service() -> TopicGenerationService:
    """Return the process-wide settings-driven topic service (test seam)."""
    return _settings_topic_service()


@lru_cache(maxsize=1)
def _settings_user_message_service() -> UserMessageService:
    return UserMessageService()


def get_user_message_service() -> UserMessageService:
    """Return the process-wide user-message service (test seam)."""
    return _settings_user_message_service()


@lru_cache(maxsize=1)
def _settings_retry_service() -> RetryService:
    return RetryService()


def get_retry_service() -> RetryService:
    """Return the process-wide retry service (test seam)."""
    return _settings_retry_service()


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


class SessionDetailView(generics.RetrieveDestroyAPIView):
    """Retrieve, rename and delete a single conversation session.

    The queryset is scoped to ``request.user``, so another user's session —
    or any nonexistent id — resolves to the same 404 without leaking
    existence, for GET, PATCH and DELETE alike.

    PATCH body: ``{"title": str}`` (required, non-blank after stripping).
    Only the title can change: the rename serializer declares no other
    fields, so any additional payload keys are silently ignored. The response
    is the full session representation, matching GET.

    DELETE removes the session; its messages go with it through the
    message FK's cascade. Success is an empty 204 response.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = SessionSerializer

    def get_queryset(self):
        return Session.objects.filter(user=self.request.user)

    def patch(self, request, *args, **kwargs) -> Response:
        session = self.get_object()
        serializer = SessionRenameSerializer(session, data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(SessionSerializer(session).data)


class MessageListView(generics.ListAPIView):
    """List the messages of one of the authenticated user's sessions.

    Ownership is enforced by resolving the session through a user-scoped
    lookup first: foreign or missing sessions return 404 before any message
    is serialized. Messages come back in deterministic sequence order (the
    model's default ordering), paginated via the global DRF settings.
    """

    permission_classes = [IsAuthenticated]
    serializer_class = MessageSerializer

    def get_queryset(self):
        session = get_object_or_404(
            Session,
            pk=self.kwargs["pk"],
            user=self.request.user,
        )
        return session.messages.all()


class ChatMessageSerializer(serializers.Serializer):
    """Validates the POST body of the chat streaming endpoint.

    The only accepted field is ``text``; it is stripped and must not be blank
    after stripping, so invalid input is rejected with a 400 before anything
    is written. No model/temperature overrides exist — the context request
    assembled by :class:`conversations.chat.UserMessageService` decides what
    is sent to the LLM.
    """

    text = serializers.CharField()

    def validate_text(self, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("text must not be empty.")
        return stripped


class MessageStreamView(APIView):
    """Stream one chat turn as Server-Sent Events.

    POST body: ``{"text": str}``. The flow:

    1. Store the user message plus its pending assistant row atomically and
       build the turn's LLM context (``UserMessageService.create_turn``).
    2. Start the LLM stream for that context.
    3. Forward the normalized events through the SSE transport; text chunks
       reach the client incrementally.
    4. Persist the outcome onto the pending assistant row before the terminal
       frame is emitted (``finalize_turn``): complete on success, failed
       (retryable) on provider failure.

    Foreign or nonexistent sessions are an indistinguishable 404 — no
    existence leak. Provider failures do not corrupt the conversation: the
    user message stays committed and the failed assistant row can be retried
    later (TASK-042).
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs) -> object:
        serializer = ChatMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            prepared = get_user_message_service().create_turn(
                session_id=kwargs["pk"],
                user=request.user,
                text=serializer.validated_data["text"],
            )
        except Session.DoesNotExist:
            raise Http404("No Session matches the given query.") from None
        events = finalize_turn(
            prepared.assistant_message,
            llm_views.get_streaming_service().stream(prepared.request),
        )
        return sse_streaming_response(events)


class MessageRetryView(APIView):
    """Retry one failed assistant generation, streaming the new attempt.

    POST without a body. The flow mirrors :class:`MessageStreamView`, but no
    message is created: ``RetryService.prepare_retry`` re-arms the FAILED
    assistant row in place (back to ``pending``, blank content) and rebuilds
    the original turn's LLM request from the unchanged user prompt, then
    ``finalize_turn`` persists the outcome onto that same row — complete on
    success, failed (retryable again) on provider failure.

    Rules enforced by the service under a row lock:

    - Only assistant rows in the ``failed`` state are retryable; targeting a
      successful, pending, or user message is a 409 Conflict.
    - Foreign or nonexistent sessions and messages are indistinguishable
      404s — no existence leak.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs) -> object:
        try:
            prepared = get_retry_service().prepare_retry(
                session_id=kwargs["pk"],
                message_id=kwargs["message_pk"],
                user=request.user,
            )
        except Session.DoesNotExist:
            raise Http404("No Session matches the given query.") from None
        except Message.DoesNotExist:
            raise Http404("No Message matches the given query.") from None
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        events = finalize_turn(
            prepared.assistant_message,
            llm_views.get_streaming_service().stream(prepared.request),
        )
        return sse_streaming_response(events)


__all__ = [
    "ChatMessageSerializer",
    "MessageListView",
    "MessageRetryView",
    "MessageStreamView",
    "SessionCollectionView",
    "SessionDetailView",
    "get_retry_service",
    "get_topic_service",
    "get_user_message_service",
]
