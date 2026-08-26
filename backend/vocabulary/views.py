"""HTTP API for saved vocabulary."""

from __future__ import annotations

from django.db import transaction
from django.http import Http404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from conversations.models import Message
from vocabulary.models import VocabularyItem
from vocabulary.serializers import VocabularyItemSerializer, VocabularySaveSerializer
from vocabulary.tasks import schedule_vocabulary_enrichment


class VocabularySaveView(APIView):
    """Save a word or phrase immediately (TASK-066).

    POST body: ``{"expression": str, "source_message_id"?: int}``. The item is
    created synchronously in ``pending`` status with only the expression and
    its source filled in — enrichment (TASK-068) happens asynchronously and
    this endpoint never waits for it. No LLM work happens here at all, so the
    response returns as fast as one insert.

    The optional source message is resolved through a user-scoped lookup
    first: a foreign or nonexistent message is an indistinguishable 404 and
    nothing is written. Its session becomes ``source_session``.

    Duplicate behavior is deterministic (the TASK-065 deferred decision):
    identity is ``(user, normalize_expression)`` with normalization being
    trim + lowercase. Saving an expression again returns 200 with the
    EXISTING row unchanged — no reset to pending, no enrichment wipe, no
    duplicate rows — while a new expression returns 201. Re-saving is never
    an error, matching the immediate-save success-toast flow.

    New items schedule their post-commit enrichment (TASK-067) inside the
    same atomic block that creates them:
    ``transaction.on_commit`` fires only after COMMIT, so a rolled-back
    transaction never enqueues anything and a committed one enqueues
    exactly one :func:`~vocabulary.tasks.enrich_vocabulary_item` job. The
    duplicate shortcut deliberately schedules nothing.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs) -> Response:
        serializer = VocabularySaveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        message = self._resolve_source(serializer.validated_data.get("source_message_id"))
        expression = serializer.validated_data["expression"]
        normalized = VocabularyItem.normalize_expression(expression)
        existing = VocabularyItem.objects.filter(
            user=request.user,
            normalized_expression=normalized,
        ).first()
        if existing is not None:
            return Response(VocabularyItemSerializer(existing).data)
        with transaction.atomic():
            item = VocabularyItem.objects.create(
                user=request.user,
                expression=expression,
                normalized_expression=normalized,
                source_message=message,
                source_session=message.session if message is not None else None,
            )
            schedule_vocabulary_enrichment(item.pk)
        return Response(VocabularyItemSerializer(item).data, status=201)

    def _resolve_source(self, message_pk: int | None) -> Message | None:
        if message_pk is None:
            return None
        try:
            return Message.objects.select_related("session").get(
                pk=message_pk,
                session__user=self.request.user,
            )
        except Message.DoesNotExist:
            raise Http404("No Message matches the given query.") from None


__all__ = ["VocabularySaveView"]
