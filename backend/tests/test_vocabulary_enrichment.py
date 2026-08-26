"""Tests for asynchronous vocabulary enrichment (vocabulary.tasks, TASK-068).

Covers the registered task's reliability contract, the provider seam, level
resolution, the enrichment body executed eagerly through ``apply()`` — happy
path, idempotent skips, retryable failures with Celery backoff, permanent
failures and retry-budget exhaustion marking the item ``failed`` without ever
deleting it — plus log hygiene.
"""

import logging

import pytest
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings

from conversations.models import Session
from learning.models import Level, Profile
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError, LLMResponseError
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse
from vocabulary import tasks as vocab_tasks
from vocabulary.models import VocabularyItem
from vocabulary.tasks import (
    ENRICHMENT_BACKOFF_MAX_SECONDS,
    ENRICHMENT_BACKOFF_SECONDS,
    ENRICHMENT_MAX_RETRIES,
    enrich_vocabulary,
    enrich_vocabulary_item,
    get_enrichment_provider,
    resolve_item_level,
)

SERVED_MODEL = "served/enrichment-model"

ENRICHMENT_JSON = (
    '{"definition": "to leave on a journey", '
    '"translation": "begin a trip", '
    '"pronunciation": "/set \u0252f/", '
    '"part_of_speech": "phrasal verb", '
    '"example": "We set off at dawn."}'
)
SECRET_EXPRESSION = "SECRET-EXPRESSION"


