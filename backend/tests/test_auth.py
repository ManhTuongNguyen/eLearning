"""Tests for JWT authentication endpoints (TASK-013).

Covers login (username or email), token refresh, access-token expiry and
protection of authenticated endpoints.
"""

from datetime import timedelta

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

pytestmark = pytest.mark.django_db

LOGIN_URL = reverse("accounts:login")
REFRESH_URL = reverse("accounts:refresh")
ME_URL = reverse("accounts:me")

USERNAME = "alice"
EMAIL = "alice@example.com"
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


def login(api_client: APIClient, identifier: str = USERNAME, password: str = PASSWORD):
    return api_client.post(
        LOGIN_URL,
        {get_user_model().USERNAME_FIELD: identifier, "password": password},
        format="json",
    )


class TestLoginSuccess:
    def test_login_with_username_returns_tokens(self, api, user):
        response = login(api)

        assert response.status_code == 200
        assert response.data["access"]
        assert response.data["refresh"]
        assert response.data["user"]["username"] == USERNAME
        assert "password" not in response.data

    def test_login_with_email_returns_tokens(self, api, user):
        response = login(api, identifier=EMAIL)

        assert response.status_code == 200
        assert response.data["access"]

    def test_login_with_mixed_case_email_returns_tokens(self, api, user):
        # Stored emails have normalized domains; lookup must be case-insensitive.
        response = login(api, identifier="Alice@Example.COM")

        assert response.status_code == 200
        assert response.data["access"]

    def test_issued_access_token_authenticates_me_endpoint(self, api, user):
        access = login(api).data["access"]

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {access}")

        assert response.status_code == 200
        assert response.data["id"] == user.pk
        assert response.data["email"] == EMAIL

    def test_login_response_never_contains_password(self, api, user):
        body = login(api).content.decode()

        assert PASSWORD not in body


class TestLoginFailure:
    def test_wrong_password_is_rejected(self, api, user):
        response = login(api, password="not-the-password")

        assert response.status_code == 401
        assert get_user_model().objects.count() == 1

    def test_unknown_identifier_is_rejected(self, api, user):
        response = login(api, identifier="nobody@example.com")

        assert response.status_code == 401

    @pytest.mark.parametrize("payload", [{}, {"username": USERNAME}, {"password": PASSWORD}])
    def test_missing_fields_are_rejected(self, api, payload):
        response = api.post(LOGIN_URL, payload, format="json")

        assert response.status_code == 400

    def test_inactive_user_is_rejected(self, api, user):
        user.is_active = False
        user.save()

        response = login(api)

        assert response.status_code == 401


class TestRefreshFlow:
    def test_valid_refresh_returns_new_access_token(self, api, user):
        refresh = login(api).data["refresh"]

        response = api.post(REFRESH_URL, {"refresh": refresh}, format="json")

        assert response.status_code == 200
        new_access = response.data["access"]
        me_response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {new_access}")
        assert me_response.status_code == 200
        assert me_response.data["username"] == USERNAME

    def test_garbage_refresh_token_is_rejected(self, api):
        response = api.post(REFRESH_URL, {"refresh": "garbage-token"}, format="json")

        assert response.status_code == 401

    def test_access_token_cannot_be_used_as_refresh(self, api, user):
        access = login(api).data["access"]

        response = api.post(REFRESH_URL, {"refresh": access}, format="json")

        assert response.status_code == 401

    def test_missing_refresh_field_is_rejected(self, api):
        response = api.post(REFRESH_URL, {}, format="json")

        assert response.status_code == 400


class TestAccessTokenExpiry:
    def test_expired_access_token_is_rejected(self, api, user):
        token = AccessToken.for_user(user)
        token.set_exp(
            from_time=timezone.now() - timedelta(hours=2),
            lifetime=timedelta(minutes=30),
        )

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {token}")

        assert response.status_code == 401

    def test_tampered_token_is_rejected(self, api, user):
        access = login(api).data["access"]

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {access}tampered")

        assert response.status_code == 401


class TestProtectedEndpointsRejectAnonymous:
    def test_me_without_credentials_is_rejected(self, api):
        response = api.get(ME_URL)

        assert response.status_code == 401

    def test_rejection_is_unauthorized_not_forbidden(self, api):
        # A 401 (not 403) tells clients that authenticating may help.
        response = api.get(ME_URL)

        assert response["WWW-Authenticate"].startswith("Bearer")

    def test_public_endpoints_remain_open(self, api, user):
        assert api.get("/api/v1/health/").status_code == 200
        assert login(api).status_code == 200


class TestJwtSettingsWiring:
    def test_lifetimes_derive_from_environment_settings(self):
        from config.settings import SIMPLE_JWT

        assert SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"] == timedelta(
            minutes=settings.JWT_ACCESS_TOKEN_MINUTES
        )
        assert SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"] == timedelta(
            days=settings.JWT_REFRESH_TOKEN_DAYS
        )
