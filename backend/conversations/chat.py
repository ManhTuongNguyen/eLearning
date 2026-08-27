"""Application-service layer for creating and retrying chat turns.

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

:class:`~conversations.chat.RetryService` (TASK-042) replays step 2–4 for a
FAILED assistant row only: the row is reset in place (same primary key, same
sequence position), the original user message is reused verbatim, and the
context is rebuilt exactly as it was for the interrupted turn.

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
from collections.abc import Iterator
from dataclasses import dataclass

from django.db import transaction

from conversations.context import ContextBuilder
from conversations.models import Message, Session
from conversations.tasks import schedule_session_summary_update
from conversations.topics import GeneratedTopic
from conversations.window import recent_message_window, select_recent_messages
from llm.types import CompletionRequest, StreamCompleted, StreamFailed, StreamingEvent

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
            request = _build_turn_request(
                self._context_builder,
                session,
                before_sequence=user_message.sequence,
                current_text=user_message.content,
            )
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


def _build_turn_request(
    context_builder: ContextBuilder,
    session: Session,
    *,
    before_sequence: int,
    current_text: str,
) -> CompletionRequest:
    """Assemble the LLM request for one turn from persisted session state.

    History is every complete message past the summary boundary and before
    ``before_sequence``. Only the configured recent-message window is fetched
    from the database — the queryset is bounded in SQL (reverse-order
    ``LIMIT``) so long conversations never transfer more rows than the
    window holds; :func:`~conversations.window.select_recent_messages` then
    re-applies the window contract to the chronological re-ordered tail.
    ``current_text`` becomes the final user message.
    """
    window = recent_message_window()
    recent_history = (
        session.messages.filter(
            status=Message.Status.COMPLETE,
            sequence__gt=session.summary_message_boundary,
            sequence__lt=before_sequence,
        )
        .order_by("-sequence")
        .values_list("role", "content")[:window]
    )
    topic = GeneratedTopic(title=session.title, description=session.topic)
    return context_builder.build(
        level=session.learning_level,
        topic=topic,
        summary=session.summary,
        recent_messages=select_recent_messages(reversed(list(recent_history))),
        current_message=current_text,
    )


class RetryService:
    """Re-run one failed assistant generation in place.

    The failed row is reset to ``pending`` (same primary key, same sequence
    position) instead of being replaced by a new message, so retrying never
    duplicates the user prompt and never reorders the conversation. The row
    lock plus the session-level ``select_for_update`` serialize concurrent
    retries: a second caller re-reads the row after the first one committed
    and finds it no longer failed.
    """

    def __init__(self, context_builder: ContextBuilder | None = None) -> None:
        self._context_builder = context_builder or ContextBuilder()

    def prepare_retry(self, *, session_id: int, message_id: int, user) -> PreparedTurn:
        """Validate and arm a retry of one failed assistant message.

        Raises ``Session.DoesNotExist`` when the session does not exist or
        belongs to another user, ``Message.DoesNotExist`` when the message
        does not exist or belongs to another session (both indistinguishable
        404s upstream), and ``ValueError`` when the target is not a failed
        assistant message — successful, pending, and user messages are not
        retryable through this MVP flow. On success the row is committed as
        ``pending`` again and the returned :class:`PreparedTurn` carries the
        original user message, the reset assistant row, and the rebuilt
        :class:`CompletionRequest`.
        """
        began = time.monotonic()
        with transaction.atomic():
            session = Session.objects.select_for_update().get(pk=session_id, user=user)
            assistant_message = session.messages.select_for_update().get(pk=message_id)
            user_message = self._validate_retryable(session, assistant_message)
            assistant_message.status = Message.Status.PENDING
            assistant_message.content = ""
            assistant_message.save(update_fields=["status", "content"])
            request = _build_turn_request(
                self._context_builder,
                session,
                before_sequence=user_message.sequence,
                current_text=user_message.content,
            )
            transaction.on_commit(lambda: schedule_session_summary_update(session.pk))
        logger.info(
            "chat retry prepared session=%s user_message=%s assistant_message=%s in %.2fs",
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

    @staticmethod
    def _validate_retryable(session: Session, message: Message) -> Message:
        """Return the user message that prompted ``message`` or raise ValueError."""
        if not message.is_retryable:
            raise ValueError("Only failed assistant messages can be retried.")
        user_message = (
            session.messages.filter(role=Message.Role.USER, sequence__lt=message.sequence)
            .order_by("-sequence")
            .first()
        )
        if user_message is None:
            raise ValueError("Failed assistant message has no user message to retry.")
        return user_message


def finalize_turn(
    assistant_message: Message,
    events: Iterator[StreamingEvent],
) -> Iterator[StreamingEvent]:
    """Wrap a stream event iterator, persisting the outcome onto the pending row.

    Every upstream event is yielded verbatim so clients receive text chunks
    incrementally. When the terminal event arrives, the pending assistant row
    created by :meth:`UserMessageService.create_turn` is updated FIRST and
    only then yielded downstream — a client observing ``completed`` can rely
    on the full message already being committed:

    - ``StreamCompleted`` fills the content and marks the row ``complete``.
    - ``StreamFailed`` marks the row ``failed`` (retryable per the MVP retry
      rule); partial output is never persisted as a complete message and the
      already-committed user message plus history stay untouched.
    - An abandoned stream (client disconnect, consumer stops early) leaves
      the row ``pending``; nothing is written for events never consumed.
    """
    for event in events:
        if isinstance(event, StreamCompleted):
            assistant_message.content = event.text
            assistant_message.status = Message.Status.COMPLETE
            assistant_message.save(update_fields=["content", "status"])
            logger.info(
                "assistant message %s completed (%d char(s))",
                assistant_message.pk,
                len(event.text),
            )
        elif isinstance(event, StreamFailed):
            assistant_message.status = Message.Status.FAILED
            assistant_message.save(update_fields=["status"])
            logger.warning(
                "assistant message %s failed (retryable): %s",
                assistant_message.pk,
                event.error,
            )
        yield event


def _validate_text(text: str) -> str:
    """Reject non-string or blank input; return the stripped text."""
    if not isinstance(text, str):
        raise ValueError("text must be a string.")
    stripped = text.strip()
    if not stripped:
        raise ValueError("text must not be empty.")
    return stripped


__all__ = ["PreparedTurn", "RetryService", "UserMessageService", "finalize_turn"]
