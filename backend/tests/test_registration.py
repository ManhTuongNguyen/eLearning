"""Tests for the POST /api/v1/auth/register/ endpoint (TASK-012)."""

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

REGISTER_URL = reverse("accounts:register")

VALID_PAYLOAD = {
    "username": "alice",
    "email": "alice@example.com",
    "password": "correct-horse-battery",
}


@pytest.fixture
def api():
    return APIClient()


def register(api_client: APIClient, **overrides) -> object:
    """POST a registration payload, dropping keys explicitly set to None."""
    payload = {**VALID_PAYLOAD, **overrides}
    payload = {key: value for key, value in payload.items() if value is not None}
    return api_client.post(REGISTER_URL, payload, format="json")


class TestRegistrationSuccess:
    def test_valid_registration_returns_201_and_user_data(self, api):
        response = register(api)

        assert response.status_code == 201
        assert response.data["username"] == "alice"
        assert response.data["email"] == "alice@example.com"
        assert "password" not in response.data

    def test_registered_user_is_persisted_and_can_authenticate(self, api):
        response = register(api)
        user = get_user_model().objects.get(pk=response.data["id"])

        assert user.username == "alice"
        assert user.check_password(VALID_PAYLOAD["password"])
        assert not user.is_staff and not user.is_superuser

    def test_password_is_stored_hashed_never_plaintext(self, api):
        raw_password = VALID_PAYLOAD["password"]
        register(api, password=raw_password)
        user = get_user_model().objects.get(username="alice")

        assert user.password != raw_password
        assert raw_password not in user.password
        assert "$" in user.password  # encoded format: <algorithm>$<salt>$<hash>

    def test_email_domain_is_normalized(self, api):
        response = register(api, email="alice@EXAMPLE.COM")

        assert response.status_code == 201
        assert response.data["email"] == "alice@example.com"
        assert get_user_model().objects.get(username="alice").email == "alice@example.com"


class TestRegistrationValidation:
    def test_duplicate_username_is_rejected(self, api):
        first = register(api)
        second = register(api, email="other@example.com")

        assert first.status_code == 201
        assert second.status_code == 400
        assert "username" in second.data
        assert get_user_model().objects.filter(email="other@example.com").count() == 0

    def test_duplicate_email_is_rejected(self, api):
        first = register(api)
        second = register(api, username="bob")

        assert first.status_code == 201
        assert second.status_code == 400
        assert "email" in second.data
        assert get_user_model().objects.filter(username="bob").count() == 0

    @pytest.mark.parametrize("missing_field", ["username", "email", "password"])
    def test_missing_required_field_is_rejected(self, api, missing_field):
        response = register(api, **{missing_field: None})

        assert response.status_code == 400
        assert missing_field in response.data

    def test_invalid_email_format_is_rejected(self, api):
        response = register(api, email="not-an-email")

        assert response.status_code == 400
        assert "email" in response.data

    def test_too_short_password_is_rejected(self, api):
        response = register(api, password="aB3$xk")

        assert response.status_code == 400
        assert "password" in response.data

    def test_common_password_is_rejected(self, api):
        response = register(api, password="password")

        assert response.status_code == 400
        assert "password" in response.data

    def test_numeric_only_password_is_rejected(self, api):
        response = register(api, password="981726354")

        assert response.status_code == 400
        assert "password" in response.data

    def test_password_similar_to_username_is_rejected(self, api):
        # Near-identical to the username so the similarity ratio exceeds 0.7.
        response = register(
            api,
            username="walterwhite",
            email="heisenberg@example.com",
            password="WalterWhite!",
        )

        assert response.status_code == 400
        assert "password" in response.data

    def test_validation_failure_creates_no_user(self, api):
        register(api, password="password")

        assert get_user_model().objects.count() == 0


class TestEndpointBehavior:
    def test_get_is_not_allowed(self, api):
        response = api.get(REGISTER_URL)

        assert response.status_code == 405

    def test_registration_works_without_authentication(self, api):
        # Explicitly unauthenticated client must reach the public endpoint.
        api.force_authenticate(user=None)
        response = register(api)

        assert response.status_code == 201
