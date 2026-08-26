"""Post-commit scheduling of asynchronous vocabulary enrichment (TASK-067).

Saving vocabulary is immediate (ROADMAP "Vocabulary") while enrichment is
asynchronous, and background work must never run against rolled-back rows.
This module owns the single bridge between the synchronous save path and
Celery:

    transaction.atomic()
        |
    VocabularyItem.objects.create(...)
        |
    schedule_vocabulary_enrichment(item.pk)   # registers a commit hook
        |                                     (nothing sent while in flight)
        v  COMMIT
    enrich_vocabulary_item.delay(item.pk)     # exactly one enqueue
        |
    worker: LLM enrichment (TASK-068)

A ``post_save`` signal is deliberately avoided (SPEC TASK-067 / Rule 8):
signals fire inside the transaction, so an enqueue would survive a later
rollback and a worker could consume a row that was never committed.
"""

from __future__ import annotations

import logging

from celery import shared_task
from django.db import transaction

logger = logging.getLogger("vocabulary.tasks")


@shared_task(bind=True, name="vocabulary.enrich_vocabulary_item")
def enrich_vocabulary_item(self, vocabulary_id: int) -> bool:
    """Enrich one vocabulary item via the LLM.

    The full enrichment pass — definition, translation, pronunciation,
    part of speech and example, with retryable failures and persisted
    status transitions — is TASK-068; until it lands this registered task
    is a safe no-op so enqueued jobs never crash a worker.
    """
    logger.debug("enrichment skipped: not implemented yet vocabulary=%s", vocabulary_id)
    return False


def schedule_vocabulary_enrichment(vocabulary_id: int) -> None:
    """Enqueue :func:`enrich_vocabulary_item` once the transaction commits.

    Callers stay non-blocking and rollback-safe: while the surrounding
    transaction may still roll back nothing reaches the broker. Outside an
    explicit atomic block Django flushes the hook immediately after the
    autocommit INSERT, which is still strictly post-commit.
    """
    transaction.on_commit(lambda: enrich_vocabulary_item.delay(vocabulary_id))


__all__ = ["enrich_vocabulary_item", "schedule_vocabulary_enrichment"]
