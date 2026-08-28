"""Tests for authentication security (TASK-099).

Covers:
- Password hashing (no plaintext storage, unique salts).
- Password validation (length, common, numeric, similarity).
- Login does not reveal whether the account exists.
- Refresh tokens are blacklisted after logout.
- Tampered access tokens are rejected.
- Throttling on authentication endpoints (login/register/refresh/logout).
- Security response headers (WWW-Authenticate on 401).
- Mobile token storage: keys never persist in plain AsyncStorage (the
  mobile-side test lives in mobile/__tests__; here we only confirm the
  server never returns tokens in error payloads or logs).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.urls import reverse
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

USERNAME = "alice"
EMAIL = "alice@example.com"
PASSWORD = "correct-horse-battery-staple"

REGISTER_URL = reverse("accounts:register")
LOGIN_URL = reverse("accounts:login")
REFRESH_URL = reverse("accounts:refresh")
LOGOUT_URL = reverse("accounts:logout")
ME_URL = reverse("accounts:me")


@pytest.fixture(autouse=True)
def _clear_throttle_cache():
    """Clear throttle cache before each test to avoid cross-test pollution."""
    cache.clear()
    yield
    cache.clear()


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


def login(api_client, identifier=USERNAME, password=PASSWORD):
    return api_client.post(
        LOGIN_URL,
        {get_user_model().USERNAME_FIELD: identifier, "password": password},
        format="json",
    )


# --- Password handling -------------------------------------------------------


class TestPasswordStorage:
    def test_password_is_hashed_not_stored_in_plaintext(self, user):
        """create_user must hash the password before persisting it."""
        user.refresh_from_db()
        assert user.password != PASSWORD
        # Django's default hashing uses the pbkdf2_sha256 algorithm prefix.
        assert user.password.startswith(("pbkdf2_sha256$", "argon2$", "bcrypt$"))

    def test_hashed_passwords_have_unique_salts(self, api):
        """Two users with the same password get distinct stored hashes."""
        get_user_model().objects.create_user(
            username="u1", email="u1@example.com", password=PASSWORD
        )
        get_user_model().objects.create_user(
            username="u2", email="u2@example.com", password=PASSWORD
        )
        u1 = get_user_model().objects.get(username="u1")
        u2 = get_user_model().objects.get(username="u2")
        assert u1.password != u2.password
        assert u1.check_password(PASSWORD) is True
        assert u2.check_password(PASSWORD) is True

    def test_check_password_validates_against_hash(self, user):
        assert user.check_password(PASSWORD) is True
        assert user.check_password("wrong") is False


class TestPasswordValidation:
    def test_short_password_is_rejected(self, api):
        """The MinimumLengthValidator (default 8 chars) rejects tiny passwords."""
        response = api.post(
            REGISTER_URL,
            {"username": "x", "email": "x@example.com", "password": "short"},
            format="json",
        )
        assert response.status_code == 400
        assert "password" in response.data

    def test_common_password_is_rejected(self, api):
        """The CommonPasswordValidator rejects well-known leaked passwords."""
        response = api.post(
            REGISTER_URL,
            {"username": "x", "email": "x@example.com", "password": "password"},
            format="json",
        )
        assert response.status_code == 400
        assert "password" in response.data

    def test_numeric_only_password_is_rejected(self, api):
        """The NumericPasswordValidator rejects entirely numeric passwords."""
        response = api.post(
            REGISTER_URL,
            {"username": "x", "email": "x@example.com", "password": "1234567890"},
            format="json",
        )
        assert response.status_code == 400
        assert "password" in response.data

    def test_similarity_to_username_is_rejected(self, api):
        """The UserAttributeSimilarityValidator rejects passwords matching the username."""
        response = api.post(
            REGISTER_URL,
            {
                "username": "alice",
                "email": "alice@example.com",
                "password": "alice",  # Exact username match is rejected
            },
            format="json",
        )
        assert response.status_code == 400
        assert "password" in response.data


# --- Login response & account enumeration -----------------------------------


class TestLoginResponseSecurity:
    def test_login_response_never_contains_password(self, user, api):
        body = login(api).content.decode()
        assert PASSWORD not in body

    def test_registration_response_never_contains_password(self, api):
        response = api.post(
            REGISTER_URL,
            {"username": "bob", "email": "bob@example.com", "password": PASSWORD},
            format="json",
        )
        body = response.content.decode()
        assert PASSWORD not in body

    def test_login_response_does_not_leak_user_existence(self, user, api):
        """Wrong password and unknown identifier both return 401 with the same body."""
        wrong_pw = login(api, password="not-the-password")
        unknown = login(api, identifier="nobody@example.com")
        assert wrong_pw.status_code == 401
        assert unknown.status_code == 401
        # The two responses are indistinguishable to the caller.
        assert wrong_pw.json() == unknown.json()

    def test_login_response_uses_www_authenticate_header(self, user, api):
        """401 responses carry the Bearer challenge so clients know how to retry."""
        response = login(api, password="nope")
        assert response.status_code == 401
        assert response["WWW-Authenticate"].startswith("Bearer")


# --- Token blacklist / refresh rotation --------------------------------------


class TestRefreshTokenInvalidation:
    def test_refresh_token_is_blacklisted_after_logout(self, user, api):
        refresh = login(api).data["refresh"]
        access = login(api).data["access"]

        logout = api.post(
            LOGOUT_URL,
            {"refresh": refresh},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )
        assert logout.status_code == 200

        # A blacklisted refresh token cannot mint a new access token.
        response = api.post(REFRESH_URL, {"refresh": refresh}, format="json")
        assert response.status_code == 401

    def test_blacklisted_token_stays_blacklisted_across_uses(self, user, api):
        """Repeated use of a blacklisted refresh token never re-enables it."""
        refresh = login(api).data["refresh"]
        access = login(api).data["access"]
        api.post(
            LOGOUT_URL,
            {"refresh": refresh},
            format="json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )

        for _ in range(3):
            response = api.post(REFRESH_URL, {"refresh": refresh}, format="json")
            assert response.status_code == 401


# --- Tampered / forged tokens -----------------------------------------------


class TestTokenIntegrity:
    def test_tampered_access_token_is_rejected(self, user, api):
        access = login(api).data["access"]
        response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {access}garbage")
        assert response.status_code == 401

    def test_forged_token_with_random_payload_is_rejected(self, api):
        """A token with valid structure but the wrong signature is rejected."""
        response = api.get(
            ME_URL,
            HTTP_AUTHORIZATION=(
                "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.bogus-signature"
            ),
        )
        assert response.status_code == 401


# --- Rate limiting on authentication endpoints ------------------------------


class TestAuthenticationThrottling:
    """Per-IP throttling must engage on repeated identity-establishing calls."""

    def test_register_throttle_engages_after_quota(self, api):
        from django.core.cache import cache

        cache.clear()
        with patch.object(
            settings,
            "REST_FRAMEWORK",
            {
                **settings.REST_FRAMEWORK,
                "DEFAULT_THROTTLE_RATES": {
                    **settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
                    "auth": "3/min",
                },
            },
        ):
            for i in range(3):
                response = api.post(
                    REGISTER_URL,
                    {
                        "username": f"u{i}",
                        "email": f"u{i}@example.com",
                        "password": PASSWORD,
                    },
                    format="json",
                )
                assert response.status_code == 201
            blocked = api.post(
                REGISTER_URL,
                {"username": "uX", "email": "uX@example.com", "password": PASSWORD},
                format="json",
            )
            assert blocked.status_code == 429
            assert blocked.data["error"]["details"]["retry_after_seconds"] is not None

    def test_login_throttle_engages_after_quota(self, user, api):
        from django.core.cache import cache

        cache.clear()
        with patch.object(
            settings,
            "REST_FRAMEWORK",
            {
                **settings.REST_FRAMEWORK,
                "DEFAULT_THROTTLE_RATES": {
                    **settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
                    "auth": "3/min",
                },
            },
        ):
            for _ in range(3):
                # Use a wrong password to avoid rotating tokens, but the
                # request still hits the endpoint and counts against quota.
                login(api, password="wrong")
            blocked = login(api, password="wrong")
            assert blocked.status_code == 429

    def test_refresh_throttle_engages_after_quota(self, user, api):
        from django.core.cache import cache

        cache.clear()
        with patch.object(
            settings,
            "REST_FRAMEWORK",
            {
                **settings.REST_FRAMEWORK,
                "DEFAULT_THROTTLE_RATES": {
                    **settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
                    "auth": "3/min",
                },
            },
        ):
            for _ in range(3):
                api.post(REFRESH_URL, {"refresh": "garbage"}, format="json")
            blocked = api.post(REFRESH_URL, {"refresh": "garbage"}, format="json")
            assert blocked.status_code == 429

    def test_throttle_buckets_are_per_ip(self, user, api):
        """Different client IPs have independent throttle buckets."""
        from django.core.cache import cache

        cache.clear()
        with patch.object(
            settings,
            "REST_FRAMEWORK",
            {
                **settings.REST_FRAMEWORK,
                "DEFAULT_THROTTLE_RATES": {
                    **settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],
                    "auth": "2/min",
                },
            },
        ):
            for _ in range(2):
                api.post(
                    REFRESH_URL,
                    {"refresh": "garbage"},
                    format="json",
                    REMOTE_ADDR="1.1.1.1",
                )
            blocked = api.post(
                REFRESH_URL,
                {"refresh": "garbage"},
                format="json",
                REMOTE_ADDR="1.1.1.1",
            )
            assert blocked.status_code == 429
            # A different IP starts with a fresh budget.
            other = api.post(
                REFRESH_URL,
                {"refresh": "garbage"},
                format="json",
                REMOTE_ADDR="2.2.2.2",
            )
            assert other.status_code == 401


# --- Secret handling ---------------------------------------------------------


class TestServerSecretHandling:
    def test_settings_refuse_to_run_without_secrets_in_production(self):
        """Production validation rejects the dev fallback secret key."""
        from django.core.exceptions import ImproperlyConfigured

        from config.settings import _DEV_SECRET_KEY, validate_production_configuration

        with pytest.raises(ImproperlyConfigured):
            validate_production_configuration(
                secret_key=_DEV_SECRET_KEY,
                allowed_hosts=["x"],
                database_password="db",
                llm_provider="openrouter",
                provider_api_key="key",
            )

    def test_settings_refuse_empty_secrets(self):
        from django.core.exceptions import ImproperlyConfigured

        from config.settings import validate_production_configuration

        with pytest.raises(ImproperlyConfigured):
            validate_production_configuration(
                secret_key="",
                allowed_hosts=[],
                database_password="",
                llm_provider="openrouter",
                provider_api_key="",
            )

    def test_error_handler_does_not_leak_secrets(self):
        """Even when an exception contains a secret, it never reaches the response."""
        from api.errors import api_exception_handler

        response = api_exception_handler(RuntimeError("sk-abcdef-secret-key"), {})
        body = str(response.data)
        assert "sk-abcdef-secret-key" not in body
        assert response.status_code == 500
