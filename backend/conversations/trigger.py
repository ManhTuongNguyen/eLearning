"""Summary-trigger decision logic and session compaction (ROADMAP section 5).

Implements the trigger half of the rolling-summary architecture:
:class:`~conversations.summarizer.ConversationSummarizer` knows HOW to fold
archived turns into a summary, this module decides WHEN — and never after
every message. Summarization is batched: it fires only once enough
unsummarized turns have accumulated beyond the recent window.

The rule is pure integer math (:func:`archive_range`): with ``W`` recent
messages kept in the window and ``B`` messages already covered by the
summary, the pending count is ``(total - W) - B``; summarization runs only
when that count reaches the configured threshold. Consequences:

- Short conversations (fewer than ``window + threshold`` messages) never
  trigger summarization.
- After a compaction the pending count resets to zero, so immediately
  repeated requests cannot re-summarize the same messages.
- Each compaction advances the persisted boundary by at least a full
  threshold-sized batch (ROADMAP's 1-40 → 1-60 example cadence).

:class:`SessionSummaryTrigger` applies the plan to a :class:`~conversations.models.Session`
row transactionally: it re-reads the plan under a row lock, summarizes only
complete non-blank turns (pending/failed assistant rows carry no content to
preserve), and persists ``summary`` + ``summary_message_boundary`` together —
a provider failure rolls back both, leaving the session untouched.

The threshold is configurable through the ``CONTEXT_SUMMARY_TRIGGER_THRESHOLD``
Django setting (see ``.env.example``). Completion payloads are never logged.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction

from conversations.models import Message, Session
from conversations.summarizer import ConversationSummarizer
from conversations.window import recent_message_window
from llm.provider import LLMProvider

logger = logging.getLogger("conversations.trigger")

DEFAULT_SUMMARY_TRIGGER_THRESHOLD = 40


def summary_threshold() -> int:
    """Return the configured compaction threshold, validated positive int."""
    raw: Any = getattr(
        settings, "CONTEXT_SUMMARY_TRIGGER_THRESHOLD", DEFAULT_SUMMARY_TRIGGER_THRESHOLD
    )
    try:
        return _validate_threshold(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(
            f"CONTEXT_SUMMARY_TRIGGER_THRESHOLD must be a positive integer (got {raw!r})."
        ) from exc


def archive_range(
    total_messages: int,
    *,
    boundary: int,
    window: int | None = None,
    threshold: int | None = None,
) -> tuple[int, int] | None:
    """Return the inclusive ``(start, end)`` sequence range to summarize.

    ``total_messages`` is the number of messages in the session and
    ``boundary`` the persisted ``summary_message_boundary`` (messages with
    sequence <= boundary are already covered by the rolling summary). The
    last ``window`` messages stay in the recent window; summarization fires
    only when at least ``threshold`` further messages have left it since the
    boundary. Returns ``None`` when the threshold is not crossed.

    ``window=None``/``threshold=None`` (the defaults) resolve the configured
    settings; explicit values must be positive integers.
    """
    if window is None:
        window = recent_message_window()
    else:
        window = _validate_window(window)
    if threshold is None:
        threshold = summary_threshold()
    else:
        threshold = _validate_threshold(threshold)
    total_messages = _validate_count(total_messages, "total_messages")
    boundary = _validate_count(boundary, "boundary")
    if boundary > total_messages:
        raise ValueError(f"boundary ({boundary}) cannot exceed total_messages ({total_messages}).")
    end = total_messages - window
    if end - boundary < threshold:
        return None
    return (boundary + 1, end)


class SessionSummaryTrigger:
    """Apply summary compaction to a session row when its threshold is crossed."""

    def __init__(self, provider: LLMProvider) -> None:
        self._summarizer = ConversationSummarizer(provider)

    def update(self, session: Session) -> bool:
        """Refresh ``session``'s rolling summary if the threshold is crossed.

        Returns ``True`` when the summary boundary advanced (the session row
        is re-fetched and updated under a row lock inside one transaction),
        ``False`` when the conversation has not yet crossed the threshold.
        A provider failure aborts the whole update: neither the summary nor
        the boundary changes, so a later request retries the same range.
        """
        with transaction.atomic():
            locked = Session.objects.select_for_update().get(pk=session.pk)
            total = locked.messages.count()
            plan = archive_range(total, boundary=locked.summary_message_boundary)
            if plan is None:
                logger.debug(
                    "summary threshold not crossed session=%s total=%d boundary=%d",
                    locked.pk,
                    total,
                    locked.summary_message_boundary,
                )
                return False
            start, end = plan
            rows = list(locked.messages.filter(sequence__gte=start, sequence__lte=end))
            pairs = [
                (row.role, row.content)
                for row in rows
                if row.status == Message.Status.COMPLETE and row.content.strip()
            ]
            began = time.monotonic()
            if pairs:
                locked.summary = self._summarizer.summarize(
                    previous_summary=locked.summary,
                    archived_messages=pairs,
                )
            locked.summary_message_boundary = end
            locked.save(update_fields=["summary", "summary_message_boundary", "updated_at"])
        logger.info(
            "summary boundary advanced session=%s messages=%d-%d summarized=%d in %.2fs",
            locked.pk,
            start,
            end,
            len(pairs),
            time.monotonic() - began,
        )
        return True


def _validate_threshold(value: Any) -> int:
    """Reject anything that is not a positive integer (bool included)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Summary threshold must be an integer (got {value!r}).")
    if value < 1:
        raise ValueError(f"Summary threshold must be at least 1 (got {value!r}).")
    return value


def _validate_window(value: Any) -> int:
    """Reject anything that is not a positive integer (bool included)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Window size must be an integer (got {value!r}).")
    if value < 1:
        raise ValueError(f"Window size must be at least 1 (got {value!r}).")
    return value


def _validate_count(value: Any, label: str) -> int:
    """Reject anything that is not a non-negative integer (bool included)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be an integer (got {value!r}).")
    if value < 0:
        raise ValueError(f"{label} must not be negative (got {value!r}).")
    return value


__all__ = [
    "DEFAULT_SUMMARY_TRIGGER_THRESHOLD",
    "SessionSummaryTrigger",
    "archive_range",
    "summary_threshold",
]
