"""End-to-end authentication integration tests (TASK-105).

Exercises the complete authentication lifecycle across endpoints with the
real API surface only (no model shortcuts to create state):
register -> login -> me -> refresh -> logout -> blacklisted refresh ->
unauthorized access.
"""

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

REGISTER_URL = reverse("accounts:register")
LOGIN_URL = reverse("accounts:login")
LOGOUT_URL = reverse("accounts:logout")
REFRESH_URL = reverse("accounts:refresh")
ME_URL = reverse("accounts:me")

USERNAME = "carol"
EMAIL = "carol@example.com"
PASSWORD = "correct-horse-battery"


@pytest.fixture
def api():
    return APIClient()


def register(api_client: APIClient, **overrides):
    payload = {"username": USERNAME, "email": EMAIL, "password": PASSWORD, **overrides}
    payload = {key: value for key, value in payload.items() if value is not None}
    return api_client.post(REGISTER_URL, payload, format="json")


def login(api_client: APIClient, identifier: str = USERNAME, password: str = PASSWORD):
    return api_client.post(
        LOGIN_URL,
        {get_user_model().USERNAME_FIELD: identifier, "password": password},
        format="json",
    )


class TestFullAuthLifecycle:
    def test_register_login_me_refresh_logout_end_to_end(self, api):
        registered = register(api)
        assert registered.status_code == 201
        assert get_user_model().objects.filter(username=USERNAME).exists()

        tokens = login(api).data
        assert set(tokens) >= {"access", "refresh"}

        me = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        assert me.status_code == 200
        assert me.data["username"] == USERNAME

        refreshed = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")
        assert refreshed.status_code == 200
        new_access = refreshed.data["access"]
        assert new_access

        me_with_refreshed = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {new_access}")
        assert me_with_refreshed.status_code == 200

        logout = api.post(
            LOGOUT_URL,
            {"refresh": tokens["refresh"]},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {tokens['access']}",
        )
        assert logout.status_code == 200

        blacklisted = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")
        assert blacklisted.status_code == 401

    def test_registered_user_can_login_with_email(self, api):
        register(api)

        response = login(api, identifier=EMAIL.upper())

        assert response.status_code == 200
        assert response.data["user"]["email"] == EMAIL

    def test_registered_credentials_are_not_valid_before_registration(self, api):
        response = login(api)

        assert response.status_code == 401


class TestMeEndpointIntegration:
    def test_me_returns_exact_public_payload_shape(self, api):
        user_id = register(api).data["id"]
        access = login(api).data["access"]

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {access}")

        assert response.status_code == 200
        assert set(response.data) == {"id", "username", "email"}
        assert response.data["id"] == user_id
        assert response.data["username"] == USERNAME
        assert response.data["email"] == EMAIL
        assert "password" not in response.data


class TestRefreshIntegration:
    def test_refresh_cycle_repeatedly_yields_working_access_tokens(self, api):
        # ROTATE_REFRESH_TOKENS is disabled: the same refresh token stays
        # usable and each refresh yields a fresh, working access token.
        register(api)
        refresh = login(api).data["refresh"]

        for _ in range(3):
            response = api.post(REFRESH_URL, {"refresh": refresh}, format="json")
            assert response.status_code == 200
            me = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
            assert me.status_code == 200


class TestInactiveUserTokenRejection:
    def test_deactivated_user_token_is_rejected_at_me(self, api):
        register(api)
        tokens = login(api).data

        user = get_user_model().objects.get(username=USERNAME)
        user.is_active = False
        user.save()

        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")

        assert response.status_code == 401

    def test_deactivated_user_refresh_token_is_rejected(self, api):
        register(api)
        tokens = login(api).data

        user = get_user_model().objects.get(username=USERNAME)
        user.is_active = False
        user.save()

        response = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 401


class TestUnauthorizedAccessIntegration:
    def test_protected_endpoint_rejects_anonymous_client(self, api):
        response = api.get(ME_URL)

        assert response.status_code == 401
        assert response["WWW-Authenticate"].startswith("Bearer")

    def test_garbage_bearer_token_is_rejected(self, api):
        response = api.get(ME_URL, HTTP_AUTHORIZATION="Bearer not-a-real-token")

        assert response.status_code == 401

    def test_logout_requires_authentication(self, api):
        response = api.post(LOGOUT_URL, {"refresh": "anything"}, format="json")

        assert response.status_code == 401
