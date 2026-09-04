"""Tests for the session creation API (TASK-030).

Covers authenticated-only access, the create-session flow (level sourced from
the learning profile, topic then sample generated, single persisted row),
hint normalization, and failure atomicity — no session survives an LLM error.
"""

import pytest
from django.contrib.auth import get_user_model
from django.test import override_settings
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from conversations import views
from conversations.models import Message, Session
from conversations.topics import GeneratedTopic, SampleConversation, SampleTurn
from learning.models import Profile
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMError,
    LLMResponseError,
)

pytestmark = pytest.mark.django_db

SESSIONS_URL = reverse("conversations:sessions")

USERNAME = "dave"
EMAIL = "dave@example.com"
PASSWORD = "pw-123456"

TOPIC_TITLE = "Ordering coffee abroad"
TOPIC_DESCRIPTION = "Role-play buying coffee in a busy cafe. Practise polite requests."
SAMPLE_TURNS = (
    SampleTurn(role=Message.Role.ASSISTANT, content="Good morning! What can I get you?"),
    SampleTurn(role=Message.Role.USER, content="Hi! Could I have a latte, please?"),
)


class FakeTopicService:
    """Fake TopicGenerationService recording calls and raising scripted errors."""

    def __init__(self, *, topic=None, sample=None, generate_error=None, sample_error=None):
        self.topic = topic or GeneratedTopic(title=TOPIC_TITLE, description=TOPIC_DESCRIPTION)
        self.sample = sample or SampleConversation(turns=SAMPLE_TURNS)
        self.generate_error = generate_error
        self.sample_error = sample_error
        self.generate_calls = []
        self.sample_calls = []

    def generate(self, *, level, hint=""):
        self.generate_calls.append({"level": level, "hint": hint})
        if self.generate_error is not None:
            raise self.generate_error
        return self.topic

    def generate_sample(self, *, topic, level):
        self.sample_calls.append({"topic": topic, "level": level})
        if self.sample_error is not None:
            raise self.sample_error
        return self.sample


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
def service(monkeypatch):
    fake = FakeTopicService()
    monkeypatch.setattr(views, "get_topic_service", lambda: fake)
    return fake


class TestAuthentication:
    def test_anonymous_post_is_rejected(self, api):
        response = api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert Session.objects.count() == 0


