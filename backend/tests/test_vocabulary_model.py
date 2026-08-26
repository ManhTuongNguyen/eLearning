"""Tests for the vocabulary item model (TASK-065)."""

import pytest
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import models

from conversations.models import Message, Session
from vocabulary.models import VocabularyItem

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


@pytest.fixture
def session(user):
    return Session.objects.create(user=user, title="Trips", topic="Traveling")


@pytest.fixture
def message(session):
    return Message.append(session, role=Message.Role.USER, content="I want to travel")


def make_item(user, **overrides):
    defaults = {
        "user": user,
        "expression": "set off",
        "normalized_expression": "set off",
        "source_session": None,
        "source_message": None,
    }
    defaults.update(overrides)
    return VocabularyItem.objects.create(**defaults)


class TestCreation:
    def test_defaults_start_pending_with_empty_enrichment(self, user):
        item = make_item(user)

        assert item.pk is not None
        assert item.status == VocabularyItem.Status.PENDING
        assert item.definition == ""
        assert item.translation == ""
        assert item.pronunciation == ""
        assert item.part_of_speech == ""
        assert item.example == ""
        assert item.source_message is None
        assert item.source_session is None

    def test_expression_stores_single_word_verbatim(self, user):
        item = make_item(user, expression="Serendipity", normalized_expression="serendipity")

        item.refresh_from_db()
        assert item.expression == "Serendipity"
        assert item.normalized_expression == "serendipity"

    def test_expression_stores_multi_word_phrase_verbatim(self, user):
        phrase = "To bite the bullet!"
        item = make_item(user, expression=phrase, normalized_expression="to bite the bullet")

        item.refresh_from_db()
        assert item.expression == phrase
        assert item.normalized_expression == "to bite the bullet"

    def test_enrichment_fields_persist_round_trip(self, user):
        item = make_item(user)
        item.definition = "to start a journey"
        item.translation = "ponerse en camino"
        item.pronunciation = "/set ɒf/"
        item.part_of_speech = "phrasal verb"
        item.example = "We set off at dawn."
        item.status = VocabularyItem.Status.COMPLETE
        item.save()

        item.refresh_from_db()
        assert item.definition == "to start a journey"
        assert item.translation == "ponerse en camino"
        assert item.pronunciation == "/set ɒf/"
        assert item.part_of_speech == "phrasal verb"
        assert item.example == "We set off at dawn."
        assert item.status == VocabularyItem.Status.COMPLETE

    @pytest.mark.parametrize(
        ("status", "expected_pending", "expected_enriched"),
        [
            (VocabularyItem.Status.PENDING, True, False),
            (VocabularyItem.Status.COMPLETE, False, True),
            (VocabularyItem.Status.FAILED, False, False),
        ],
    )
    def test_enrichment_status_flags_matrix(
        self, user, status, expected_pending, expected_enriched
    ):
        item = make_item(user, status=status)

        assert item.is_pending is expected_pending
        assert item.is_enriched is expected_enriched

    def test_str_shows_username_and_expression(self, user):
        item = make_item(user, expression="gobsmacked")

        assert str(item) == "alice: gobsmacked"

    def test_created_at_and_updated_at_are_set(self, user):
        item = make_item(user)

        assert item.created_at is not None
        assert item.updated_at is not None
        assert item.created_at <= item.updated_at

    def test_updated_at_changes_on_save(self, user):
        item = make_item(user)
        original_updated = item.updated_at

        item.definition = "updated"
        item.save()

        item.refresh_from_db()
        assert item.updated_at > original_updated


class TestOwnership:
    def test_item_belongs_to_user(self, user):
        item = make_item(user)

        assert item.user == user
        assert item.user_id == user.pk

    def test_user_can_access_items_via_related_name(self, user):
        make_item(user, expression="one", normalized_expression="one")
        make_item(user, expression="two", normalized_expression="two")

        assert user.vocabulary_items.count() == 2

    def test_deleting_user_cascades_to_items(self, user):
        item = make_item(user)

        user.delete()

        assert not VocabularyItem.objects.filter(pk=item.pk).exists()

    def test_items_for_distinct_users_are_independent(self, user, other_user):
        mine = make_item(user)
        theirs = make_item(other_user)

        assert VocabularyItem.objects.count() == 2
        assert {mine.user_id, theirs.user_id} == {user.pk, other_user.pk}


