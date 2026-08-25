"""Tests for the learning profile model (TASK-016)."""

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models

from learning.models import Level, Profile

pytestmark = pytest.mark.django_db


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


class TestProfileCreation:
    def test_default_level_is_auto(self, user):
        profile = Profile.objects.create(user=user)

        assert profile.pk is not None
        assert profile.level == Level.AUTO

    def test_every_level_persists(self, user):
        for level in Level:
            other = get_user_model().objects.create_user(
                username=f"u-{level.value.lower()}",
                email=f"{level.value.lower()}@example.com",
                password="pw-123456",
            )
            profile = Profile.objects.create(user=other, level=level)

            profile.refresh_from_db()
            assert profile.level == level

    def test_str_shows_username_and_level(self, user):
        profile = Profile.objects.create(user=user, level=Level.B1)

        assert str(profile) == "alice: B1"


class TestOneToOneConstraint:
    def test_second_profile_for_same_user_rejected(self, user):
        Profile.objects.create(user=user)

        with pytest.raises(IntegrityError):
            Profile.objects.create(user=user, level=Level.B2)

    def test_profile_reachable_from_user_via_related_name(self, user):
        Profile.objects.create(user=user, level=Level.C1)

        assert user.learning_profile.level == Level.C1

    def test_deleting_user_cascades_to_profile(self, user):
        profile = Profile.objects.create(user=user)

        user.delete()

        assert not Profile.objects.filter(pk=profile.pk).exists()

    def test_profiles_for_distinct_users_are_independent(self, user):
        other = get_user_model().objects.create_user(
            username="bob", email="bob@example.com", password="pw-123456"
        )
        mine = Profile.objects.create(user=user, level=Level.A1)
        theirs = Profile.objects.create(user=other, level=Level.C2)

        assert Profile.objects.count() == 2
        assert {mine.user_id, theirs.user_id} == {user.pk, other.pk}


class TestValidation:
    def test_invalid_level_fails_full_clean(self, user):
        profile = Profile(user=user, level="Z9")

        with pytest.raises(ValidationError) as excinfo:
            profile.full_clean()

        assert "level" in excinfo.value.error_dict

    def test_blank_level_fails_full_clean(self, user):
        profile = Profile(user=user, level="")

        with pytest.raises(ValidationError) as excinfo:
            profile.full_clean()

        assert "level" in excinfo.value.error_dict

    def test_missing_user_fails_full_clean(self, db):
        profile = Profile(level=Level.B1)

        with pytest.raises(ValidationError) as excinfo:
            profile.full_clean()

        assert "user" in excinfo.value.error_dict

    def test_level_choices_cover_exactly_the_specified_values(self):
        expected = {"A1", "A2", "B1", "B2", "C1", "C2", "AUTO"}

        assert set(Level.values) == expected

    def test_level_is_database_backed_char_field_with_choices(self):
        field = Profile._meta.get_field("level")

        assert isinstance(field, models.CharField)
        assert field.max_length >= len(Level.AUTO)
        assert field.choices is not None
