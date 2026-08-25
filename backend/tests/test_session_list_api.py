"""Tests for the session listing API (TASK-031).

Covers authenticated-only access, per-user scoping (users never see another
user's sessions), pagination driven by the global DRF settings, and the
most-recently-updated-first ordering contract.
"""

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from conversations.models import Session

pytestmark = pytest.mark.django_db

SESSIONS_URL = reverse("conversations:sessions")

USERNAME = "erin"
EMAIL = "erin@example.com"
PASSWORD = "pw-123456"

SERIALIZED_FIELDS = {"id", "title", "topic", "topic_hint", "learning_level", "created_at"}


def make_session(user, title="A conversation", **overrides):
    fields = {
        "user": user,
        "title": title,
        "topic": f"Topic for {title}",
        "topic_hint": "",
        "learning_level": "AUTO",
    }
    fields.update(overrides)
    return Session.objects.create(**fields)


def set_updated_at(session, offset_minutes):
    """Pin updated_at explicitly (.update bypasses auto_now) for ordering tests."""
    pinned = timezone.now() - timedelta(minutes=offset_minutes)
    Session.objects.filter(pk=session.pk).update(updated_at=pinned)
    session.refresh_from_db()
    return session


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
        make_session(user)

        response = api.get(SESSIONS_URL)

        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestListingShape:
    def test_empty_list_returns_paginated_envelope(self, authed_api):
        response = authed_api.get(SESSIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 0
        assert response.data["results"] == []
        assert response.data["next"] is None
        assert response.data["previous"] is None

    def test_items_expose_serializer_fields_only(self, authed_api, user):
        session = make_session(
            user,
            title="Coffee chat",
            topic_hint="travel",
            learning_level="B2",
            summary="secret rolling summary",
        )

        response = authed_api.get(SESSIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 1
        result = response.data["results"][0]
        assert set(result.keys()) == SERIALIZED_FIELDS
        assert result["id"] == session.id
        assert result["title"] == "Coffee chat"
        assert result["topic"] == "Topic for Coffee chat"
        assert result["topic_hint"] == "travel"
        assert result["learning_level"] == "B2"
        # Internal fields are never leaked through the listing payload.
        assert "summary" not in result
        assert "summary_message_boundary" not in result
        assert "updated_at" not in result


class TestUserScoping:
    def test_users_see_only_their_own_sessions(self, authed_api, user, stranger):
        mine_older = set_updated_at(make_session(user, title="Mine older"), 60)
        theirs_newest = set_updated_at(make_session(stranger, title="Theirs"), 10)
        mine_newer = set_updated_at(make_session(user, title="Mine newer"), 30)

        response = authed_api.get(SESSIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 2
        titles = [item["title"] for item in response.data["results"]]
        assert titles == ["Mine newer", "Mine older"]
        ids = {item["id"] for item in response.data["results"]}
        assert ids == {mine_older.id, mine_newer.id}
        assert theirs_newest.id not in ids


class TestOrdering:
    def test_most_recently_updated_first(self, authed_api, user):
        first = make_session(user, title="First created")
        second = make_session(user, title="Second created")
        third = make_session(user, title="Third created")
        set_updated_at(first, 300)
        set_updated_at(second, 180)
        set_updated_at(third, 60)

        response = authed_api.get(SESSIONS_URL)

        titles = [item["title"] for item in response.data["results"]]
        assert titles == ["Third created", "Second created", "First created"]

    def test_update_bumps_session_to_front(self, authed_api, user):
        old = set_updated_at(make_session(user, title="Old"), 120)
        recent = set_updated_at(make_session(user, title="Recent"), 10)
        old.save()  # auto_now refreshes updated_at -> becomes the newest row

        response = authed_api.get(SESSIONS_URL)

        titles = [item["title"] for item in response.data["results"]]
        assert titles == ["Old", "Recent"]
        assert old.updated_at > recent.updated_at


class TestPagination:
    @pytest.fixture
    def twenty_five(self, user):
        sessions = [make_session(user, title=f"Session {i:02d}") for i in range(25)]
        for index, session in enumerate(sessions):
            set_updated_at(session, index + 1)  # distinct, oldest first by creation order
        return sessions

    def test_first_page_is_capped_at_page_size_with_next_link(self, authed_api, twenty_five):
        response = authed_api.get(SESSIONS_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 25
        assert len(response.data["results"]) == 20
        assert response.data["previous"] is None
        assert response.data["next"] is not None
        assert "page=2" in response.data["next"]

    def test_second_page_returns_remainder_with_previous_link(self, authed_api, twenty_five):
        response = authed_api.get(SESSIONS_URL, {"page": 2})

        assert response.status_code == status.HTTP_200_OK
        assert len(response.data["results"]) == 5
        assert response.data["next"] is None
        assert response.data["previous"] is not None

    def test_pagination_preserves_ordering_across_pages(self, authed_api, twenty_five):
        first_page = authed_api.get(SESSIONS_URL).data["results"]
        second_page = authed_api.get(SESSIONS_URL, {"page": 2}).data["results"]

        titles = [item["title"] for item in [*first_page, *second_page]]
        # Offsets grow with the index, so Session 00 is the most recent.
        expected = [f"Session {i:02d}" for i in range(25)]
        assert titles == expected

    @pytest.mark.parametrize("page", ["999", "abc", "0"])
    def test_invalid_page_returns_404(self, authed_api, twenty_five, page):
        response = authed_api.get(SESSIONS_URL, {"page": page})

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_strangers_sessions_do_not_count_toward_my_pages(
        self, authed_api, user, stranger, twenty_five
    ):
        make_session(stranger, title="Stranger session")

        first = authed_api.get(SESSIONS_URL).data
        second = authed_api.get(SESSIONS_URL, {"page": 2}).data

        assert first["count"] == 25
        titles = {item["title"] for item in [*first["results"], *second["results"]]}
        assert "Stranger session" not in titles
