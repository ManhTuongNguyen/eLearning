"""Tests for the conversation message model (TASK-027)."""

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction

from conversations.models import Message, Session

pytestmark = pytest.mark.django_db


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(user=user, title="Test Session", topic="Traveling")


class TestMessageCreation:
    def test_append_user_message_defaults_to_complete(self, session):
        message = Message.append(session, role=Message.Role.USER, content="Hello!")

        assert message.pk is not None
        assert message.role == Message.Role.USER
        assert message.status == Message.Status.COMPLETE
        assert message.sequence == 1

    def test_append_assistant_message_defaults_to_pending_with_blank_content(self, session):
        message = Message.append(session, role=Message.Role.ASSISTANT)

        assert message.role == Message.Role.ASSISTANT
        assert message.status == Message.Status.PENDING
        assert message.content == ""
        assert message.sequence == 1

    def test_all_statuses_persist_round_trip(self, session):
        for status in Message.Status:
            message = Message.append(
                session,
                role=Message.Role.ASSISTANT,
                content=f"content-{status.value}",
                status=status,
            )

            message.refresh_from_db()
            assert message.status == status

    def test_str_includes_session_sequence_and_role(self, session):
        message = Message.append(session, role=Message.Role.USER, content="Hi")

        assert str(message) == f"session={session.pk} #1 {Message.Role.USER}"

    def test_created_at_is_set(self, session):
        message = Message.append(session, role=Message.Role.USER, content="Hi")

        assert message.created_at is not None


class TestSessionRelationship:
    def test_message_belongs_to_session(self, session):
        message = Message.append(session, role=Message.Role.USER, content="Hi")

        assert message.session == session
        assert list(session.messages.all()) == [message]

    def test_deleting_session_cascades_to_messages(self, session):
        Message.append(session, role=Message.Role.USER, content="Hi")
        Message.append(session, role=Message.Role.ASSISTANT, content="Hello")

        session.delete()

        assert Message.objects.count() == 0

    def test_deleting_user_cascades_through_session(self, session, user):
        Message.append(session, role=Message.Role.USER, content="Hi")

        user.delete()

        assert Message.objects.count() == 0

    def test_same_sequence_allowed_across_distinct_sessions(self, session, user):
        other_session = Session.objects.create(user=user, title="Other", topic="Topic")
        first = Message.append(session, role=Message.Role.USER, content="Hi")
        second = Message.append(other_session, role=Message.Role.USER, content="Hey")

        assert first.sequence == second.sequence == 1


class TestDeterministicOrdering:
    def test_meta_ordering_is_by_sequence(self, session):
        third = Message.objects.create(
            session=session,
            role=Message.Role.ASSISTANT,
            content="third",
            sequence=3,
            status=Message.Status.COMPLETE,
        )
        first = Message.objects.create(
            session=session,
            role=Message.Role.USER,
            content="first",
            sequence=1,
            status=Message.Status.COMPLETE,
        )
        second = Message.objects.create(
            session=session,
            role=Message.Role.ASSISTANT,
            content="second",
            sequence=2,
            status=Message.Status.COMPLETE,
        )

        assert list(session.messages.all()) == [first, second, third]

    def test_append_allocates_monotonic_sequences(self, session):
        m1 = Message.append(session, role=Message.Role.USER, content="1")
        m2 = Message.append(session, role=Message.Role.ASSISTANT, content="2")
        m3 = Message.append(session, role=Message.Role.USER, content="3")

        assert [m1.sequence, m2.sequence, m3.sequence] == [1, 2, 3]


class TestSequenceUniqueness:
    def test_duplicate_sequence_within_session_rejected(self, session):
        Message.append(session, role=Message.Role.USER, content="Hi")

        with pytest.raises(IntegrityError):
            with transaction.atomic():
                Message.objects.create(
                    session=session,
                    role=Message.Role.ASSISTANT,
                    content="clash",
                    sequence=1,
                    status=Message.Status.COMPLETE,
                )


