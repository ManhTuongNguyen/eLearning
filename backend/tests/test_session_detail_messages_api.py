"""Tests for the session detail and message listing APIs (TASK-032).

Covers authenticated-only access, per-user ownership scoping (a foreign or
missing session is indistinguishable 404), the serialized field contracts,
deterministic message ordering by sequence, and pagination driven by the
global DRF settings.
"""

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from conversations.models import Message, Session

pytestmark = pytest.mark.django_db

USERNAME = "frida"
EMAIL = "frida@example.com"
PASSWORD = "pw-123456"

SESSION_FIELDS = {"id", "title", "topic", "topic_hint", "learning_level", "created_at"}
MESSAGE_FIELDS = {"id", "role", "status", "content", "sequence", "created_at"}


def make_session(user, title="A conversation", **overrides):
    fields = {
        "user": user,
        "title": title,
        "topic": f"Topic for {title}",
        "topic_hint": "",
        "learning_level": "AUTO",
    }
    fields.update(overrides)
    return Session.objects.create(**fields)


def make_message(session, *, role=Message.Role.USER, content="hello", sequence=None):
    if sequence is None:
        return Message.append(session, role=role, content=content)
    return Message.objects.create(
        session=session,
        role=role,
        status=(Message.Status.COMPLETE if role == Message.Role.USER else Message.Status.PENDING),
        content=content,
        sequence=sequence,
    )


def detail_url(session):
    return reverse("conversations:session-detail", kwargs={"pk": session.id})


def messages_url(session):
    return reverse("conversations:session-messages", kwargs={"pk": session.id})


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


@pytest.fixture
def authed_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def stranger():
    return get_user_model().objects.create_user(
        username="stranger",
        email="stranger@example.com",
        password="pw-123456",
    )


class TestAuthentication:
    def test_anonymous_detail_is_rejected(self, api, user):
        session = make_session(user)

        response = api.get(detail_url(session))

        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_anonymous_messages_are_rejected(self, api, user):
        session = make_session(user)

        response = api.get(messages_url(session))

        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestSessionDetail:
    def test_owner_retrieves_own_session(self, authed_api, user):
        session = make_session(
            user,
            title="Airport small talk",
            topic_hint="travel",
            learning_level="B2",
            summary="internal rolling summary",
            summary_message_boundary=7,
        )

        response = authed_api.get(detail_url(session))

        assert response.status_code == status.HTTP_200_OK
        assert set(response.data.keys()) == SESSION_FIELDS
        assert response.data["id"] == session.id
        assert response.data["title"] == "Airport small talk"
        assert response.data["topic"] == "Topic for Airport small talk"
        assert response.data["topic_hint"] == "travel"
        assert response.data["learning_level"] == "B2"
        # Internal fields never leak through the detail payload.
        assert "summary" not in response.data
        assert "summary_message_boundary" not in response.data
        assert "updated_at" not in response.data

    def test_strangers_session_returns_404(self, authed_api, user, stranger):
        theirs = make_session(stranger, title="Not mine")

        response = authed_api.get(detail_url(theirs))

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert "detail" in response.data

    def test_non_integer_pk_does_not_match_the_route(self, authed_api):
        response = authed_api.get("/api/v1/sessions/abc/")

        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.parametrize("method", ["post", "put", "delete"])
    def test_unsupported_methods_on_detail_are_rejected(self, authed_api, user, method):
        session = make_session(user)

        response = getattr(authed_api, method)(detail_url(session), {}, format="json")

        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED


class TestMessageListing:
    def test_empty_session_returns_paginated_envelope(self, authed_api, user):
        session = make_session(user)

        response = authed_api.get(messages_url(session))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 0
        assert response.data["results"] == []
        assert response.data["next"] is None
        assert response.data["previous"] is None

    def test_messages_expose_serializer_fields_only(self, authed_api, user):
        session = make_session(user)
        mine = make_message(
            session,
            role=Message.Role.USER,
            content="Could I have a latte?",
            sequence=1,
        )
        reply = make_message(
            session,
            role=Message.Role.ASSISTANT,
            content="Of course!",
            sequence=2,
        )

        response = authed_api.get(messages_url(session))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 2
        first, second = response.data["results"]
        for item in (first, second):
            assert set(item.keys()) == MESSAGE_FIELDS
        assert first["id"] == mine.id
        assert first["role"] == "user"
        assert first["status"] == "complete"
        assert first["sequence"] == 1
        assert first["created_at"] is not None
        assert second["id"] == reply.id
        assert second["role"] == "assistant"
        assert second["status"] == "pending"
        assert second["sequence"] == 2

    def test_ordering_is_by_sequence_regardless_of_insertion_order(self, authed_api, user):
        session = make_session(user)
        third = make_message(session, content="third", sequence=3)
        first = make_message(session, content="first", sequence=1)
        second = make_message(session, content="second", sequence=2)

        response = authed_api.get(messages_url(session))

        items = response.data["results"]
        assert [item["sequence"] for item in items] == [1, 2, 3]
        assert [item["id"] for item in items] == [first.id, second.id, third.id]

    def test_messages_come_only_from_the_requested_session(self, authed_api, user):
        other = make_session(user, title="Other session")
        make_message(other, content="belongs elsewhere", sequence=1)
        session = make_session(user, title="This session")
        mine = make_message(session, content="belongs here", sequence=1)

        response = authed_api.get(messages_url(session))

        assert response.data["count"] == 1
        assert [item["id"] for item in response.data["results"]] == [mine.id]


class TestMessageOwnership:
    def test_strangers_session_messages_return_404(self, authed_api, user, stranger):
        theirs = make_session(stranger)
        make_message(theirs, content="secret", sequence=1)

        response = authed_api.get(messages_url(theirs))

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert Message.objects.filter(content="secret").exists()

    def test_missing_session_messages_return_404(self, authed_api, user):
        url = reverse("conversations:session-messages", kwargs={"pk": 999999})

        response = authed_api.get(url)

        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
    def test_unsupported_methods_on_messages_are_rejected(self, authed_api, user, method):
        session = make_session(user)

        response = getattr(authed_api, method)(messages_url(session), {}, format="json")

        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED


class TestMessagePagination:
    @pytest.fixture
    def session_with_twenty_five(self, user):
        session = make_session(user)
        Message.append(session, role=Message.Role.ASSISTANT, content="welcome")
        for index in range(24):
            Message.append(session, role=Message.Role.USER, content=f"message {index:02d}")
        return session

    def test_first_page_is_capped_at_page_size_with_next_link(
        self, authed_api, session_with_twenty_five
    ):
        response = authed_api.get(messages_url(session_with_twenty_five))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["count"] == 25
        assert len(response.data["results"]) == 20
        assert response.data["previous"] is None
        assert response.data["next"] is not None
        assert "page=2" in response.data["next"]

    def test_second_page_returns_remainder_with_previous_link(
        self, authed_api, session_with_twenty_five
    ):
        response = authed_api.get(messages_url(session_with_twenty_five), {"page": 2})

        assert response.status_code == status.HTTP_200_OK
        assert len(response.data["results"]) == 5
        assert response.data["next"] is None
        assert response.data["previous"] is not None

    def test_pagination_preserves_sequence_order_across_pages(
        self, authed_api, session_with_twenty_five
    ):
        first = authed_api.get(messages_url(session_with_twenty_five)).data
        second = authed_api.get(messages_url(session_with_twenty_five), {"page": 2}).data

        sequences = [item["sequence"] for item in [*first["results"], *second["results"]]]
        assert sequences == list(range(1, 26))

    @pytest.mark.parametrize("page", ["999", "abc", "0"])
    def test_invalid_page_returns_404(self, authed_api, session_with_twenty_five, page):
        response = authed_api.get(messages_url(session_with_twenty_five), {"page": page})

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_stranger_sessions_do_not_count_toward_my_pages(
        self, authed_api, user, stranger, session_with_twenty_five
    ):
        theirs = make_session(stranger)
        Message.append(theirs, role=Message.Role.USER, content="not counted")

        response = authed_api.get(messages_url(session_with_twenty_five))

        assert response.data["count"] == 25