class TestSourceReferences:
    def test_source_links_point_at_the_saved_message_and_session(self, user, session, message):
        item = make_item(user, source_session=session, source_message=message)

        item.refresh_from_db()
        assert item.source_session == session
        assert item.source_message == message
        assert list(message.vocabulary_items.all()) == [item]
        assert list(session.vocabulary_items.all()) == [item]

    def test_deleting_session_keeps_vocabulary_and_nulls_source(self, user, session, message):
        item = make_item(user, source_session=session, source_message=message)

        session.delete()
        item.refresh_from_db()

        assert VocabularyItem.objects.filter(pk=item.pk).exists()
        assert item.source_session is None
        assert item.source_message is None

    def test_deleting_message_keeps_vocabulary_and_nulls_source(self, user, session, message):
        item = make_item(user, source_session=session, source_message=message)

        message.delete()
        item.refresh_from_db()

        assert VocabularyItem.objects.filter(pk=item.pk).exists()
        assert item.source_message is None


class TestOrdering:
    def test_default_ordering_is_newest_first(self, user):
        first = make_item(user, expression="alpha", normalized_expression="alpha")
        second = make_item(user, expression="beta", normalized_expression="beta")
        third = make_item(user, expression="gamma", normalized_expression="gamma")

        items = list(VocabularyItem.objects.all())

        assert items == [third, second, first]

    def test_composite_index_exists_for_user_and_normalized_expression(self):
        index_names = {index.name for index in VocabularyItem._meta.indexes}

        assert "vocabulary_user_normalized_idx" in index_names


class TestValidation:
    def test_blank_expression_fails_full_clean(self, user):
        item = VocabularyItem(user=user, expression="", normalized_expression="word")

        with pytest.raises(ValidationError) as excinfo:
            item.full_clean()

        assert "expression" in excinfo.value.error_dict

    def test_blank_normalized_expression_fails_full_clean(self, user):
        item = VocabularyItem(user=user, expression="word", normalized_expression="")

        with pytest.raises(ValidationError) as excinfo:
            item.full_clean()

        assert "normalized_expression" in excinfo.value.error_dict

    def test_missing_user_fails_full_clean(self, db):
        item = VocabularyItem(expression="word", normalized_expression="word")

        with pytest.raises(ValidationError) as excinfo:
            item.full_clean()

        assert "user" in excinfo.value.error_dict

    def test_invalid_status_fails_full_clean(self, user):
        item = VocabularyItem(
            user=user, expression="word", normalized_expression="word", status="archived"
        )

        with pytest.raises(ValidationError) as excinfo:
            item.full_clean()

        assert "status" in excinfo.value.error_dict


class TestFieldShapes:
    def test_user_is_foreign_key_with_cascade_and_related_name(self):
        field = VocabularyItem._meta.get_field("user")

        assert isinstance(field, models.ForeignKey)
        assert field.remote_field.on_delete == models.CASCADE
        assert field.remote_field.related_name == "vocabulary_items"

    def test_expression_is_text_field(self):
        field = VocabularyItem._meta.get_field("expression")

        assert isinstance(field, models.TextField)
        assert field.blank is False

    def test_normalized_expression_is_text_field(self):
        field = VocabularyItem._meta.get_field("normalized_expression")

        assert isinstance(field, models.TextField)
        assert field.blank is False

    def test_enrichment_text_fields_are_blank_by_default(self):
        for name in ("definition", "translation", "example"):
            field = VocabularyItem._meta.get_field(name)

            assert isinstance(field, models.TextField), name
            assert field.blank is True, name
            assert field.default == "", name

    def test_pronunciation_is_char_field_with_max_length(self):
        field = VocabularyItem._meta.get_field("pronunciation")

        assert isinstance(field, models.CharField)
        assert field.max_length == 255
        assert field.blank is True
        assert field.default == ""

    def test_part_of_speech_is_char_field_with_max_length(self):
        field = VocabularyItem._meta.get_field("part_of_speech")

        assert isinstance(field, models.CharField)
        assert field.max_length == 64
        assert field.blank is True
        assert field.default == ""

    def test_source_references_are_set_null_and_optional(self):
        for name in ("source_message", "source_session"):
            field = VocabularyItem._meta.get_field(name)

            assert isinstance(field, models.ForeignKey), name
            assert field.remote_field.on_delete == models.SET_NULL, name
            assert field.null is True, name
            assert field.blank is True, name

    def test_status_has_choices_and_default_pending(self):
        field = VocabularyItem._meta.get_field("status")
        allowed = {choice for choice, _ in field.choices}

        assert isinstance(field, models.CharField)
        assert field.default == VocabularyItem.Status.PENDING
        assert allowed == {"pending", "complete", "failed"}

    def test_created_at_is_auto_now_add(self):
        field = VocabularyItem._meta.get_field("created_at")

        assert isinstance(field, models.DateTimeField)
        assert field.auto_now_add is True

    def test_updated_at_is_auto_now(self):
        field = VocabularyItem._meta.get_field("updated_at")

        assert isinstance(field, models.DateTimeField)
        assert field.auto_now is True

    def test_meta_ordering_is_created_at_descending(self):
        assert VocabularyItem._meta.ordering == ("-created_at",)