class TestRetrySemantics:
    @pytest.mark.parametrize(
        ("role", "status", "expected"),
        [
            (Message.Role.ASSISTANT, Message.Status.FAILED, True),
            (Message.Role.ASSISTANT, Message.Status.PENDING, False),
            (Message.Role.ASSISTANT, Message.Status.COMPLETE, False),
            (Message.Role.USER, Message.Status.COMPLETE, False),
            (Message.Role.USER, Message.Status.FAILED, False),
            (Message.Role.USER, Message.Status.PENDING, False),
        ],
    )
    def test_is_retryable_matrix(self, role, status, expected):
        message = Message(role=role, status=status)

        assert message.is_retryable is expected

    def test_failed_assistant_message_can_be_reset_and_completed(self, session):
        message = Message.append(session, role=Message.Role.ASSISTANT)
        message.status = Message.Status.FAILED
        message.save()

        message.refresh_from_db()
        assert message.is_retryable

        message.status = Message.Status.PENDING
        message.save()
        message.refresh_from_db()
        assert not message.is_retryable

        message.content = "Recovered answer"
        message.status = Message.Status.COMPLETE
        message.save()
        message.refresh_from_db()

        assert not message.is_retryable
        assert message.content == "Recovered answer"

    def test_user_message_cannot_be_created_incomplete_via_orm(self, session):
        with pytest.raises(IntegrityError):
            with transaction.atomic():
                Message.objects.create(
                    session=session,
                    role=Message.Role.USER,
                    content="Hi",
                    status=Message.Status.PENDING,
                )

    def test_user_message_non_complete_status_fails_full_clean(self, session):
        message = Message(
            session=session,
            role=Message.Role.USER,
            content="Hi",
            status=Message.Status.FAILED,
            sequence=1,
        )

        with pytest.raises(ValidationError) as excinfo:
            message.full_clean()

        assert "status" in excinfo.value.error_dict


class TestValidation:
    def test_invalid_role_fails_full_clean(self, session):
        message = Message(session=session, role="system", content="Hi", sequence=1)

        with pytest.raises(ValidationError) as excinfo:
            message.full_clean()

        assert "role" in excinfo.value.error_dict

    def test_invalid_status_fails_full_clean(self, session):
        message = Message(
            session=session,
            role=Message.Role.ASSISTANT,
            content="Hi",
            status="streaming",
            sequence=1,
        )

        with pytest.raises(ValidationError) as excinfo:
            message.full_clean()

        assert "status" in excinfo.value.error_dict

    def test_missing_session_fails_full_clean(self, db):
        message = Message(role=Message.Role.USER, content="Hi", sequence=1)

        with pytest.raises(ValidationError) as excinfo:
            message.full_clean()

        assert "session" in excinfo.value.error_dict

    def test_blank_content_valid_for_pending_assistant(self, session):
        message = Message(
            session=session,
            role=Message.Role.ASSISTANT,
            content="",
            status=Message.Status.PENDING,
            sequence=1,
        )

        message.full_clean()

        assert message.pk is None


class TestFieldShapes:
    def test_session_is_foreign_key_with_cascade_and_related_name(self):
        field = Message._meta.get_field("session")

        assert isinstance(field, models.ForeignKey)
        assert field.remote_field.on_delete == models.CASCADE
        assert field.remote_field.related_name == "messages"

    def test_role_is_char_field_with_choices(self):
        field = Message._meta.get_field("role")

        assert isinstance(field, models.CharField)
        assert set(field.choices) == set(Message.Role.choices)

    def test_status_has_default_pending(self):
        field = Message._meta.get_field("status")

        assert isinstance(field, models.CharField)
        assert set(field.choices) == set(Message.Status.choices)
        assert field.default == Message.Status.PENDING

    def test_content_is_blank_text_field(self):
        field = Message._meta.get_field("content")

        assert isinstance(field, models.TextField)
        assert field.blank is True

    def test_sequence_is_positive_integer(self):
        field = Message._meta.get_field("sequence")

        assert isinstance(field, models.PositiveIntegerField)

    def test_created_at_is_auto_now_add(self):
        field = Message._meta.get_field("created_at")

        assert isinstance(field, models.DateTimeField)
        assert field.auto_now_add is True

    def test_ordering_is_deterministic_by_sequence(self):
        assert Message._meta.ordering == ("sequence",)
