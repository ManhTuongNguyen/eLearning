"""Tests for the session rename API (TASK-033).

Covers PATCH /api/v1/sessions/{id}/: authenticated-only access, per-user
ownership scoping (a foreign or missing session is an indistinguishable
404), title-only mutation (every other field is immutable through the
endpoint regardless of payload content), validation of the required
non-blank title, and the response contract matching GET detail.
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

USERNAME = "frida"
EMAIL = "frida@example.com"
PASSWORD = "pw-123456"

SESSION_FIELDS = {"id", "title", "topic", "topic_hint", "learning_level", "created_at"}


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


def rename_url(session):
    return reverse("conversations:session-detail", kwargs={"pk": session.id})


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
    def test_anonymous_rename_is_rejected(self, api, user):
        session = make_session(user)

        response = api.patch(rename_url(session), {"title": "Renamed"}, format="json")

        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        session.refresh_from_db()
        assert session.title == "A conversation"


class TestRename:
    def test_owner_renames_own_session(self, authed_api, user):
        session = make_session(user, title="Old title")

        response = authed_api.patch(rename_url(session), {"title": "New title"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == "New title"

    def test_response_is_the_full_session_representation(self, authed_api, user):
        session = make_session(
            user,
            title="Old title",
            topic_hint="travel",
            learning_level="B2",
            summary="internal rolling summary",
            summary_message_boundary=3,
        )

        response = authed_api.patch(rename_url(session), {"title": "New title"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        assert set(response.data.keys()) == SESSION_FIELDS
        assert response.data["id"] == session.id
        assert response.data["title"] == "New title"
        assert response.data["topic"] == "Topic for Old title"
        assert response.data["topic_hint"] == "travel"
        assert response.data["learning_level"] == "B2"
        # Internal fields never leak through the rename payload.
        assert "summary" not in response.data
        assert "summary_message_boundary" not in response.data
        assert "updated_at" not in response.data

    def test_surrounding_whitespace_is_stripped(self, authed_api, user):
        session = make_session(user)

        response = authed_api.patch(
            rename_url(session), {"title": "  Padded name  "}, format="json"
        )

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == "Padded name"

    def test_numeric_title_payload_is_coerced_to_string(self, authed_api, user):
        session = make_session(user)

        response = authed_api.patch(rename_url(session), {"title": 42}, format="json")

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == "42"

    def test_rename_bumps_session_to_front_of_listing_ordering(self, authed_api, user):
        older = set_updated_at(make_session(user, title="Older"), 60)
        set_updated_at(make_session(user, title="Newer"), 10)

        response = authed_api.get("/api/v1/sessions/")
        assert [item["title"] for item in response.data["results"]] == ["Newer", "Older"]

        authed_api.patch(rename_url(older), {"title": "Renamed"}, format="json")

        response = authed_api.get("/api/v1/sessions/")
        assert [item["title"] for item in response.data["results"]] == ["Renamed", "Newer"]


class TestImmutability:
    def test_other_fields_cannot_be_changed_through_the_endpoint(self, authed_api, user):
        session = make_session(
            user,
            title="Original",
            topic_hint="original hint",
            learning_level="B2",
            summary="internal summary",
            summary_message_boundary=5,
        )
        original_created_at = session.created_at

        hijack = {
            "topic": "hijacked topic",
            "topic_hint": "hijacked hint",
            "learning_level": "C2",
            "summary": "hijacked summary",
            "summary_message_boundary": 999,
            "user": 123456,
            "id": 999999,
            "created_at": "2000-01-01T00:00:00Z",
        }
        payload = {"title": "Renamed", **hijack}

        response = authed_api.patch(rename_url(session), payload, format="json")

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == "Renamed"
        assert session.topic == "Topic for Original"
        assert session.topic_hint == "original hint"
        assert session.learning_level == "B2"
        assert session.summary == "internal summary"
        assert session.summary_message_boundary == 5
        assert session.user_id == user.id
        assert session.id != 999999
        assert session.created_at == original_created_at

    def test_title_only_payload_leaves_everything_else_alone(self, authed_api, user):
        session = make_session(user, title="Before", topic_hint="hint")

        response = authed_api.patch(rename_url(session), {"title": "After"}, format="json")

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == "After"
        assert session.topic == "Topic for Before"
        assert session.topic_hint == "hint"


class TestOwnership:
    def test_strangers_session_returns_404_and_stays_untouched(self, authed_api, user, stranger):
        theirs = make_session(stranger, title="Not mine")

        response = authed_api.patch(rename_url(theirs), {"title": "Hijacked"}, format="json")

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert "detail" in response.data
        theirs.refresh_from_db()
        assert theirs.title == "Not mine"

    def test_missing_session_returns_404(self, authed_api, user):
        url = reverse("conversations:session-detail", kwargs={"pk": 999999})

        response = authed_api.patch(url, {"title": "Ghost"}, format="json")

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_non_integer_pk_does_not_match_the_route(self, authed_api):
        response = authed_api.patch("/api/v1/sessions/abc/", {"title": "X"}, format="json")

        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestValidation:
    @pytest.mark.parametrize("payload", [{}, {"title": ""}, {"title": "   "}])
    def test_missing_or_blank_title_is_rejected(self, authed_api, user, payload):
        session = make_session(user)

        response = authed_api.patch(rename_url(session), payload, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "title" in response.data
        session.refresh_from_db()
        assert session.title == "A conversation"

    def test_overlong_title_is_rejected(self, authed_api, user):
        session = make_session(user)

        response = authed_api.patch(rename_url(session), {"title": "x" * 256}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "title" in response.data
        session.refresh_from_db()
        assert session.title == "A conversation"

    def test_max_length_title_is_accepted(self, authed_api, user):
        session = make_session(user)
        longest = "y" * 255

        response = authed_api.patch(rename_url(session), {"title": longest}, format="json")

        assert response.status_code == status.HTTP_200_OK
        session.refresh_from_db()
        assert session.title == longest


class TestMethodMatrix:
    @pytest.mark.parametrize("method", ["post", "put"])
    def test_unsupported_methods_are_rejected(self, authed_api, user, method):
        session = make_session(user)

        response = getattr(authed_api, method)(rename_url(session), {}, format="json")

        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED

    def test_get_still_works_after_patch_support_was_added(self, authed_api, user):
        session = make_session(user)

        response = authed_api.get(rename_url(session))

        assert response.status_code == status.HTTP_200_OK
        assert set(response.data.keys()) == SESSION_FIELDS