class ScriptedProvider(LLMProvider):
    """Fake provider popping one scripted outcome per call and recording requests."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def stream(self, request: CompletionRequest):
        raise AssertionError("vocabulary enrichment never streams")


def response(text: str) -> CompletionResponse:
    return CompletionResponse(text=text, model=SERVED_MODEL)


# ---------------------------------------------------------------------------
# Task configuration (no database).
# ---------------------------------------------------------------------------


class EnrichVocabularyItemConfiguration(SimpleTestCase):
    """The registered task carries its reliability contract in its options."""

    def test_name_is_stable(self) -> None:
        assert enrich_vocabulary_item.name == "vocabulary.enrich_vocabulary_item"

    def test_retry_budget_is_bounded(self) -> None:
        assert enrich_vocabulary_item.max_retries == ENRICHMENT_MAX_RETRIES == 5

    def test_backoff_is_exponential_with_jitter(self) -> None:
        assert enrich_vocabulary_item.retry_backoff == ENRICHMENT_BACKOFF_SECONDS == 5
        assert enrich_vocabulary_item.retry_backoff_max == ENRICHMENT_BACKOFF_MAX_SECONDS == 600
        assert enrich_vocabulary_item.retry_jitter is True

    def test_late_ack_survives_worker_crashes(self) -> None:
        assert enrich_vocabulary_item.acks_late is True


# ---------------------------------------------------------------------------
# Provider seam.
# ---------------------------------------------------------------------------


class EnrichmentProviderSeamTests(SimpleTestCase):
    """get_enrichment_provider mirrors the conversations.tasks service-seam pattern."""

    @override_settings(OPENROUTER_API_KEY="seam-test-key")
    def test_builds_fallback_provider_from_settings(self) -> None:
        provider = get_enrichment_provider()
        assert isinstance(provider, FallbackProvider)
        assert isinstance(provider, LLMProvider)

    @override_settings(OPENROUTER_API_KEY="seam-test-key")
    def test_provider_identity_is_cached_per_process(self) -> None:
        assert get_enrichment_provider() is get_enrichment_provider()


# ---------------------------------------------------------------------------
# Level resolution.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestResolveItemLevel:
    @pytest.fixture
    def user(self, db):
        return get_user_model().objects.create_user(
            username="hannah", email="hannah@example.com", password="pw-123456"
        )

    def test_source_session_level_wins(self, user):
        session = Session.objects.create(
            user=user, title="Chat", topic="Travel", learning_level="B2"
        )
        item = VocabularyItem.objects.create(
            user=user,
            expression="set off",
            normalized_expression="set off",
            source_session=session,
        )
        assert resolve_item_level(item) == "B2"

    def test_profile_level_is_the_fallback(self, user):
        Profile.objects.create(user=user, level="C1")
        item = VocabularyItem.objects.create(
            user=user, expression="wanderlust", normalized_expression="wanderlust"
        )
        assert resolve_item_level(item) == "C1"

    def test_missing_profile_falls_back_to_auto(self, user):
        Profile.objects.filter(user=user).delete()
        item = VocabularyItem.objects.create(
            user=user, expression="serendipity", normalized_expression="serendipity"
        )
        assert resolve_item_level(item) == Level.AUTO


# ---------------------------------------------------------------------------
# Task behavior against the real database (executed eagerly).
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEnrichVocabularyItem:
    """enrich_vocabulary_item executed through Celery's eager apply()."""

    @pytest.fixture
    def user(self, db):
        return get_user_model().objects.create_user(
            username="ian", email="ian@example.com", password="pw-123456"
        )

    @pytest.fixture
    def item(self, user):
        return VocabularyItem.objects.create(
            user=user, expression="set off", normalized_expression="set off"
        )

    def use_provider(self, monkeypatch, *outcomes):
        provider = ScriptedProvider(*outcomes)
        monkeypatch.setattr(vocab_tasks, "get_enrichment_provider", lambda: provider)
        return provider

    def apply_task(self, vocabulary_id):
        return enrich_vocabulary_item.apply(args=[vocabulary_id])

    # -- happy path ---------------------------------------------------------

    def test_persists_fields_and_complete_status(self, item, monkeypatch):
        self.use_provider(monkeypatch, response(ENRICHMENT_JSON))

        result = self.apply_task(item.pk)

        assert result.state == "SUCCESS"
        assert result.result is True
        item.refresh_from_db()
        assert item.is_enriched
        assert not item.is_pending
        assert item.definition == "to leave on a journey"
        assert item.translation == "begin a trip"
        assert item.pronunciation == "/set \u0252f/"
        assert item.part_of_speech == "phrasal verb"
        assert item.example == "We set off at dawn."

    def test_provider_receives_expression_and_resolved_level(self, item, monkeypatch):
        session = Session.objects.create(
            user=item.user, title="Chat", topic="Travel", learning_level="A2"
        )
        item.source_session = session
        item.save(update_fields=["source_session"])
        provider = self.use_provider(monkeypatch, response(ENRICHMENT_JSON))

        self.apply_task(item.pk)

        request = provider.requests[0]
        assert 'The learner\'s expression: "set off"' in request.messages[-1].content
        assert "A2" in request.messages[-1].content

    # -- graceful skips ------------------------------------------------------

    def test_missing_item_is_a_graceful_no_op(self, item, monkeypatch):
        provider = self.use_provider(monkeypatch, response(ENRICHMENT_JSON))
        vocabulary_id = item.pk
        item.delete()

        result = self.apply_task(vocabulary_id)

        assert result.result is False
        assert provider.requests == []

    def test_already_enriched_item_is_skipped_without_provider_call(self, item, monkeypatch):
        item.status = VocabularyItem.Status.COMPLETE
        item.definition = "existing"
        item.save()
        provider = self.use_provider(monkeypatch, response(ENRICHMENT_JSON))

        result = self.apply_task(item.pk)

        assert result.result is False
        assert provider.requests == []
        item.refresh_from_db()
        assert item.definition == "existing"

    def test_failed_item_can_be_enriched_again(self, item, monkeypatch):
        VocabularyItem.objects.filter(pk=item.pk).update(status=VocabularyItem.Status.FAILED)
        self.use_provider(monkeypatch, response(ENRICHMENT_JSON))

        result = self.apply_task(item.pk)

        assert result.result is True
        item.refresh_from_db()
        assert item.is_enriched

    # -- retryable failure ----------------------------------------------------
    # Note: eager apply() re-executes retried tasks inline (celery Task.apply
    # follows the Retry signature locally), so one scripted provider sees
    # every attempt of a single .apply() call.

    def test_retryable_failure_is_retried_and_eventually_succeeds(self, item, monkeypatch):
        provider = self.use_provider(
            monkeypatch,
            LLMAvailabilityError("upstream down"),
            response(ENRICHMENT_JSON),
        )

        result = self.apply_task(item.pk)

        assert result.state == "SUCCESS"
        assert result.result is True
        assert len(provider.requests) == 2
        item.refresh_from_db()
        assert item.is_enriched

    def test_retry_budget_exhaustion_marks_failed_and_keeps_the_expression(self, item, monkeypatch):
        monkeypatch.setattr(enrich_vocabulary_item, "max_retries", 0)
        provider = self.use_provider(monkeypatch, *[LLMAvailabilityError("still down")] * 3)

        result = self.apply_task(item.pk)

        assert result.state == "SUCCESS"
        assert result.result is False
        assert len(provider.requests) == 1
        item.refresh_from_db()
        assert item.status == VocabularyItem.Status.FAILED
        assert item.expression == "set off"
        assert item.definition == ""

    def test_direct_body_failure_propagates_to_caller(self, item, monkeypatch):
        self.use_provider(monkeypatch, LLMAvailabilityError("upstream down"))

        with pytest.raises(LLMAvailabilityError):
            enrich_vocabulary(item.pk)

        item.refresh_from_db()
        assert item.is_pending

    # -- permanent failure ---------------------------------------------------

    def test_non_retryable_failure_marks_failed_without_retry(self, item, monkeypatch):
        provider = self.use_provider(
            monkeypatch, LLMAuthenticationError("provider rejected credentials")
        )

        result = self.apply_task(item.pk)

        assert result.state == "SUCCESS"
        assert result.result is False
        assert len(provider.requests) == 1
        item.refresh_from_db()
        assert item.status == VocabularyItem.Status.FAILED
        assert item.expression == "set off"

    def test_unusable_output_marks_failed_without_retry(self, item, monkeypatch):
        provider = self.use_provider(
            monkeypatch,
            LLMResponseError("blank completion", provider="vocabulary", model=SERVED_MODEL),
        )

        result = self.apply_task(item.pk)

        assert result.result is False
        assert len(provider.requests) == 1
        item.refresh_from_db()
        assert item.status == VocabularyItem.Status.FAILED

    # -- log hygiene ----------------------------------------------------------

    def test_failure_logs_carry_ids_not_payloads(self, item, monkeypatch, caplog):
        self.use_provider(monkeypatch, LLMAvailabilityError("upstream exploded"))
        with caplog.at_level(logging.DEBUG, logger="vocabulary.tasks"):
            self.apply_task(item.pk)

        joined = "\n".join(f"{r.levelname}:{r.getMessage()}" for r in caplog.records)
        assert f"vocabulary={item.pk}" in joined
        assert "upstream exploded" in joined
        assert SECRET_EXPRESSION not in joined
