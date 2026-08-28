"""Focused regression suite for the confirmed audit bugs (TASK-AUDIT-018).

One module that pins every confirmed audit bug at its system boundary so a
future change cannot silently resurrect any of them:

- TASK-AUDIT-001 — ``Accept: text/event-stream`` streams instead of 406 on
  every SSE endpoint.
- TASK-AUDIT-002 — ``Accept: text/csv`` exports instead of 406.
- TASK-AUDIT-004 — provider model discovery is decoupled from token
  validation: an invalid/expired key does not prevent discovery, and the
  operation never touches user authentication (it runs without any database
  or JWT involvement).
- TASK-AUDIT-005 — access-token refresh works, a refresh token stops working
  once its session is logged out, and every refresh failure answers 401 —
  the client contract that clears credentials and returns to login.
- ownership — cross-user access stays an indistinguishable 404 on every
  object-scoped endpoint, and listings/exports never leak other users' rows.

External APIs are fully mocked (provider HTTP via ``httpx.MockTransport``);
no test uses real OpenRouter credentials. Tests are deterministic: no sleep,
no network, no clock dependence beyond JWT issuance.
"""

from datetime import timedelta

import httpx
import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

import llm.views
from conversations.models import Message, Session
from llm.openrouter import OpenRouterProvider
from llm.provider import LLMProvider
from llm.sse import CONTENT_TYPE
from llm.streaming import StreamingCompletionService
from llm.types import StreamDelta, StreamStart
from vocabulary.models import VocabularyItem

SSE_ACCEPT = "text/event-stream"
CSV_ACCEPT = "text/csv"
SERVED_MODEL = "served/regression"
USER_TEXT = "REGRESSION-USER-TEXT"

LOGIN_URL = reverse("accounts:login")
LOGOUT_URL = reverse("accounts:logout")
REFRESH_URL = reverse("accounts:refresh")
ME_URL = reverse("accounts:me")
SESSIONS_URL = reverse("conversations:sessions")
SAVE_URL = reverse("vocabulary:vocabulary-save")
EXPORT_URL = reverse("vocabulary:vocabulary-export")


def stream_url(pk) -> str:
    return reverse("conversations:session-message-stream", kwargs={"pk": pk})


def retry_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-retry",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


def suggestions_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-suggestions",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


def improvement_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-improve",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


class ScriptedProvider(LLMProvider):
    """Fake provider yielding one scripted stream outcome."""

    def __init__(self, script: object = ()) -> None:
        self.script = script

    def complete(self, request):
        raise AssertionError("Regression tests never call complete()")

    def stream(self, request):
        if isinstance(self.script, Exception):
            raise self.script
        yield from self.script


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="regression-user", email="regression@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="regression-stranger", email="stranger@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(
        user=user, title="Regression", topic="Regression topic", learning_level="B2"
    )


@pytest.fixture
def stranger_session(stranger):
    return Session.objects.create(
        user=stranger, title="Secret", topic="Stranger topic", learning_level="A1"
    )


@pytest.fixture
def authed_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def install_provider(monkeypatch):
    """Patch the streaming-service seam with the scripted provider."""

    def install(script: object) -> ScriptedProvider:
        provider = ScriptedProvider(script=script)
        monkeypatch.setattr(
            llm.views,
            "get_streaming_service",
            lambda: StreamingCompletionService(provider=provider),
        )
        return provider

    return install


# ---------------------------------------------------------------------------
# TASK-AUDIT-001 — SSE content negotiation.
# ---------------------------------------------------------------------------


