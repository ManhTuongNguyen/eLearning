"""Tests for the vocabulary save endpoint (vocabulary.VocabularySaveView, TASK-066).

Covers authenticated-only access, request validation (blank/non-string
expressions, malformed source ids rejected before any write), ownership of
the optional source message (foreign/missing ids are indistinguishable 404s),
the immediate-save JSON contract (verbatim words AND phrases, pending status,
empty enrichment fields), the deterministic idempotent duplicate policy
(case/whitespace-insensitive match returns the existing row unchanged,
distinct users stay independent) and immediacy (the only deferred work is
TASK-067's single post-commit enrichment hook; no LLM work on the save path).
"""

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.urls import reverse
from rest_framework.test import APIClient

from conversations.models import Message, Session
from vocabulary.models import VocabularyItem

pytestmark = pytest.mark.django_db

SAVE_URL = "/api/v1/vocabulary/"

RESPONSE_FIELDS = {
    "id",
    "expression",
    "normalized_expression",
    "definition",
    "translation",
    "pronunciation",
    "part_of_speech",
    "example",
    "status",
    "source_message",
    "source_session",
    "created_at",
}


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="bob", email="bob@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(user=user, title="Trips", topic="Traveling")


@pytest.fixture
def message(session):
    return Message.append(session, role=Message.Role.USER, content="We set off at dawn")


@pytest.fixture
def other_session(user):
    return Session.objects.create(user=user, title="Cooking", topic="Recipes")


@pytest.fixture
def other_message(other_session):
    return Message.append(
        other_session, role=Message.Role.ASSISTANT, content="Chop the onions", status="complete"
    )


@pytest.fixture
def stranger_session(db, stranger):
    return Session.objects.create(user=stranger, title="Secret", topic="X")


@pytest.fixture
def stranger_message(stranger_session):
    return Message.append(
        stranger_session, role=Message.Role.ASSISTANT, content="stranger words", status="complete"
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def chat_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def stranger_api(db, stranger):
    client = APIClient()
    client.force_authenticate(user=stranger)
    return client


def item_count() -> int:
    return VocabularyItem.objects.count()


# ---------------------------------------------------------------------------
# Authentication and methods.
# ---------------------------------------------------------------------------


class TestAuthenticationAndMethods:
    def test_anonymous_post_is_rejected_and_writes_nothing(self, api):
        response = api.post(SAVE_URL, {"expression": "set off"}, format="json")

        assert response.status_code == 401
        assert item_count() == 0

    @pytest.mark.parametrize("method", ["put", "patch", "delete"])
    def test_other_methods_are_not_allowed(self, chat_api, method):
        """GET lists the user's vocabulary since TASK-071; only writes stay rejected."""
        response = getattr(chat_api, method)(SAVE_URL, {}, format="json")

        assert response.status_code == 405


# ---------------------------------------------------------------------------
# Request validation (rejected before anything is written).
# ---------------------------------------------------------------------------


class TestValidation:
    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"expression": ""},
            {"expression": "   "},
            {"expression": "\n\t"},
            {"expression": ["set off"]},
        ],
    )
    def test_invalid_expression_is_a_400_that_writes_nothing(self, chat_api, payload):
        response = chat_api.post(SAVE_URL, payload, format="json")

        assert response.status_code == 400
        assert "expression" in response.data
        assert item_count() == 0

    def test_numeric_expression_is_coerced_to_string(self, chat_api):
        """DRF CharField semantics (repo convention): numbers arrive as text."""
        response = chat_api.post(SAVE_URL, {"expression": 42}, format="json")

        assert response.status_code == 201
        assert response.data["expression"] == "42"
        assert response.data["normalized_expression"] == "42"

    @pytest.mark.parametrize("bad_source", [0, -5, "abc", 1.5, None])
    def test_malformed_source_message_id_is_a_400(self, chat_api, bad_source):
        response = chat_api.post(
            SAVE_URL, {"expression": "set off", "source_message_id": bad_source}, format="json"
        )

        assert response.status_code == 400
        assert "source_message_id" in response.data
        assert item_count() == 0

    def test_unknown_payload_fields_are_ignored_and_cannot_flip_status(self, chat_api):
        response = chat_api.post(
            SAVE_URL, {"expression": "set off", "status": "complete"}, format="json"
        )

        assert response.status_code == 201
        assert response.data["status"] == VocabularyItem.Status.PENDING


# ---------------------------------------------------------------------------
# Source-message ownership (indistinguishable 404s, nothing written).
# ---------------------------------------------------------------------------


class TestSourceOwnership:
    def test_foreign_source_message_is_an_indistinguishable_404(self, chat_api, stranger_message):
        response = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": stranger_message.pk},
            format="json",
        )

        assert response.status_code == 404
        assert "detail" in response.data
        assert item_count() == 0

    def test_missing_source_message_is_404(self, chat_api):
        response = chat_api.post(
            SAVE_URL, {"expression": "set off", "source_message_id": 99999}, format="json"
        )

        assert response.status_code == 404
        assert item_count() == 0

    def test_source_ownership_precedes_the_duplicate_shortcut(
        self, chat_api, user, stranger_message
    ):
        """A foreign source must 404 even when the expression already exists."""
        VocabularyItem.objects.create(
            user=user,
            expression="set off",
            normalized_expression="set off",
        )
        before = item_count()

        response = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": stranger_message.pk},
            format="json",
        )

        assert response.status_code == 404
        assert item_count() == before


