"""Asynchronous session-summary maintenance (ROADMAP section 5, TASK-039).

Summarization is an LLM call that can take seconds; the user-facing chat
request must never wait for it. This module owns the Celery side of summary
compaction: :func:`update_session_summary` applies
:class:`~conversations.trigger.SessionSummaryTrigger` to one session inside
the worker (all trigger guarantees — row lock, boundary idempotency,
rollback on provider failure — carry over unchanged), while
:func:`schedule_session_summary_update` is what request-side code calls: a
``transaction.on_commit`` enqueue so a rolled-back transaction never queues
work for rows that do not exist.

Failure semantics:

- Retryable provider failures (:class:`~llm.exceptions.LLMError` with
  ``retryable=True``) are re-raised through Celery's retry machinery with
  exponential backoff and jitter — failed jobs retry up to
  :data:`SUMMARY_UPDATE_MAX_RETRIES` times.
- Permanent failures (auth errors, unusable model output) are logged and
  swallowed: the conversation keeps working with its existing summary and
  the same range is simply retried the next time the threshold is crossed.
- A session deleted between enqueue and execution is skipped silently.
- Duplicate deliveries are harmless by construction: the trigger re-reads
  the boundary under a row lock, so a second execution finds nothing left
  to summarize.

Completion payloads are never logged.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from celery import shared_task
from django.db import transaction

from conversations.models import Session
from conversations.trigger import SessionSummaryTrigger
from llm.exceptions import LLMError
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider

logger = logging.getLogger("conversations.tasks")

SUMMARY_UPDATE_MAX_RETRIES = 5
SUMMARY_UPDATE_BACKOFF_SECONDS = 5
SUMMARY_UPDATE_BACKOFF_MAX_SECONDS = 600


@lru_cache(maxsize=1)
def _settings_summary_provider() -> LLMProvider:
    return FallbackProvider.from_settings()


def get_summary_provider() -> LLMProvider:
    """Return the process-wide settings-driven provider (test seam)."""
    return _settings_summary_provider()


def summarize_session(session_id: int) -> bool:
    """Run one summary-update pass for ``session_id``.

    Returns ``True`` when the rolling summary advanced, ``False`` when the
    session is gone or has not crossed the compaction threshold. Provider
    failures propagate to the caller (the task decides retry vs abandon).
    """
    try:
        session = Session.objects.get(pk=session_id)
    except Session.DoesNotExist:
        logger.info("summary update skipped: session=%s no longer exists", session_id)
        return False
    return SessionSummaryTrigger(get_summary_provider()).update(session)


@shared_task(
    bind=True,
    name="conversations.update_session_summary",
    max_retries=SUMMARY_UPDATE_MAX_RETRIES,
    acks_late=True,
    retry_backoff=SUMMARY_UPDATE_BACKOFF_SECONDS,
    retry_backoff_max=SUMMARY_UPDATE_BACKOFF_MAX_SECONDS,
    retry_jitter=True,
)
def update_session_summary(self, session_id: int) -> bool:
    """Refresh one session's rolling summary without blocking any request."""
    try:
        return summarize_session(session_id)
    except LLMError as exc:
        if not exc.retryable:
            logger.warning(
                "summary update abandoned session=%s error=%s",
                session_id,
                exc,
            )
            return False
        logger.warning("summary update failed session=%s error=%s; retrying", session_id, exc)
        raise self.retry(exc=exc) from exc


def schedule_session_summary_update(session_id: int) -> None:
    """Enqueue :func:`update_session_summary` once the transaction commits.

    Callers stay non-blocking and rollback-safe: nothing is sent to the
    broker while the surrounding transaction may still roll back.
    """
    transaction.on_commit(lambda: update_session_summary.delay(session_id))


__all__ = [
    "SUMMARY_UPDATE_BACKOFF_MAX_SECONDS",
    "SUMMARY_UPDATE_BACKOFF_SECONDS",
    "SUMMARY_UPDATE_MAX_RETRIES",
    "get_summary_provider",
    "schedule_session_summary_update",
    "summarize_session",
    "update_session_summary",
]