class TestSseAcceptDoesNotReturn406:
    """``Accept: text/event-stream`` must stream, never 406."""

    def test_chat_stream_with_sse_accept_streams(self, authed_api, install_provider, session):
        install_provider((StreamStart(model=SERVED_MODEL), StreamDelta(text="Hello")))

        response = authed_api.post(
            stream_url(session.pk),
            {"text": USER_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE
        events = [chunk.decode("utf-8").split("\n", 1)[0] for chunk in response.streaming_content]
        assert events[0] == "event: start"
        assert events[-1] == "event: completed"

    def test_llm_stream_with_sse_accept_streams(self, authed_api, install_provider):
        install_provider((StreamStart(model=SERVED_MODEL),))

        response = authed_api.post(
            reverse("llm:stream"),
            {"messages": [{"role": "user", "content": "Hi"}]},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 200
        assert response.headers["Content-Type"] == CONTENT_TYPE

    def test_sse_accept_anonymous_is_401_json_not_406(self, api, session):
        response = api.post(
            stream_url(session.pk),
            {"text": USER_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 401
        assert response.headers["Content-Type"].startswith("application/json")


# ---------------------------------------------------------------------------
# TASK-AUDIT-002 — CSV export content negotiation.
# ---------------------------------------------------------------------------


class TestCsvExportDoesNotReturn406:
    """``Accept: text/csv`` must export, never 406."""

    def test_csv_accept_exports_the_anki_csv(self, authed_api, user):
        VocabularyItem.objects.create(user=user, expression="latte", normalized_expression="latte")

        response = authed_api.get(EXPORT_URL, HTTP_ACCEPT=CSV_ACCEPT)

        assert response.status_code == 200
        assert response["Content-Type"] == "text/csv"
        assert response.content.decode("utf-8").splitlines()[0] == (
            "Front,Back,Example,Pronunciation"
        )

    def test_csv_accept_anonymous_is_401_json_not_406(self, api):
        response = api.get(EXPORT_URL, HTTP_ACCEPT=CSV_ACCEPT)

        assert response.status_code == 401
        assert response.headers["Content-Type"].startswith("application/json")


# ---------------------------------------------------------------------------
# TASK-AUDIT-004 — model discovery without token validation.
# ---------------------------------------------------------------------------

DISCOVERY_BASE_URL = "https://openrouter.example/api/v1"
DISCOVERY_CATALOG = {"data": [{"id": "vendor/model-a", "name": "Alpha Model"}]}


def make_discovery_provider(api_key: str, requests: list[httpx.Request]) -> OpenRouterProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=DISCOVERY_CATALOG)

    return OpenRouterProvider(
        api_key=api_key,
        base_url=DISCOVERY_BASE_URL,
        default_model="vendor/primary",
        connect_timeout=2.0,
        read_timeout=5.0,
        client=httpx.Client(base_url=DISCOVERY_BASE_URL, transport=httpx.MockTransport(handler)),
    )


class TestModelDiscoveryWithoutTokenValidation:
    """Discovery is a pure provider operation, decoupled from tokens.

    These tests run without any database fixture: if discovery ever tried to
    validate the caller's JWT or look up the requesting user, it would fail
    here. The catalog endpoint answers regardless of the presented key, so
    invalid or expired keys must never block listing models.
    """

    def test_invalid_key_does_not_prevent_discovery(self):
        requests: list[httpx.Request] = []
        provider = make_discovery_provider("invalid-or-expired-key", requests)

        models = provider.list_models()

        assert [model.id for model in models] == ["vendor/model-a"]
        (request,) = requests
        assert request.method == "GET"
        assert str(request.url).endswith("/models")

    def test_discovery_requires_no_user_token_or_database(self):
        requests: list[httpx.Request] = []
        provider = make_discovery_provider("discovery-only-placeholder", requests)

        models = provider.list_models()

        assert models[0].name == "Alpha Model"
        # The provider key travels in the Authorization header only; no user
        # JWT, session lookup, or database access was involved.
        assert requests[0].headers["Authorization"] == "Bearer discovery-only-placeholder"


# ---------------------------------------------------------------------------
# TASK-AUDIT-005 — access-token refresh contract.
# ---------------------------------------------------------------------------


def login(api: APIClient, username: str = "regression-user") -> dict:
    response = api.post(LOGIN_URL, {"username": username, "password": "pw-123456"}, format="json")
    assert response.status_code == 200, response.data
    return response.data


class TestAccessTokenRefresh:
    """Refresh works, and a logged-out refresh token stops working."""

    def test_valid_refresh_returns_a_fresh_working_access_token(self, api, user):
        tokens = login(api)

        response = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 200
        fresh_access = response.data["access"]
        assert fresh_access
        me_response = api.get(ME_URL, HTTP_AUTHORIZATION=f"Bearer {fresh_access}")
        assert me_response.status_code == 200
        assert me_response.data["username"] == user.get_username()

    def test_refresh_token_stops_working_after_logout(self, api, user):
        tokens = login(api)
        assert (
            api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json").status_code == 200
        )
        # Logging out blacklists the refresh token: exactly once, no more.
        api.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        logout = api.post(LOGOUT_URL, {"refresh": tokens["refresh"]}, format="json")
        assert logout.status_code == 200
        api.credentials()

        response = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 401

    def test_access_token_cannot_be_used_as_a_refresh_token(self, api, user):
        tokens = login(api)

        response = api.post(REFRESH_URL, {"refresh": tokens["access"]}, format="json")

        assert response.status_code == 401


class TestRefreshFailureSignalsLogout:
    """Every refresh failure answers 401 — the client's logout signal."""

    def test_garbage_refresh_token_is_unauthorized(self, api):
        response = api.post(REFRESH_URL, {"refresh": "garbage-token"}, format="json")

        assert response.status_code == 401

    def test_blacklisted_refresh_token_is_unauthorized(self, api, user):
        tokens = login(api)
        api.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        api.post(LOGOUT_URL, {"refresh": tokens["refresh"]}, format="json")
        api.credentials()

        response = api.post(REFRESH_URL, {"refresh": tokens["refresh"]}, format="json")

        assert response.status_code == 401

    def test_expired_refresh_token_is_unauthorized(self, api, user):
        token = RefreshToken.for_user(user)
        token.set_exp(
            from_time=timezone.now() - timedelta(days=14),
            lifetime=timedelta(days=7),
        )

        response = api.post(REFRESH_URL, {"refresh": str(token)}, format="json")

        assert response.status_code == 401


# ---------------------------------------------------------------------------
# Ownership — cross-user access stays an indistinguishable 404.
# ---------------------------------------------------------------------------


class TestUserOwnershipRemainsEnforced:
    """Other users' objects are 404s, never 200s or 403 leaks."""

    def test_foreign_session_detail_is_404(self, authed_api, stranger_session):
        response = authed_api.get(
            reverse("conversations:session-detail", kwargs={"pk": stranger_session.pk})
        )

        assert response.status_code == 404

    def test_foreign_messages_are_404(self, authed_api, stranger_session):
        response = authed_api.get(
            reverse("conversations:session-messages", kwargs={"pk": stranger_session.pk})
        )

        assert response.status_code == 404

    def test_foreign_session_stream_is_404_json(
        self, authed_api, install_provider, stranger_session
    ):
        install_provider(())

        response = authed_api.post(
            stream_url(stranger_session.pk),
            {"text": USER_TEXT},
            format="json",
            HTTP_ACCEPT=SSE_ACCEPT,
        )

        assert response.status_code == 404
        assert response.headers["Content-Type"].startswith("application/json")
        assert Message.objects.count() == 0

    def test_foreign_retry_target_is_404(self, authed_api, stranger_session):
        stranger_message = Message.append(
            stranger_session,
            role=Message.Role.ASSISTANT,
            content="stranger words",
            status=Message.Status.FAILED,
        )

        response = authed_api.post(retry_url(stranger_session.pk, stranger_message.pk))

        assert response.status_code == 404

    def test_foreign_suggestions_are_404(self, authed_api, stranger_session):
        stranger_message = Message.append(
            stranger_session,
            role=Message.Role.ASSISTANT,
            content="stranger words",
            status=Message.Status.COMPLETE,
        )

        response = authed_api.post(suggestions_url(stranger_session.pk, stranger_message.pk))

        assert response.status_code == 404

    def test_foreign_improvement_is_404(self, authed_api, stranger_session):
        stranger_message = Message.append(
            stranger_session,
            role=Message.Role.USER,
            content="stranger words",
            status=Message.Status.COMPLETE,
        )

        response = authed_api.post(improvement_url(stranger_session.pk, stranger_message.pk))

        assert response.status_code == 404

    def test_foreign_source_message_cannot_be_saved(self, authed_api, stranger_session):
        stranger_message = Message.append(
            stranger_session,
            role=Message.Role.ASSISTANT,
            content="stranger words",
            status=Message.Status.COMPLETE,
        )

        response = authed_api.post(
            SAVE_URL,
            {"expression": "set off", "source_message_id": stranger_message.pk},
            format="json",
        )

        assert response.status_code == 404
        assert VocabularyItem.objects.count() == 0

    def test_session_list_contains_only_the_caller_sessions(
        self, authed_api, session, stranger_session
    ):
        response = authed_api.get(SESSIONS_URL, format="json")

        assert response.status_code == 200
        assert [row["id"] for row in response.data["results"]] == [session.pk]

    def test_vocabulary_list_and_export_contain_only_the_caller_rows(
        self, authed_api, user, stranger
    ):
        mine = VocabularyItem.objects.create(
            user=user, expression="latte", normalized_expression="latte"
        )
        VocabularyItem.objects.create(
            user=stranger, expression="secret", normalized_expression="secret"
        )

        listed = authed_api.get(SAVE_URL, format="json")
        exported = authed_api.get(EXPORT_URL, HTTP_ACCEPT=CSV_ACCEPT)

        assert [row["id"] for row in listed.data["results"]] == [mine.pk]
        body = exported.content.decode("utf-8")
        assert "latte" in body
        assert "secret" not in body
