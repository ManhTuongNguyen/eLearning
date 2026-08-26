"""Tests for the suggested-replies endpoint (conversations.MessageSuggestionsView, TASK-059).

Covers authenticated-only access, ownership 404s without existence leaks,
invalid message/session combinations (pending, failed and blank targets are
409 conflicts with zero provider calls), the successful JSON contract of
exactly three replies, prompt composition from persisted state only (level
echo, topic fields, prior-complete transcript through the recent-message
window), provider-failure mapping (503 retryable / 502 permanent), purity
(nothing persisted, nothing scheduled) and log hygiene.
"""

import json
import logging

import pytest
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APIClient

import conversations.views as views_module
from conversations.models import Message, Session
from conversations.suggestions import SuggestionService
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError, LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

pytestmark = pytest.mark.django_db

SECRET_TEXT = "SECRET-SELECTED-USER-MARKER"
LATER_TEXT = "LATER-TURN-MARKER"
EARLIER_QUESTION = "EARLIER-QUESTION-MARKER"
EARLIER_ANSWER = "EARLIER-ANSWER-MARKER"
REPLIES = ["Maybe next weekend?", "I have already booked a hotel.", "What should I pack?"]
SERVED_MODEL = "served/chat"

CONFLICT_DETAIL = "Suggestions require a completed, non-empty message."


def replies_payload(*replies: str) -> str:
    return json.dumps({"replies": list(replies)})


class ScriptedProvider(LLMProvider):
    """Fake provider returning one scripted completion and recording requests."""

    def __init__(self, *, text: str = "", error: Exception | None = None) -> None:
        self.text = text or replies_payload(*REPLIES)
        self.error = error
        self.complete_requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.complete_requests.append(request)
        if self.error is not None:
            raise self.error
        return CompletionResponse(text=self.text, model=SERVED_MODEL)

    def stream(self, request: CompletionRequest):
        raise AssertionError("Suggestion tests never call stream()")


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="bob", email="bob@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(
        user=user, title="Traveling", topic="Planning a trip to Lisbon", learning_level="B2"
    )


@pytest.fixture
def stranger_session(stranger):
    return Session.objects.create(
        user=stranger, title="Secret", topic="Stranger topic", learning_level="A1"
    )


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def chat_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def install_service(monkeypatch):
    """Patch the suggestion-service seam; hand back the scripted provider."""

    def install(**provider_kwargs) -> ScriptedProvider:
        provider = ScriptedProvider(**provider_kwargs)
        monkeypatch.setattr(
            views_module,
            "get_suggestion_service",
            lambda: SuggestionService(provider=provider),
        )
        return provider

    return install


def suggestions_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-suggestions",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


def append_completed_turn(session, *, question, answer):
    question_row = Message.append(session, role=Message.Role.USER, content=question)
    answer_row = Message.append(
        session,
        role=Message.Role.ASSISTANT,
        content=answer,
        status=Message.Status.COMPLETE,
    )
    return question_row, answer_row


def snapshot(session) -> list[tuple[int, str, str, str]]:
    rows = Message.objects.filter(session=session).order_by("sequence")
    return [(row.pk, row.role, row.status, row.content) for row in rows]


# ---------------------------------------------------------------------------
# Authentication and methods.
# ---------------------------------------------------------------------------


class TestAuthenticationAndMethods:
    def test_anonymous_post_is_rejected_without_a_provider_call(
        self, api, install_service, session
    ):
        _user_row, assistant_row = append_completed_turn(session, question="Hi", answer="Hello!")
        provider = install_service()

        response = api.post(suggestions_url(session.pk, assistant_row.pk))

        assert response.status_code == 401
        assert provider.complete_requests == []

    @pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
    def test_other_methods_are_not_allowed(self, chat_api, session, method):
        _user_row, assistant_row = append_completed_turn(session, question="Hi", answer="Hello!")

        response = getattr(chat_api, method)(suggestions_url(session.pk, assistant_row.pk))

        assert response.status_code == 405


# ---------------------------------------------------------------------------
# Ownership and routing (no existence leak, no provider call).
# ---------------------------------------------------------------------------


