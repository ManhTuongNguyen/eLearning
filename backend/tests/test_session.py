"""Tests for the conversation session model (TASK-026)."""

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import models

from conversations.models import Session
from learning.models import Level

pytestmark = pytest.mark.django_db


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def other_user(db):
    return get_user_model().objects.create_user(
        username="bob", email="bob@example.com", password="pw-123456"
    )


class TestSessionCreation:
    def test_default_learning_level_is_auto(self, user):
        session = Session.objects.create(user=user, title="Test Session", topic="Traveling")

        assert session.pk is not None
        assert session.learning_level == Level.AUTO
        assert session.summary == ""
        assert session.summary_message_boundary == 0
        assert session.topic_hint == ""

    def test_all_learning_levels_persist(self, user):
        for level in Level:
            other = get_user_model().objects.create_user(
                username=f"u-{level.value.lower()}",
                email=f"{level.value.lower()}@example.com",
                password="pw-123456",
            )
            session = Session.objects.create(
                user=other, title=f"Session {level}", topic="Topic", learning_level=level
            )

            session.refresh_from_db()
            assert session.learning_level == level

    def test_str_shows_username_and_title(self, user):
        session = Session.objects.create(
            user=user, title="My Conversation", topic="Business English"
        )

        assert str(session) == "alice: My Conversation"

    def test_created_at_and_updated_at_are_set(self, user):
        session = Session.objects.create(user=user, title="Test", topic="Topic")

        assert session.created_at is not None
        assert session.updated_at is not None
        assert session.created_at <= session.updated_at

    def test_updated_at_changes_on_save(self, user):
        session = Session.objects.create(user=user, title="Test", topic="Topic")
        original_updated = session.updated_at

        session.title = "Updated Title"
        session.save()

        session.refresh_from_db()
        assert session.updated_at > original_updated


class TestUserRelationship:
    def test_session_belongs_to_user(self, user):
        session = Session.objects.create(user=user, title="Test", topic="Topic")

        assert session.user == user
        assert session.user_id == user.pk

    def test_user_can_access_sessions_via_related_name(self, user):
        Session.objects.create(user=user, title="Session 1", topic="Topic 1")
        Session.objects.create(user=user, title="Session 2", topic="Topic 2")

        assert user.conversation_sessions.count() == 2

    def test_deleting_user_cascades_to_sessions(self, user):
        session = Session.objects.create(user=user, title="Test", topic="Topic")

        user.delete()

        assert not Session.objects.filter(pk=session.pk).exists()

    def test_sessions_for_distinct_users_are_independent(self, user, other_user):
        mine = Session.objects.create(user=user, title="Mine", topic="Topic")
        theirs = Session.objects.create(user=other_user, title="Theirs", topic="Topic")

        assert Session.objects.count() == 2
        assert {mine.user_id, theirs.user_id} == {user.pk, other_user.pk}


class TestOrdering:
    def test_default_ordering_is_by_updated_at_descending(self, user):
        s1 = Session.objects.create(user=user, title="First", topic="Topic")
        s2 = Session.objects.create(user=user, title="Second", topic="Topic")
        s3 = Session.objects.create(user=user, title="Third", topic="Topic")

        sessions = list(Session.objects.all())

        assert sessions[0] == s3
        assert sessions[1] == s2
        assert sessions[2] == s1


class TestValidation:
    def test_invalid_learning_level_fails_full_clean(self, user):
        session = Session(user=user, title="Test", topic="Topic", learning_level="Z9")

        with pytest.raises(ValidationError) as excinfo:
            session.full_clean()

        assert "learning_level" in excinfo.value.error_dict

    def test_blank_learning_level_fails_full_clean(self, user):
        session = Session(user=user, title="Test", topic="Topic", learning_level="")

        with pytest.raises(ValidationError) as excinfo:
            session.full_clean()

        assert "learning_level" in excinfo.value.error_dict

    def test_missing_user_fails_full_clean(self, db):
        session = Session(title="Test", topic="Topic", learning_level=Level.B1)

        with pytest.raises(ValidationError) as excinfo:
            session.full_clean()

        assert "user" in excinfo.value.error_dict

    def test_blank_title_fails_full_clean(self, user):
        session = Session(user=user, title="", topic="Topic")

        with pytest.raises(ValidationError) as excinfo:
            session.full_clean()

        assert "title" in excinfo.value.error_dict

    def test_blank_topic_fails_full_clean(self, user):
        session = Session(user=user, title="Test", topic="")

        with pytest.raises(ValidationError) as excinfo:
            session.full_clean()

        assert "topic" in excinfo.value.error_dict


class TestFieldShapes:
    def test_user_is_foreign_key_with_cascade(self):
        field = Session._meta.get_field("user")

        assert isinstance(field, models.ForeignKey)
        assert field.remote_field.on_delete == models.CASCADE
        assert field.remote_field.related_name == "conversation_sessions"

    def test_title_is_char_field_with_max_length(self):
        field = Session._meta.get_field("title")

        assert isinstance(field, models.CharField)
        assert field.max_length == 255

    def test_topic_is_text_field(self):
        field = Session._meta.get_field("topic")

        assert isinstance(field, models.TextField)

    def test_topic_hint_is_text_field_with_blank(self):
        field = Session._meta.get_field("topic_hint")

        assert isinstance(field, models.TextField)
        assert field.blank is True
        assert field.default == ""

    def test_learning_level_is_char_field_with_level_choices(self):
        field = Session._meta.get_field("learning_level")

        assert isinstance(field, models.CharField)
        assert field.max_length >= len(Level.AUTO)
        assert field.choices is not None
        assert set(field.choices) == set(Level.choices)

    def test_summary_is_text_field_with_blank(self):
        field = Session._meta.get_field("summary")

        assert isinstance(field, models.TextField)
        assert field.blank is True
        assert field.default == ""

    def test_summary_message_boundary_is_positive_integer(self):
        field = Session._meta.get_field("summary_message_boundary")

        assert isinstance(field, models.PositiveIntegerField)
        assert field.default == 0

    def test_created_at_is_auto_now_add(self):
        field = Session._meta.get_field("created_at")

        assert isinstance(field, models.DateTimeField)
        assert field.auto_now_add is True

    def test_updated_at_is_auto_now(self):
        field = Session._meta.get_field("updated_at")

        assert isinstance(field, models.DateTimeField)
        assert field.auto_now is True