# ---------------------------------------------------------------------------
# Successful saves (immediate, verbatim, pending).
# ---------------------------------------------------------------------------


class TestSuccessfulSaves:
    def test_single_word_is_saved_verbatim_and_pending(self, chat_api):
        response = chat_api.post(SAVE_URL, {"expression": "Serendipity"}, format="json")

        assert response.status_code == 201
        assert response.headers["Content-Type"] == "application/json"
        assert set(response.data) == RESPONSE_FIELDS
        assert response.data["expression"] == "Serendipity"
        assert response.data["normalized_expression"] == "serendipity"
        assert response.data["status"] == VocabularyItem.Status.PENDING
        for field in ("definition", "translation", "pronunciation", "part_of_speech", "example"):
            assert response.data[field] == "", field
        assert response.data["source_message"] is None
        assert response.data["source_session"] is None
        assert item_count() == 1

    def test_multi_word_phrase_keeps_punctuation_and_case_verbatim(self, chat_api):
        phrase = "To bite the bullet!"

        response = chat_api.post(SAVE_URL, {"expression": f"  {phrase}  "}, format="json")

        assert response.status_code == 201
        assert response.data["expression"] == phrase
        assert response.data["normalized_expression"] == "to bite the bullet!"

    def test_saved_row_is_persisted_with_expected_columns(self, chat_api, user):
        response = chat_api.post(SAVE_URL, {"expression": "gobsmacked"}, format="json")

        item = VocabularyItem.objects.get(pk=response.data["id"])
        assert item.user == user
        assert item.expression == "gobsmacked"
        assert item.normalized_expression == "gobsmacked"
        assert item.is_pending

    def test_source_links_point_at_the_message_and_its_session(self, chat_api, message):
        response = chat_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": message.pk},
            format="json",
        )

        assert response.status_code == 201
        assert response.data["source_message"] == message.pk
        assert response.data["source_session"] == message.session_id
        item = VocabularyItem.objects.get(pk=response.data["id"])
        assert item.source_message == message
        assert item.source_session == message.session

    def test_saving_without_a_source_stores_null_links(self, chat_api):
        response = chat_api.post(SAVE_URL, {"expression": "wanderlust"}, format="json")

        assert response.status_code == 201
        assert response.data["source_message"] is None
        assert response.data["source_session"] is None


# ---------------------------------------------------------------------------
# Duplicate behavior is deterministic (idempotent save).
# ---------------------------------------------------------------------------


class TestDuplicateBehavior:
    def test_resaving_the_same_expression_returns_the_existing_row(self, chat_api):
        first = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        second = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")

        assert first.status_code == 201
        assert second.status_code == 200
        assert second.data["id"] == first.data["id"]
        assert item_count() == 1

    def test_match_is_case_insensitive_and_whitespace_trimmed(self, chat_api):
        first = chat_api.post(SAVE_URL, {"expression": "Set Off"}, format="json")
        second = chat_api.post(SAVE_URL, {"expression": "  set off  "}, format="json")

        assert second.status_code == 200
        assert second.data["id"] == first.data["id"]
        # The stored expression stays the ORIGINAL verbatim selection.
        assert second.data["expression"] == "Set Off"
        assert item_count() == 1

    def test_duplicate_never_touches_enrichment_progress_or_source(
        self, chat_api, user, message, other_message
    ):
        enriched = VocabularyItem.objects.create(
            user=user,
            expression="set off",
            normalized_expression="set off",
            status=VocabularyItem.Status.COMPLETE,
            definition="to start a journey",
            source_message=message,
            source_session=message.session,
        )

        response = chat_api.post(
            SAVE_URL,
            {"expression": " SET OFF ", "source_message_id": other_message.pk},
            format="json",
        )

        assert response.status_code == 200
        assert response.data["id"] == enriched.pk
        assert response.data["status"] == VocabularyItem.Status.COMPLETE
        assert response.data["definition"] == "to start a journey"
        assert response.data["source_message"] == message.pk
        enriched.refresh_from_db()
        assert enriched.is_enriched
        assert enriched.source_message == message
        assert item_count() == 1

    def test_same_word_for_distinct_users_creates_independent_rows(self, chat_api, stranger_api):
        mine = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")
        theirs = stranger_api.post(SAVE_URL, {"expression": "SET OFF"}, format="json")

        assert mine.status_code == 201
        assert theirs.status_code == 201
        assert mine.data["id"] != theirs.data["id"]
        assert item_count() == 2


# ---------------------------------------------------------------------------
# Immediacy and purity (no LLM, no background scheduling on the save path).
# ---------------------------------------------------------------------------


class TestImmediacyAndPurity:
    def test_save_registers_exactly_the_post_commit_enrichment_hook(self, chat_api):
        """TASK-067: the only deferred work is the single enrichment hook."""
        callbacks_before = list(connection.run_on_commit)

        response = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")

        assert response.status_code == 201
        assert len(connection.run_on_commit) == len(callbacks_before) + 1

    def test_new_save_stays_within_a_bounded_query_budget(
        self, chat_api, django_assert_max_num_queries
    ):
        with django_assert_max_num_queries(10):
            response = chat_api.post(SAVE_URL, {"expression": "set off"}, format="json")

        assert response.status_code == 201

    def test_save_url_is_mounted_at_the_documented_path(self):
        assert reverse("vocabulary:vocabulary-save") == SAVE_URL
