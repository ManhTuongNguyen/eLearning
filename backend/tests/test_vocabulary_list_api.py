"""Tests for the vocabulary listing API (vocabulary.VocabularySaveView GET, TASK-071).

Covers authenticated-only access, per-user scoping (users never see another
user's saved expressions), pagination driven by the global DRF settings,
newest-first ordering (the model's ``-created_at`` default) and the serialized
field contract including enrichment status for the mobile list screen.
"""

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from vocabulary.models import VocabularyItem

pytestmark = pytest.mark.django_db

VOCABULARY_URL = "/api/v1/vocabulary/"

USERNAME = "alice"
EMAIL = "alice@example.com"
PASSWORD = "pw-123456"

SERIALIZED_FIELDS = {
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


def make_item(user, expression="set off", **overrides):
    fields = {
        "user": user,
        "expression": expression,
        "normalized_expression": VocabularyItem.normalize_expression(expression),
    }
    fields.update(overrides)
    return VocabularyItem.objects.create(**fields)


def set_created_at(item, offset_minutes):
    """Pin created_at explicitly (.update bypasses auto_now_add) for ordering tests."""
    pinned = timezone.now() - timedelta(minutes=offset_minutes)
    VocabularyItem.objects.filter(pk=item.pk).update(created_at=pinned)
    item.refresh_from_db()
    return item


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        username=USERNAME,
        email=EMAIL,
        password=PASSWORD,
    )


@pytest.fixture
def authed_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def stranger():
    return get_user_model().objects.create_user(
        username="stranger",
        email="stranger@example.com",
        password="pw-123456",
    )


class TestAuthentication:
    def test_anonymous_get_is_rejected(self, api, user):
        make_item(user)

        response = api.get(VOCABULARY_URL)

        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestListingShape:
    def test_empty_list_returns_paginated_envelope(self, authed_api):
        response = authed_api.get(VOCABULARY_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 0
        assert response.data["results"] == []
        assert response.data["next"] is None
        assert response.data["previous"] is None

    def test_items_expose_serializer_fields_only(self, authed_api, user):
        item = make_item(
            user,
            expression="Serendipity",
            definition="a happy accident",
            translation="счастливая случайность",
            pronunciation="/ˌserənˈdɪpɪti/",
            part_of_speech="noun",
            example="Finding this book was pure serendipity.",
            status=VocabularyItem.Status.COMPLETE,
        )

        response = authed_api.get(VOCABULARY_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 1
        result = response.data["results"][0]
        assert set(result.keys()) == SERIALIZED_FIELDS
        assert result["id"] == item.id
        assert result["expression"] == "Serendipity"
        assert result["normalized_expression"] == "serendipity"
        assert result["definition"] == "a happy accident"
        assert result["translation"] == "счастливая случайность"
        assert result["pronunciation"] == "/ˌserənˈdɪpɪti/"
        assert result["part_of_speech"] == "noun"
        assert result["example"] == "Finding this book was pure serendipity."
        assert result["status"] == VocabularyItem.Status.COMPLETE
        assert result["source_message"] is None
        assert result["source_session"] is None

    def test_enrichment_status_is_visible_for_pending_rows(self, authed_api, user):
        make_item(user, expression="gobsmacked")
        make_item(
            user,
            expression="wanderlust",
            status=VocabularyItem.Status.COMPLETE,
            definition="a strong desire to travel",
        )

        results = authed_api.get(VOCABULARY_URL).data["results"]
        statuses = {row["expression"]: row["status"] for row in results}

        assert statuses["gobsmacked"] == VocabularyItem.Status.PENDING
        assert statuses["wanderlust"] == VocabularyItem.Status.COMPLETE


class TestUserScoping:
    def test_users_see_only_their_own_items(self, authed_api, user, stranger):
        mine_older = set_created_at(make_item(user, expression="mine older"), 60)
        theirs_newest = set_created_at(make_item(stranger, expression="theirs"), 10)
        mine_newer = set_created_at(make_item(user, expression="mine newer"), 30)

        response = authed_api.get(VOCABULARY_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 2
        expressions = [item["expression"] for item in response.data["results"]]
        assert expressions == ["mine newer", "mine older"]
        ids = {item["id"] for item in response.data["results"]}
        assert ids == {mine_older.id, mine_newer.id}
        assert theirs_newest.id not in ids


class TestOrdering:
    def test_most_recently_saved_first(self, authed_api, user):
        first = make_item(user, expression="first saved")
        second = make_item(user, expression="second saved")
        third = make_item(user, expression="third saved")
        set_created_at(first, 300)
        set_created_at(second, 180)
        set_created_at(third, 60)

        response = authed_api.get(VOCABULARY_URL)

        expressions = [item["expression"] for item in response.data["results"]]
        assert expressions == ["third saved", "second saved", "first saved"]

    def test_identical_timestamps_are_both_returned(self, authed_api, user):
        """Rows pinned to the exact same created_at are both listed, never dropped."""
        alpha = set_created_at(make_item(user, expression="alpha"), 60)
        beta = set_created_at(make_item(user, expression="beta"), 60)

        response = authed_api.get(VOCABULARY_URL)

        assert response.data["count"] == 2
        expressions = {item["expression"] for item in response.data["results"]}
        assert expressions == {alpha.expression, beta.expression}


class TestPagination:
    @pytest.fixture
    def twenty_five(self, user):
        items = [make_item(user, expression=f"phrase {i:02d}") for i in range(25)]
        for index, item in enumerate(items):
            set_created_at(item, index + 1)  # distinct, oldest first by creation order
        return items

    def test_first_page_is_capped_at_page_size_with_next_link(self, authed_api, twenty_five):
        response = authed_api.get(VOCABULARY_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 25
        assert len(response.data["results"]) == 20
        assert response.data["previous"] is None
        assert response.data["next"] is not None
        assert "page=2" in response.data["next"]

    def test_second_page_returns_remainder_with_previous_link(self, authed_api, twenty_five):
        response = authed_api.get(VOCABULARY_URL, {"page": 2})

        assert response.status_code == status.HTTP_200_OK
        assert len(response.data["results"]) == 5
        assert response.data["next"] is None
        assert response.data["previous"] is not None

    def test_pagination_preserves_ordering_across_pages(self, authed_api, twenty_five):
        first_page = authed_api.get(VOCABULARY_URL).data["results"]
        second_page = authed_api.get(VOCABULARY_URL, {"page": 2}).data["results"]

        expressions = [item["expression"] for item in [*first_page, *second_page]]
        # Offsets grow with the index, so phrase 00 was saved most recently.
        expected = [f"phrase {i:02d}" for i in range(25)]
        assert expressions == expected

    @pytest.mark.parametrize("page", ["999", "abc", "0"])
    def test_invalid_page_returns_404(self, authed_api, twenty_five, page):
        response = authed_api.get(VOCABULARY_URL, {"page": page})

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_strangers_items_do_not_count_toward_my_pages(
        self, authed_api, user, stranger, twenty_five
    ):
        make_item(stranger, expression="stranger phrase")

        first = authed_api.get(VOCABULARY_URL).data
        second = authed_api.get(VOCABULARY_URL, {"page": 2}).data

        assert first["count"] == 25
        expressions = {item["expression"] for item in [*first["results"], *second["results"]]}
        assert "stranger phrase" not in expressions


class TestRouting:
    def test_list_is_mounted_on_the_documented_path(self):
        assert reverse("vocabulary:vocabulary-save") == VOCABULARY_URL