class TestCreateSession:
    def test_happy_path_creates_session_with_generated_topic(self, authed_api, user, service):
        response = authed_api.post(SESSIONS_URL, {"topic_hint": "travel"}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        session = Session.objects.get()
        assert session.user == user
        assert session.title == TOPIC_TITLE
        assert session.topic == TOPIC_DESCRIPTION
        assert session.topic_hint == "travel"
        data = response.data
        assert data["id"] == session.id
        assert data["title"] == TOPIC_TITLE
        assert data["topic"] == TOPIC_DESCRIPTION
        assert data["topic_hint"] == "travel"
        assert data["created_at"] is not None
        assert list(data["sample_conversation"]["turns"]) == [
            {"role": turn.role, "content": turn.content} for turn in SAMPLE_TURNS
        ]

    def test_topic_and_sample_are_generated_from_profile_level_and_hint(
        self, authed_api, user, service
    ):
        authed_api.post(SESSIONS_URL, {"topic_hint": "travel"}, format="json")

        assert len(service.generate_calls) == 1
        assert len(service.sample_calls) == 1
        # Level comes from the lazily provisioned profile (default AUTO).
        assert service.generate_calls[0] == {"level": "AUTO", "hint": "travel"}
        # Sample belongs to the generated topic and mirrors its level.
        assert service.sample_calls[0]["topic"] is service.topic
        assert service.sample_calls[0]["level"] == "AUTO"

    def test_existing_profile_level_is_used(self, authed_api, user, service):
        Profile.objects.create(user=user, level="B2")

        response = authed_api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert service.generate_calls[0]["level"] == "B2"
        assert response.data["learning_level"] == "B2"
        assert Session.objects.get().learning_level == "B2"

    def test_missing_body_creates_session_with_empty_hint(self, authed_api, service):
        response = authed_api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["topic_hint"] == ""
        assert service.generate_calls[0]["hint"] == ""
        assert Session.objects.get().topic_hint == ""

    @pytest.mark.parametrize("raw", ["   ", "\t\n"])
    def test_whitespace_only_hint_is_normalized_to_empty(self, authed_api, service, raw):
        response = authed_api.post(SESSIONS_URL, {"topic_hint": raw}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["topic_hint"] == ""
        assert service.generate_calls[0]["hint"] == ""
        assert Session.objects.get().topic_hint == ""

    def test_numeric_hint_is_coerced_to_string(self, authed_api, service):
        """DRF CharField semantics: numbers arrive as their string form."""
        response = authed_api.post(SESSIONS_URL, {"topic_hint": 42}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["topic_hint"] == "42"
        assert service.generate_calls[0]["hint"] == "42"

    def test_unknown_payload_fields_are_ignored(self, authed_api, user, service):
        response = authed_api.post(
            SESSIONS_URL,
            {"title": "hijack", "user": None, "topic_hint": "food"},
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED
        session = Session.objects.get()
        assert session.title == TOPIC_TITLE
        assert session.user == user

    def test_distinct_hints_produce_distinct_generate_calls(self, authed_api, service):
        authed_api.post(SESSIONS_URL, {"topic_hint": "travel"}, format="json")
        authed_api.post(SESSIONS_URL, {"topic_hint": "cooking"}, format="json")

        assert [call["hint"] for call in service.generate_calls] == ["travel", "cooking"]
        assert Session.objects.count() == 2


class TestFailureAtomicity:
    def test_retryable_topic_failure_returns_503_and_persists_nothing(self, authed_api, service):
        service.generate_error = LLMAvailabilityError("upstream unavailable", provider="openrouter")

        response = authed_api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        assert "detail" in response.data
        assert "upstream unavailable" in response.data["detail"]
        assert Session.objects.count() == 0
        assert service.sample_calls == []

    def test_non_retryable_topic_failure_returns_502_and_persists_nothing(
        self, authed_api, service
    ):
        service.generate_error = LLMAuthenticationError("bad credentials", provider="openrouter")

        response = authed_api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_502_BAD_GATEWAY
        assert Session.objects.count() == 0

    def test_sample_transport_failure_after_successful_topic_persists_nothing(
        self, authed_api, service
    ):
        """Transport/provider failures still abort: only a malformed sample
        completion degrades to a blank example (see the degradation test
        below). An unreachable provider is not trustworthy for the session.
        """
        service.sample_error = LLMAvailabilityError("upstream unavailable", provider="topics")

        response = authed_api.post(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        assert len(service.generate_calls) == 1
        assert len(service.sample_calls) == 1
        assert Session.objects.count() == 0

    def test_malformed_sample_output_degrades_to_blank_example(
        self, authed_api, user, service, caplog
    ):
        """A malformed sample completion must not sink the session (TASK-093).

        The example is display-only, so unusable output is skipped: the
        session stands and the response carries a blank example, while
        provider/transport failures still abort the request.
        """
        service.sample_error = LLMResponseError(
            "Sample conversation response was not a JSON object.",
            provider="topics",
            retryable=False,
        )

        with caplog.at_level("WARNING", logger="conversations.views"):
            response = authed_api.post(SESSIONS_URL, {"topic_hint": "travel"}, format="json")

        assert response.status_code == status.HTTP_201_CREATED
        assert Session.objects.count() == 1
        session = Session.objects.get()
        assert session.title == TOPIC_TITLE
        assert session.topic_hint == "travel"
        assert response.data["sample_conversation"] == {"turns": []}
        # The skip is observable in the logs, without any payload content.
        assert any("sample conversation skipped" in message for message in caplog.messages)

    def test_base_llm_error_defaults_to_502(self, authed_api, service):
        service.generate_error = LLMError("generic", provider="llm", retryable=True)

        response = authed_api.post(SESSIONS_URL, {}, format="json")

        # retryable=True wins over the exception subclass.
        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        assert Session.objects.count() == 0


class TestMethodRestrictions:
    @pytest.mark.parametrize("method", ["put", "patch", "delete"])
    def test_unsupported_methods_are_rejected(self, authed_api, method):
        response = getattr(authed_api, method)(SESSIONS_URL, {}, format="json")

        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED


class TestServiceSeam:
    def test_get_topic_service_is_cached_per_process(self):
        with override_settings(OPENROUTER_API_KEY="test-key"):
            first = views.get_topic_service()
            second = views.get_topic_service()

        assert first is second
