"""Tests for the custom application user model (TASK-011)."""

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError

pytestmark = pytest.mark.django_db


@pytest.fixture
def user_manager():
    return get_user_model().objects


class TestUserCreation:
    def test_create_user_with_username_email_password(self, user_manager):
        user = user_manager.create_user(
            username="alice",
            email="alice@example.com",
            password="correct-horse-battery",
        )

        assert user.pk is not None
        assert user.username == "alice"
        assert user.email == "alice@example.com"
        assert user.check_password("correct-horse-battery")

    def test_password_is_hashed_never_plaintext(self, user_manager):
        raw_password = "super-secret-plaintext"
        user = user_manager.create_user(
            username="bob", email="bob@example.com", password=raw_password
        )

        assert user.password != raw_password
        assert raw_password not in user.password
        assert "$" in user.password  # encoded format: <algorithm>$<salt>$<hash>
        assert user.check_password(raw_password)

    def test_email_domain_is_normalized(self, user_manager):
        user = user_manager.create_user(
            username="carol", email="carol@EXAMPLE.COM", password="pw-123456"
        )

        assert user.email == "carol@example.com"

    def test_create_superuser_sets_privilege_flags(self, user_manager):
        user = user_manager.create_superuser(
            username="root", email="root@example.com", password="admin-pw-123"
        )

        assert user.is_staff is True
        assert user.is_superuser is True
        assert user.check_password("admin-pw-123")


class TestUniquenessConstraints:
    def test_duplicate_username_rejected(self, user_manager):
        user_manager.create_user(username="dave", email="dave@example.com", password="pw-123456")

        with pytest.raises(IntegrityError):
            user_manager.create_user(
                username="dave", email="other@example.com", password="pw-123456"
            )

    def test_duplicate_email_rejected(self, user_manager):
        user_manager.create_user(username="erin", email="shared@example.com", password="pw-123456")

        with pytest.raises(IntegrityError):
            user_manager.create_user(
                username="frank", email="shared@example.com", password="pw-123456"
            )

    def test_missing_email_fails_model_validation(self, user_manager):
        user = get_user_model()(username="no-email")

        with pytest.raises(ValidationError) as excinfo:
            user.full_clean(exclude=["password", "last_login"])

        assert "email" in excinfo.value.error_dict


class TestAuthWiring:
    def test_settings_point_to_custom_model(self, settings):
        assert settings.AUTH_USER_MODEL == "accounts.User"

    def test_get_user_model_returns_accounts_user(self):
        from accounts.models import User

        assert get_user_model() is User

    def test_username_is_the_login_identifier(self):
        assert get_user_model().USERNAME_FIELD == "username"
