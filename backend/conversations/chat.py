"""Application-service layer for creating user chat turns (TASK-040).

This module owns the write side of the chat flow: when a learner sends a
message the service

1. validates session ownership (foreign and nonexistent sessions are the
   same ``Session.DoesNotExist`` so callers render one indistinguishable 404),
2. stores the user message,
3. builds the LLM context for the turn
   (:class:`~conversations.context.ContextBuilder` + recent-message window +
   rolling summary), and
4. creates the assistant generation state — a ``pending`` message row the
   streaming endpoint (TASK-041) fills in and finalizes.

Both message rows are persisted inside ONE transaction together with the
context assembly: if anything fails, the conversation is left exactly as it
was — no half-written user turn, no orphaned pending row. Summary
maintenance is enqueued only after commit via
:func:`conversations.tasks.schedule_session_summary_update`, so a rolled-back
turn never queues background work for rows that do not exist.

Failure semantics for later stages live elsewhere by design: a provider
failure during streaming marks the pending row ``failed`` (retryable per the
MVP retry rule) while the already-committed user message and history remain
intact.

Message text is never logged.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from django.db import transaction

from conversations.context import ContextBuilder
from conversations.models import Message, Session
from conversations.tasks import schedule_session_summary_update
from conversations.topics import GeneratedTopic
from conversations.window import select_recent_messages
from llm.types import CompletionRequest

logger = logging.getLogger("conversations.chat")


@dataclass(frozen=True)
class PreparedTurn:
    """Everything needed to continue one chat turn after creation.

    ``assistant_message`` starts in the ``pending`` generation state; the
    streaming endpoint persists its final content onto this exact row.
    """

    user_message: Message
    assistant_message: Message
    request: CompletionRequest


class UserMessageService:
    """Create user turns plus their assistant generation slots, atomically."""

    def __init__(self, context_builder: ContextBuilder | None = None) -> None:
        self._context_builder = context_builder or ContextBuilder()

    def create_turn(self, *, session_id: int, user, text: str) -> PreparedTurn:
        """Store one user message and prepare its assistant generation.

        Raises ``Session.DoesNotExist`` when the session does not exist or
        belongs to another user, and ``ValueError`` for blank/non-string
        text — both before anything is written. On success the user message
        (``complete``) and a fresh ``pending`` assistant row are committed
        together and the returned :class:`PreparedTurn` carries both rows
        plus the ready-to-stream :class:`CompletionRequest`.
        """
        stripped = _validate_text(text)
        began = time.monotonic()
        with transaction.atomic():
            session = Session.objects.select_for_update().get(pk=session_id, user=user)
            user_message = Message.append(session, role=Message.Role.USER, content=stripped)
            assistant_message = Message.append(session, role=Message.Role.ASSISTANT)
            request = self._build_request(session, user_message)
            transaction.on_commit(lambda: schedule_session_summary_update(session.pk))
        logger.info(
            "chat turn created session=%s user_message=%s assistant_message=%s in %.2fs",
            session.pk,
            user_message.pk,
            assistant_message.pk,
            time.monotonic() - began,
        )
        return PreparedTurn(
            user_message=user_message,
            assistant_message=assistant_message,
            request=request,
        )

    def _build_request(self, session: Session, user_message: Message) -> CompletionRequest:
        """Assemble the LLM request from persisted session state.

        History is every complete message past the summary boundary and
        before the current turn, chronological; the window selects its tail.
        """
        history = (
            session.messages.filter(
                status=Message.Status.COMPLETE,
                sequence__gt=session.summary_message_boundary,
                sequence__lt=user_message.sequence,
            )
            .order_by("sequence")
            .values_list("role", "content")
        )
        topic = GeneratedTopic(title=session.title, description=session.topic)
        return self._context_builder.build(
            level=session.learning_level,
            topic=topic,
            summary=session.summary,
            recent_messages=select_recent_messages(history),
            current_message=user_message.content,
        )


def _validate_text(text: str) -> str:
    """Reject non-string or blank input; return the stripped text."""
    if not isinstance(text, str):
        raise ValueError("text must be a string.")
    stripped = text.strip()
    if not stripped:
        raise ValueError("text must not be empty.")
    return stripped


__all__ = ["PreparedTurn", "UserMessageService"]
