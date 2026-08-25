"""Tests for logout / refresh-token invalidation (TASK-014).

Covers blacklisting of refresh tokens at logout, rejection of subsequent
refresh attempts, survival of unrelated tokens, and input validation.
"""

from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

pytestmark = pytest.mark.django_db

LOGIN_URL = reverse("accounts:login")
LOGOUT_URL = reverse("accounts:logout")
REFRESH_URL = reverse("accounts:refresh")
ME_URL = reverse("accounts:me")

USERNAME = "bob"
EMAIL = "bob@example.com"
PASSWORD = "correct-horse-battery"


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


def login(api_client: APIClient):
    return api_client.post(
        LOGIN_URL,
        {get_user_model().USERNAME_FIELD: USERNAME, "password": PASSWORD},
        format="json",
    )


def authed_logout(api_client: APIClient, access: str, refresh: str):
    return api_client.post(
        LOGOUT_URL,
        {"refresh": refresh},
        format="json",
        HTTP_AUTHORIZATION=f"Bearer {access}",
    )


class TestLogoutSuccess:
    def test_authenticated_logout_succeeds(self, api, user):
        tokens = login(api).data

        response = authed_logout(api, tokens["access"], tokens["refresh"])

        assert response.status_code == 200

    def test_logout_persists_a_blacklist_record(self, api, user):
        tokens = login(api).data

        authed_logout(api, tokens["access"], tokens["refresh"])

        assert BlacklistedToken.objects.count() == 1

    def test_blacklisted_refresh_token_can_no_longer_refresh(self, api, user):
        tokens = login(api).data
        authed_logout(api, tokens["access"], tokens["refresh"])

        response = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 401

    def test_access_token_remains_valid_until_expiry_after_logout(self, api, user):
        # MVP invalidation strategy: only the refresh token is revoked;
        # outstanding access tokens expire on their own short lifetime.
        tokens = login(api).data
        authed_logout(api, tokens["access"], tokens["refresh"])

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

        assert response.status_code == 200

    def test_other_refresh_tokens_are_unaffected_by_one_logout(self, api, user):
        first = login(api).data
        second = login(api).data
        authed_logout(api, first["access"], first["refresh"])

        response = api.post(REFRESH_URL, {"refresh": second["refresh"]}, format="json")

        assert response.status_code == 200


class TestLogoutValidation:
    def test_anonymous_logout_is_rejected(self, api, user):
        tokens = login(api).data

        response = api.post(LOGOUT_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 401

    @pytest.mark.parametrize("payload", [{}, {"refresh": ""}])
    def test_missing_or_blank_refresh_field_is_rejected(self, api, user, payload):
        access = login(api).data["access"]

        response = api.post(
            LOGOUT_URL,
            payload,
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )

        assert response.status_code == 400

    def test_garbage_refresh_token_is_rejected(self, api, user):
        access = login(api).data["access"]

        response = authed_logout(api, access, "garbage-token")

        assert response.status_code == 400

    def test_access_token_cannot_be_used_as_refresh_at_logout(self, api, user):
        tokens = login(api).data

        response = authed_logout(api, tokens["access"], tokens["access"])

        assert response.status_code == 400

    def test_expired_refresh_token_is_rejected(self, api, user):
        expired = RefreshToken.for_user(user)
        expired.set_exp(
            from_time=timezone.now() - timedelta(hours=2),
            lifetime=timedelta(minutes=30),
        )
        access = login(api).data["access"]

        response = authed_logout(api, access, str(expired))

        assert response.status_code == 400

    def test_already_blacklisted_refresh_token_is_rejected(self, api, user):
        tokens = login(api).data
        authed_logout(api, tokens["access"], tokens["refresh"])

        response = authed_logout(api, tokens["access"], tokens["refresh"])

        assert response.status_code == 400

    def test_get_is_not_allowed(self, api, user):
        access = login(api).data["access"]

        response = api.get(LOGOUT_URL, HTTP_AUTHORIZATION=f"Bearer {access}")

        assert response.status_code == 405


class TestLogoutLifecycle:
    def test_full_login_use_logout_cycle(self, api, user):
        tokens = login(api).data
        me = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        logout = authed_logout(api, tokens["access"], tokens["refresh"])
        refresh_again = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert me.status_code == 200
        assert logout.status_code == 200
        assert refresh_again.status_code == 401
