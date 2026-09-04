"""HTTP API for conversation sessions."""

from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache

from django.http import Http404
from django.shortcuts import get_object_or_404
from rest_framework import generics, serializers, status
from rest_framework.exceptions import APIException
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.negotiation import ServerSentEventNegotiation
from conversations.chat import RetryService, UserMessageService, finalize_turn
from conversations.improvement import ImprovementService
from conversations.models import Message, Session
from conversations.serializers import (
    MessageSerializer,
    SessionCreateSerializer,
    SessionRenameSerializer,
    SessionSerializer,
)
from conversations.suggestions import SuggestionService
from conversations.topics import GeneratedTopic, TopicGenerationService
from conversations.window import recent_message_window, select_recent_messages
from learning.models import Profile
from llm import views as llm_views
from llm.exceptions import LLMError
from llm.fallback import FallbackProvider
from llm.sse import sse_streaming_response


class Conflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "Conflict."
    default_code = "conflict"


@lru_cache(maxsize=1)
def _settings_topic_service() -> TopicGenerationService:
    return TopicGenerationService(provider=FallbackProvider.from_settings())


def get_topic_service() -> TopicGenerationService:
    """Return the process-wide settings-driven topic service (test seam)."""
    return _settings_topic_service()


@lru_cache(maxsize=1)
def _settings_suggestion_service() -> SuggestionService:
    return SuggestionService(provider=FallbackProvider.from_settings())


def get_suggestion_service() -> SuggestionService:
    """Return the process-wide settings-driven suggestion service (test seam)."""
    return _settings_suggestion_service()


@lru_cache(maxsize=1)
def _settings_improvement_service() -> ImprovementService:
    return ImprovementService(provider=FallbackProvider.from_settings())


def get_improvement_service() -> ImprovementService:
    """Return the process-wide settings-driven improvement service (test seam)."""
    return _settings_improvement_service()


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
            raise exc
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
    content_negotiation_class = ServerSentEventNegotiation

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
    content_negotiation_class = ServerSentEventNegotiation

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
            raise Conflict(str(exc)) from None
        events = finalize_turn(
            prepared.assistant_message,
            llm_views.get_streaming_service().stream(prepared.request),
        )
        return sse_streaming_response(events)


class MessageSuggestionsView(APIView):
    """Generate three suggested replies for one selected message.

    POST without a body (TASK-059). The selected message is resolved through
    a user-scoped session lookup first, so foreign or nonexistent sessions
    and messages are indistinguishable 404s — no existence leak. Only
    COMPLETE messages carry usable content: pending or failed assistant rows
    (and any blank-content row) are a 409 Conflict rejected before any LLM
    work.

    Inputs to :class:`conversations.suggestions.SuggestionService` come from
    persisted state only — the session's learning level and topic plus every
    complete message BEFORE the selection (chronological, bounded by the
    configured recent-message window). The endpoint is read-only: nothing is
    persisted, no summary maintenance is scheduled, and suggestions are never
    stored as chat messages.

    Success body: ``{"replies": [str, str, str]}``. Provider failures map to
    503 when retryable, 502 otherwise.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs) -> Response:
        try:
            session = Session.objects.get(pk=kwargs["pk"], user=request.user)
        except Session.DoesNotExist:
            raise Http404("No Session matches the given query.") from None
        try:
            message = session.messages.get(pk=kwargs["message_pk"])
        except Message.DoesNotExist:
            raise Http404("No Message matches the given query.") from None
        if message.status != Message.Status.COMPLETE or not message.content.strip():
            raise Conflict("Suggestions require a completed, non-empty message.")
        recent_history = (
            session.messages.filter(
                status=Message.Status.COMPLETE,
                sequence__lt=message.sequence,
            )
            .order_by("-sequence")
            .values_list("role", "content")[: recent_message_window()]
        )
        try:
            suggestions = get_suggestion_service().suggest(
                level=session.learning_level,
                topic=GeneratedTopic(title=session.title, description=session.topic),
                selected_message=message.content,
                history=select_recent_messages(reversed(list(recent_history))),
            )
        except LLMError as exc:
            raise exc
        return Response({"replies": list(suggestions.replies)})


class MessageImprovementView(APIView):
    """Improve one user-authored message on explicit request (TASK-063).

    POST without a body. The target message is resolved through a user-scoped
    session lookup first, so foreign or nonexistent sessions and messages are
    indistinguishable 404s — no existence leak. Only the learner's own words
    can be corrected: assistant rows (in any generation state) and any
    blank-content row are a 409 Conflict rejected before any LLM work.

    The generated improvement is cached on the message row (fields
    ``improvement_*``): the first call runs
    :class:`conversations.improvement.ImprovementService` and persists the
    result atomically together with nothing else; every later call for the
    same message returns the stored result verbatim and makes NO provider
    call — the correction of a fixed text never changes, and repeating a
    request (double-tap, app restart, reopening the sheet) must never cost
    another generation. ``original`` in the response is composed from the
    stored row, never from a model echo.

    Success body: ``{"original": str, "improved": str, "explanation": str,
    "severity": "none"|"minor"|"critical"}``.
    Provider failures map to 503 when retryable, 502 otherwise, and leave no
    partial cache behind.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs) -> Response:
        try:
            session = Session.objects.get(pk=kwargs["pk"], user=request.user)
        except Session.DoesNotExist:
            raise Http404("No Session matches the given query.") from None
        try:
            message = session.messages.get(pk=kwargs["message_pk"])
        except Message.DoesNotExist:
            raise Http404("No Message matches the given query.") from None
        if message.role != Message.Role.USER or not message.content.strip():
            raise Conflict("Improvement requires a non-empty user message.")
        if message.improvement_severity:
            return Response(
                {
                    "original": message.content.strip(),
                    "improved": message.improvement_content,
                    "explanation": message.improvement_explanation,
                    "severity": message.improvement_severity,
                }
            )
        try:
            improvement = get_improvement_service().improve(
                level=session.learning_level,
                original_message=message.content,
            )
        except LLMError as exc:
            raise exc
        message.improvement_content = improvement.improved
        message.improvement_explanation = improvement.explanation
        message.improvement_severity = improvement.severity
        message.save(
            update_fields=[
                "improvement_content",
                "improvement_explanation",
                "improvement_severity",
            ]
        )
        return Response(asdict(improvement))


__all__ = [
    "ChatMessageSerializer",
    "MessageImprovementView",
    "MessageListView",
    "MessageRetryView",
    "MessageStreamView",
    "MessageSuggestionsView",
    "SessionCollectionView",
    "SessionDetailView",
    "get_improvement_service",
    "get_retry_service",
    "get_suggestion_service",
    "get_topic_service",
    "get_user_message_service",
]
