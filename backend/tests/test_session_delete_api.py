"""Tests for the session deletion API (TASK-034).

Covers DELETE /api/v1/sessions/{id}/: authenticated-only access, per-user
ownership scoping (a foreign or missing session is an indistinguishable
404), cascade deletion of the session's messages while sibling sessions and
their messages survive, and the method contract on the detail endpoint.
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


def make_message(session, *, role=Message.Role.USER, content="hello"):
    return Message.append(session, role=role, content=content)


def detail_url(session):
    return reverse("conversations:session-detail", kwargs={"pk": session.id})


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
    def test_anonymous_delete_is_rejected(self, api, user):
        session = make_session(user)

        response = api.delete(detail_url(session))

        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert Session.objects.filter(pk=session.pk).exists()


class TestOwnerDeletion:
    def test_owner_deletes_own_session(self, authed_api, user):
        session = make_session(user, title="Doomed conversation")

        response = authed_api.delete(detail_url(session))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not response.content
        assert not Session.objects.filter(pk=session.pk).exists()

    def test_related_messages_are_deleted_with_the_session(self, authed_api, user):
        session = make_session(user)
        make_message(session, role=Message.Role.ASSISTANT, content="welcome")
        make_message(session, content="my question")

        response = authed_api.delete(detail_url(session))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Message.objects.filter(session=session).exists()
        assert Message.objects.count() == 0

    def test_sibling_sessions_and_their_messages_survive(self, authed_api, user):
        doomed = make_session(user, title="Doomed")
        make_message(doomed, content="goes away")
        survivor = make_session(user, title="Survivor")
        kept_message = make_message(survivor, content="stays here")

        response = authed_api.delete(detail_url(doomed))

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert Session.objects.filter(pk=survivor.pk).exists()
        assert list(Message.objects.values_list("pk", flat=True)) == [kept_message.pk]

    def test_deleted_session_disappears_from_the_listing(self, authed_api, user):
        doomed = make_session(user, title="Doomed")
        keep_me = make_session(user, title="Keep me")
        authed_api.delete(detail_url(doomed))

        response = authed_api.get(reverse("conversations:sessions"))

        assert response.status_code == status.HTTP_200_OK
        assert [item["id"] for item in response.data["results"]] == [keep_me.id]

    def test_detail_get_after_delete_returns_404(self, authed_api, user):
        session = make_session(user)
        authed_api.delete(detail_url(session))

        response = authed_api.get(detail_url(session))

        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestOwnership:
    def test_strangers_session_returns_404_and_is_untouched(self, authed_api, user, stranger):
        theirs = make_session(stranger, title="Not mine")
        their_message = make_message(theirs, content="secret")

        response = authed_api.delete(detail_url(theirs))

        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert Session.objects.filter(pk=theirs.pk).exists()
        assert Message.objects.filter(pk=their_message.pk).exists()

    def test_missing_pk_returns_404(self, authed_api, user):
        url = reverse("conversations:session-detail", kwargs={"pk": 999999})

        response = authed_api.delete(url)

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_non_integer_pk_does_not_match_the_route(self, authed_api):
        response = authed_api.delete("/api/v1/sessions/abc/")

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_repeated_delete_of_the_same_id_returns_404(self, authed_api, user):
        session = make_session(user)
        first = authed_api.delete(detail_url(session))
        second = authed_api.delete(detail_url(session))

        assert first.status_code == status.HTTP_204_NO_CONTENT
        assert second.status_code == status.HTTP_404_NOT_FOUND


class TestMethodContract:
    @pytest.mark.parametrize("method", ["post", "put"])
    def test_unsupported_methods_on_detail_are_rejected(self, authed_api, user, method):
        session = make_session(user)

        response = getattr(authed_api, method)(detail_url(session), {}, format="json")

        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED
        assert Session.objects.filter(pk=session.pk).exists()

    def test_get_still_works_alongside_delete(self, authed_api, user):
        session = make_session(user, title="Readable")

        response = authed_api.get(detail_url(session))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["title"] == "Readable"