class TestOwnershipAndRouting:
    def test_strangers_session_is_an_indistinguishable_404(
        self, chat_api, install_service, stranger_session
    ):
        provider = install_service()
        _user_row, stranger_row = append_completed_turn(stranger_session, question="q", answer="a")

        response = chat_api.post(suggestions_url(stranger_session.pk, stranger_row.pk))

        assert response.status_code == 404
        assert "detail" in response.data
        assert provider.complete_requests == []

    def test_missing_session_is_404(self, chat_api, install_service, session):
        provider = install_service()
        _user_row, assistant_row = append_completed_turn(session, question="Hi", answer="Hello!")

        response = chat_api.post(suggestions_url(99999, assistant_row.pk))

        assert response.status_code == 404
        assert provider.complete_requests == []

    def test_foreign_message_inside_own_session_is_an_indistinguishable_404(
        self, chat_api, install_service, session, stranger_session
    ):
        provider = install_service()
        _user_row, my_row = append_completed_turn(session, question="q", answer="a")
        _foreign_user, foreign_row = append_completed_turn(
            stranger_session, question="fq", answer="fa"
        )

        response = chat_api.post(suggestions_url(session.pk, foreign_row.pk))

        assert response.status_code == 404
        assert provider.complete_requests == []
        assert len(snapshot(session)) == 2

    def test_missing_message_is_404(self, chat_api, install_service, session):
        provider = install_service()

        response = chat_api.post(suggestions_url(session.pk, 99999))

        assert response.status_code == 404
        assert provider.complete_requests == []

    def test_non_int_session_pk_never_matches_the_route(self, chat_api, session):
        _user_row, assistant_row = append_completed_turn(session, question="Hi", answer="Hello!")

        url = f"/api/v1/sessions/not-an-int/messages/{assistant_row.pk}/suggestions/"
        response = chat_api.post(url)

        assert response.status_code == 404

    def test_non_int_message_pk_never_matches_the_route(self, chat_api, session):
        url = f"/api/v1/sessions/{session.pk}/messages/not-an-int/suggestions/"
        response = chat_api.post(url)

        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Invalid message/session combinations (409 conflicts, zero provider calls).
# ---------------------------------------------------------------------------


