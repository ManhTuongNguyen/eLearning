"""Tests for the learning profile API (TASK-017).

Covers authenticated-only access, lazy profile provisioning on first read,
level updates, and rejection of invalid level values.
"""

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

from learning.models import Level, Profile

pytestmark = pytest.mark.django_db

PROFILE_URL = reverse("learning:profile")

USERNAME = "carol"
EMAIL = "carol@example.com"
PASSWORD = "pw-123456"


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


class TestAuthentication:
    def test_anonymous_get_is_rejected(self, api):
        response = api.get(PROFILE_URL)

        assert response.status_code == 401

    def test_anonymous_patch_is_rejected(self, api):
        response = api.patch(PROFILE_URL, {"level": Level.B1}, format="json")

        assert response.status_code == 401


class TestReadProfile:
    def test_get_provisions_profile_with_default_auto_level(self, authed_api, user):
        response = authed_api.get(PROFILE_URL)

        assert response.status_code == 200
        assert response.data == {"level": Level.AUTO}
        assert Profile.objects.filter(user=user).exists()

    def test_subsequent_reads_do_not_duplicate_profiles(self, authed_api):
        for _ in range(3):
            response = authed_api.get(PROFILE_URL)

            assert response.status_code == 200

        assert Profile.objects.count() == 1

    def test_get_returns_persisted_level(self, authed_api, user):
        Profile.objects.create(user=user, level=Level.C1)

        response = authed_api.get(PROFILE_URL)

        assert response.status_code == 200
        assert response.data == {"level": Level.C1}


class TestUpdateProfile:
    def test_patch_updates_and_persists_level(self, authed_api, user):
        response = authed_api.patch(PROFILE_URL, {"level": Level.B2}, format="json")

        assert response.status_code == 200
        assert response.data == {"level": Level.B2}
        assert Profile.objects.get(user=user).level == Level.B2

    @pytest.mark.parametrize("level", list(Level.values))
    def test_every_documented_level_is_accepted(self, authed_api, user, level):
        response = authed_api.patch(PROFILE_URL, {"level": level}, format="json")

        assert response.status_code == 200
        assert Profile.objects.get(user=user).level == level

    @pytest.mark.parametrize("payload", [{"level": "Z9"}, {"level": "b1"}, {"level": ""}])
    def test_invalid_levels_are_rejected_without_writing(self, authed_api, user, payload):
        response = authed_api.patch(PROFILE_URL, payload, format="json")

        assert response.status_code == 400
        assert "level" in response.data
        assert Profile.objects.get(user=user).level == Level.AUTO

    def test_unknown_fields_are_ignored(self, authed_api, user):
        other = get_user_model().objects.create_user(
            username="mallory", email="mallory@example.com", password="pw-123456"
        )

        response = authed_api.patch(
            PROFILE_URL,
            {"level": Level.A2, "user": other.pk},
            format="json",
        )

        assert response.status_code == 200
        profile = Profile.objects.get(user=user)
        assert profile.level == Level.A2
        assert profile.user_id == user.pk

    def test_users_cannot_read_or_change_another_profile(self, api, user):
        other = get_user_model().objects.create_user(
            username="dave", email="dave@example.com", password="pw-123456"
        )
        theirs = Profile.objects.create(user=other, level=Level.C2)

        api.force_authenticate(user=user)
        patched = api.patch(PROFILE_URL, {"level": Level.A1}, format="json")
        fetched = api.get(PROFILE_URL)

        assert patched.status_code == 200
        assert fetched.data == {"level": Level.A1}
        theirs.refresh_from_db()
        assert theirs.level == Level.C2


class TestUnsupportedMethods:
    def test_post_is_not_allowed(self, authed_api):
        response = authed_api.post(PROFILE_URL, {"level": Level.B1}, format="json")

        assert response.status_code == 405

    def test_put_is_not_allowed(self, authed_api):
        response = authed_api.put(PROFILE_URL, {"level": Level.B1}, format="json")

        assert response.status_code == 405

    def test_delete_is_not_allowed(self, authed_api):
        response = authed_api.delete(PROFILE_URL)

        assert response.status_code == 405
