"""Asynchronous vocabulary enrichment (ROADMAP "Vocabulary", TASK-067/068).

Saving vocabulary is immediate (TASK-066) while enrichment is asynchronous:
:func:`schedule_vocabulary_enrichment` (TASK-067) enqueues
:func:`enrich_vocabulary_item` from a ``transaction.on_commit`` hook, and this
module owns the worker side (TASK-068). The task asks
:class:`~vocabulary.enrichment.EnrichmentService` for card-ready data —
definition, translation, pronunciation, part of speech, example — persists it
on the item and flips its status to ``complete``.

Failure semantics:

- Retryable provider failures (:class:`~llm.exceptions.LLMError` with
  ``retryable=True``) are re-raised through Celery's retry machinery with
  exponential backoff and jitter; only when the retry budget of
  :data:`ENRICHMENT_MAX_RETRIES` is exhausted is the item marked ``failed``
  so the UI can surface it.
- Permanent failures (auth errors, unusable model output) mark the item
  ``failed`` immediately. A failed item keeps its row and expression —
  enrichment never deletes vocabulary — and a later re-enrichment attempt may
  still succeed.
- An item deleted between enqueue and execution is skipped silently; an item
  already enriched is skipped too, making duplicate broker deliveries no-ops.

The learning level sent to the LLM comes from the source session's level,
falling back to the user's profile level and finally ``AUTO``.

Completion payloads are never logged.
"""

from __future__ import annotations

import logging
from functools import lru_cache

from celery import shared_task
from celery.exceptions import Retry
from django.db import transaction

from learning.models import Level
from llm.exceptions import LLMError
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider
from vocabulary.enrichment import EnrichmentService
from vocabulary.models import VocabularyItem

logger = logging.getLogger("vocabulary.tasks")

ENRICHMENT_MAX_RETRIES = 5
ENRICHMENT_BACKOFF_SECONDS = 5
ENRICHMENT_BACKOFF_MAX_SECONDS = 600


@lru_cache(maxsize=1)
def _settings_enrichment_provider() -> LLMProvider:
    return FallbackProvider.from_settings()


def get_enrichment_provider() -> LLMProvider:
    """Return the process-wide settings-driven provider (test seam)."""
    return _settings_enrichment_provider()


def resolve_item_level(item: VocabularyItem) -> str:
    """Return the CEFR level shaping this item's enrichment.

    Preference order: the source conversation's level, then the learner's
    profile level, then ``AUTO`` so the model infers one itself.
    """
    session = item.source_session
    if session is not None and session.learning_level in Level.values:
        return session.learning_level
    profile = getattr(item.user, "learning_profile", None)
    if profile is not None:
        return profile.level
    return Level.AUTO


def enrich_vocabulary(vocabulary_id: int) -> bool:
    """Run one enrichment pass for ``vocabulary_id``.

    Returns ``True`` when fields were persisted and the status became
    ``complete``; ``False`` when the item is gone or already enriched.
    Provider failures propagate to the caller (the task decides retry vs
    abandon).
    """
    try:
        item = VocabularyItem.objects.select_related(
            "source_session", "user__learning_profile"
        ).get(pk=vocabulary_id)
    except VocabularyItem.DoesNotExist:
        logger.info("enrichment skipped: vocabulary=%s no longer exists", vocabulary_id)
        return False
    if item.status == VocabularyItem.Status.COMPLETE:
        logger.info("enrichment skipped: vocabulary=%s already complete", vocabulary_id)
        return False
    enrichment = EnrichmentService(get_enrichment_provider()).enrich(
        expression=item.expression,
        level=resolve_item_level(item),
    )
    item.definition = enrichment.definition
    item.translation = enrichment.translation
    item.pronunciation = enrichment.pronunciation
    item.part_of_speech = enrichment.part_of_speech
    item.example = enrichment.example
    item.status = VocabularyItem.Status.COMPLETE
    item.save(
        update_fields=[
            "definition",
            "translation",
            "pronunciation",
            "part_of_speech",
            "example",
            "status",
            "updated_at",
        ]
    )
    return True


def _mark_failed(vocabulary_id: int, exc: LLMError) -> None:
    """Persist ``failed`` without deleting the saved expression."""
    updated = VocabularyItem.objects.filter(pk=vocabulary_id).update(
        status=VocabularyItem.Status.FAILED
    )
    if not updated:
        logger.debug("failure status dropped: vocabulary=%s was deleted", vocabulary_id)


@shared_task(
    bind=True,
    name="vocabulary.enrich_vocabulary_item",
    max_retries=ENRICHMENT_MAX_RETRIES,
    acks_late=True,
    retry_backoff=ENRICHMENT_BACKOFF_SECONDS,
    retry_backoff_max=ENRICHMENT_BACKOFF_MAX_SECONDS,
    retry_jitter=True,
)
def enrich_vocabulary_item(self, vocabulary_id: int) -> bool:
    """Enrich one vocabulary item without blocking any request."""
    try:
        return enrich_vocabulary(vocabulary_id)
    except LLMError as exc:
        if not exc.retryable:
            logger.warning("enrichment abandoned vocabulary=%s error=%s", vocabulary_id, exc)
            _mark_failed(vocabulary_id, exc)
            return False
        logger.warning("enrichment failed vocabulary=%s error=%s; retrying", vocabulary_id, exc)
        try:
            raise self.retry(exc=exc)
        except Retry:
            raise  # another attempt has been scheduled
        except LLMError:
            # Retry budget exhausted: self.retry re-raised the original error.
            logger.warning("enrichment gave up vocabulary=%s error=%s", vocabulary_id, exc)
            _mark_failed(vocabulary_id, exc)
            return False


def schedule_vocabulary_enrichment(vocabulary_id: int) -> None:
    """Enqueue :func:`enrich_vocabulary_item` once the transaction commits.

    Callers stay non-blocking and rollback-safe: while the surrounding
    transaction may still roll back nothing reaches the broker. Outside an
    explicit atomic block Django flushes the hook immediately after the
    autocommit INSERT, which is still strictly post-commit.
    """
    transaction.on_commit(lambda: enrich_vocabulary_item.delay(vocabulary_id))


__all__ = [
    "ENRICHMENT_BACKOFF_MAX_SECONDS",
    "ENRICHMENT_BACKOFF_SECONDS",
    "ENRICHMENT_MAX_RETRIES",
    "enrich_vocabulary",
    "enrich_vocabulary_item",
    "get_enrichment_provider",
    "resolve_item_level",
    "schedule_vocabulary_enrichment",
]