class TestInvalidCombinations:
    def test_pending_assistant_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        user_row = Message.append(session, role=Message.Role.USER, content="Hi")
        pending_row = Message.append(session, role=Message.Role.ASSISTANT)

        response = chat_api.post(suggestions_url(session.pk, pending_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []
        pending_row.refresh_from_db()
        assert pending_row.status == Message.Status.PENDING
        user_row.refresh_from_db()
        assert user_row.content == "Hi"

    def test_failed_assistant_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        Message.append(session, role=Message.Role.USER, content="Hi")
        failed_row = Message.append(
            session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED
        )

        response = chat_api.post(suggestions_url(session.pk, failed_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []
        failed_row.refresh_from_db()
        assert failed_row.is_retryable

    def test_blank_complete_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        blank_row = Message.append(
            session, role=Message.Role.ASSISTANT, status=Message.Status.COMPLETE
        )

        response = chat_api.post(suggestions_url(session.pk, blank_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []


# ---------------------------------------------------------------------------
# Successful suggestions (JSON contract + composition from persisted state).
# ---------------------------------------------------------------------------


class TestSuccessfulSuggestions:
    def test_returns_exactly_the_three_provider_replies(self, chat_api, install_service, session):
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        padded = replies_payload("  Padded one.  ", "Padded two.", "Padded three.")
        provider = install_service(text=padded)

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 200
        assert response.headers["Content-Type"] == "application/json"
        assert response.data == {
            "replies": ["Padded one.", "Padded two.", "Padded three."],
        }
        (request,) = provider.complete_requests
        assert [message.role for message in request.messages] == ["system", "user"]

    def test_prompt_is_composed_from_persisted_state_only(self, chat_api, install_service, session):
        append_completed_turn(session, question=EARLIER_QUESTION, answer=EARLIER_ANSWER)
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        _later_question, later_answer = append_completed_turn(
            session, question=LATER_TEXT, answer=LATER_TEXT + "-answer"
        )
        provider = install_service()

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 200
        (request,) = provider.complete_requests
        system_prompt = request.messages[0].content
        user_prompt = request.messages[-1].content
        assert "JSON" in system_prompt
        assert "The learner's English level is B2" in user_prompt
        assert 'Topic title: "Traveling"' in user_prompt
        assert "Planning a trip to Lisbon" in user_prompt
        assert f"Learner: {EARLIER_QUESTION}" in user_prompt
        assert f"Tutor: {EARLIER_ANSWER}" in user_prompt
        # The selection is marked as long-pressed, never transcribed as a
        # turn; later messages never reach the prompt.
        assert 'long-pressed this message: "Nice! When do you travel?"' in user_prompt
        assert LATER_TEXT not in user_prompt
        assert later_answer.content not in user_prompt

    def test_first_message_gets_an_empty_transcript(self, chat_api, install_service, session):
        opening_row = Message.append(session, role=Message.Role.USER, content=SECRET_TEXT)
        provider = install_service()

        response = chat_api.post(suggestions_url(session.pk, opening_row.pk))

        assert response.status_code == 200
        (request,) = provider.complete_requests
        user_prompt = request.messages[-1].content
        assert "no earlier messages" in user_prompt
        assert f'long-pressed this message: "{SECRET_TEXT}"' in user_prompt

    def test_history_window_bounds_the_transcript(self, chat_api, install_service, session):
        for index in range(3):
            append_completed_turn(session, question=f"old q {index}", answer=f"old a {index}")
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Latest tutor line."
        )
        provider = install_service()

        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=2):
            response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 200
        (request,) = provider.complete_requests
        user_prompt = request.messages[-1].content
        # Prior context = six old messages plus the learner's own turn before
        # the selection; window=2 keeps only its tail.
        assert f"Learner: {SECRET_TEXT}" in user_prompt
        assert "Tutor: old a 2" in user_prompt
        assert "old q 2" not in user_prompt
        assert "old a 1" not in user_prompt
        assert "old q 1" not in user_prompt
        assert "old a 0" not in user_prompt
        assert "old q 0" not in user_prompt

    def test_repeated_calls_are_independent(self, chat_api, install_service, session):
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        provider = install_service()

        first = chat_api.post(suggestions_url(session.pk, selected_row.pk))
        second = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert first.data == {"replies": REPLIES}
        assert second.data == {"replies": REPLIES}
        assert len(provider.complete_requests) == 2


# ---------------------------------------------------------------------------
# Provider failures map to normalized API errors without touching data.
# ---------------------------------------------------------------------------


class TestProviderFailures:
    def test_retryable_availability_error_maps_to_503(self, chat_api, install_service, session):
        error = LLMAvailabilityError("upstream collapsed")
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        install_service(error=error)

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 503
        assert response.data["detail"] == str(error)

    def test_permanent_authentication_error_maps_to_502(self, chat_api, install_service, session):
        error = LLMAuthenticationError("bad key")
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        install_service(error=error)

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 502
        assert response.data["detail"] == str(error)

    def test_malformed_completion_maps_to_502(self, chat_api, install_service, session):
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        error = LLMResponseError("Suggestions must be meaningfully different.")
        install_service(error=error)

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 502
        assert response.data["detail"] == str(error)


# ---------------------------------------------------------------------------
# Purity: suggestions are display data — nothing is written anywhere.
# ---------------------------------------------------------------------------


class TestPurity:
    def test_no_rows_change_and_no_background_work_is_scheduled(
        self, chat_api, install_service, session
    ):
        append_completed_turn(session, question=EARLIER_QUESTION, answer=EARLIER_ANSWER)
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        install_service()
        before = snapshot(session)
        callbacks_before = list(connection.run_on_commit)

        response = chat_api.post(suggestions_url(session.pk, selected_row.pk))

        assert response.status_code == 200
        assert snapshot(session) == before
        assert list(connection.run_on_commit) == callbacks_before


# ---------------------------------------------------------------------------
# Wiring and log hygiene.
# ---------------------------------------------------------------------------


class TestWiring:
    def test_suggestion_service_seam_is_cached(self):
        from conversations.views import get_suggestion_service

        with override_settings(OPENROUTER_API_KEY="test-key"):
            service = get_suggestion_service()
            assert isinstance(service, SuggestionService)
            assert get_suggestion_service() is service


class TestLogHygiene:
    def test_no_payload_text_is_logged_on_success_or_failure(
        self, chat_api, install_service, session, caplog
    ):
        _user_row, selected_row = append_completed_turn(
            session, question=SECRET_TEXT, answer="Nice! When do you travel?"
        )
        with caplog.at_level(logging.DEBUG):
            install_service()
            success = chat_api.post(suggestions_url(session.pk, selected_row.pk))
            assert success.status_code == 200

            install_service(error=LLMAvailabilityError("upstream collapsed"))
            failure = chat_api.post(suggestions_url(session.pk, selected_row.pk))
            assert failure.status_code == 503

        for reply in REPLIES:
            assert reply not in caplog.text
        assert SECRET_TEXT not in caplog.text
