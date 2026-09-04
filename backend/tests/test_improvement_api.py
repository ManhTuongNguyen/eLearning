"""Tests for the improvement endpoint (conversations.MessageImprovementView, TASK-063).

Covers authenticated-only access, ownership 404s without existence leaks,
the "only user messages can use this action" rule (assistant rows in every
generation state and blank rows are 409 conflicts with zero provider calls),
the successful JSON contract of {original, improved, explanation} composed
from persisted state only (level echo, verbatim stored message), provider-
failure mapping (503 retryable / 502 permanent), purity (nothing persisted,
nothing scheduled) and log hygiene.
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
from conversations.improvement import ImprovementService
from conversations.models import Message, Session
from llm.exceptions import LLMAuthenticationError, LLMAvailabilityError, LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

pytestmark = pytest.mark.django_db

SECRET_TEXT = "i has went to london last weekend"
IMPROVED_TEXT = "I went to London last weekend."
EXPLANATION = '"Went" replaces the incorrect past form "has went"; place names are capitalised.'
SEVERITY = "critical"
SERVED_MODEL = "served/chat"

CONFLICT_DETAIL = "Improvement requires a non-empty user message."


def correction_payload(
    improved: str = IMPROVED_TEXT,
    explanation: str = EXPLANATION,
    severity: str = SEVERITY,
) -> str:
    return json.dumps({"improved": improved, "explanation": explanation, "severity": severity})


class ScriptedProvider(LLMProvider):
    """Fake provider returning one scripted completion and recording requests."""

    def __init__(self, *, text: str = "", error: Exception | None = None) -> None:
        self.text = text or correction_payload()
        self.error = error
        self.complete_requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.complete_requests.append(request)
        if self.error is not None:
            raise self.error
        return CompletionResponse(text=self.text, model=SERVED_MODEL)

    def stream(self, request: CompletionRequest):
        raise AssertionError("Improvement tests never call stream()")


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
    """Patch the improvement-service seam; hand back the scripted provider."""

    def install(**provider_kwargs) -> ScriptedProvider:
        provider = ScriptedProvider(**provider_kwargs)
        monkeypatch.setattr(
            views_module,
            "get_improvement_service",
            lambda: ImprovementService(provider=provider),
        )
        return provider

    return install


def improve_url(session_pk, message_pk) -> str:
    return reverse(
        "conversations:session-message-improve",
        kwargs={"pk": session_pk, "message_pk": message_pk},
    )


def append_user_message(session, content=SECRET_TEXT) -> Message:
    return Message.append(session, role=Message.Role.USER, content=content)


def append_assistant_turn(session, answer="Nice! When do you travel?") -> tuple[Message, Message]:
    question_row = Message.append(session, role=Message.Role.USER, content=SECRET_TEXT)
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
        target_row = append_user_message(session)
        provider = install_service()

        response = api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 401
        assert provider.complete_requests == []

    @pytest.mark.parametrize("method", ["get", "put", "patch", "delete"])
    def test_other_methods_are_not_allowed(self, chat_api, session, method):
        target_row = append_user_message(session)

        response = getattr(chat_api, method)(improve_url(session.pk, target_row.pk))

        assert response.status_code == 405


# ---------------------------------------------------------------------------
# Ownership and routing (no existence leak, no provider call).
# ---------------------------------------------------------------------------


class TestOwnershipAndRouting:
    def test_strangers_session_is_an_indistinguishable_404(
        self, chat_api, install_service, stranger_session
    ):
        provider = install_service()
        stranger_row = append_user_message(stranger_session)

        response = chat_api.post(improve_url(stranger_session.pk, stranger_row.pk))

        assert response.status_code == 404
        assert "detail" in response.data
        assert provider.complete_requests == []

    def test_missing_session_is_404(self, chat_api, install_service, session):
        provider = install_service()
        target_row = append_user_message(session)

        response = chat_api.post(improve_url(99999, target_row.pk))

        assert response.status_code == 404
        assert provider.complete_requests == []

    def test_foreign_message_inside_own_session_is_an_indistinguishable_404(
        self, chat_api, install_service, session, stranger_session
    ):
        provider = install_service()
        my_row = append_user_message(session)
        foreign_row = append_user_message(stranger_session, content="stranger words")

        response = chat_api.post(improve_url(session.pk, foreign_row.pk))

        assert response.status_code == 404
        assert provider.complete_requests == []
        assert len(snapshot(session)) == 1
        assert snapshot(session)[0][0] == my_row.pk

    def test_missing_message_is_404(self, chat_api, install_service, session):
        provider = install_service()

        response = chat_api.post(improve_url(session.pk, 99999))

        assert response.status_code == 404
        assert provider.complete_requests == []

    def test_non_int_session_pk_never_matches_the_route(self, chat_api, session):
        target_row = append_user_message(session)

        url = f"/api/v1/sessions/not-an-int/messages/{target_row.pk}/improve/"
        response = chat_api.post(url)

        assert response.status_code == 404

    def test_non_int_message_pk_never_matches_the_route(self, chat_api, session):
        url = f"/api/v1/sessions/{session.pk}/messages/not-an-int/improve/"
        response = chat_api.post(url)

        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Only user messages are improvable (409 conflicts, zero provider calls).
# ---------------------------------------------------------------------------


class TestOnlyUserMessagesAreImprovable:
    def test_completed_assistant_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        _question_row, assistant_row = append_assistant_turn(session)

        response = chat_api.post(improve_url(session.pk, assistant_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []
        assistant_row.refresh_from_db()
        assert assistant_row.status == Message.Status.COMPLETE
        assert assistant_row.content == "Nice! When do you travel?"

    def test_pending_assistant_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        pending_row = Message.append(session, role=Message.Role.ASSISTANT)

        response = chat_api.post(improve_url(session.pk, pending_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []
        pending_row.refresh_from_db()
        assert pending_row.status == Message.Status.PENDING

    def test_failed_assistant_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        failed_row = Message.append(
            session, role=Message.Role.ASSISTANT, status=Message.Status.FAILED
        )

        response = chat_api.post(improve_url(session.pk, failed_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []
        failed_row.refresh_from_db()
        assert failed_row.is_retryable

    def test_blank_user_target_is_rejected(self, chat_api, install_service, session):
        provider = install_service()
        blank_row = Message.append(session, role=Message.Role.USER, content="   ")

        response = chat_api.post(improve_url(session.pk, blank_row.pk))

        assert response.status_code == 409
        assert response.data["detail"] == CONFLICT_DETAIL
        assert provider.complete_requests == []


# ---------------------------------------------------------------------------
# Successful improvement (JSON contract + composition from persisted state).
# ---------------------------------------------------------------------------


class TestSuccessfulImprovement:
    def test_returns_original_improved_explanation_and_severity(
        self, chat_api, install_service, session
    ):
        padded = correction_payload(f"  {IMPROVED_TEXT}  ", f"  {EXPLANATION}  ", f"  {SEVERITY}  ")
        target_row = append_user_message(session, content=f"  {SECRET_TEXT}  ")
        provider = install_service(text=padded)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        assert response.headers["Content-Type"] == "application/json"
        # ``original`` is the stored message trimmed — never the model echo;
        # improved/explanation/severity arrive stripped through the value object.
        assert response.data == {
            "original": SECRET_TEXT,
            "improved": IMPROVED_TEXT,
            "explanation": EXPLANATION,
            "severity": SEVERITY,
        }
        (request,) = provider.complete_requests
        assert [message.role for message in request.messages] == ["system", "user"]

    def test_severity_levels_round_trip(self, chat_api, install_service, session):
        for severity in ("none", "minor", "critical"):
            target_row = append_user_message(session)
            install_service(text=correction_payload(severity=severity))

            response = chat_api.post(improve_url(session.pk, target_row.pk))

            assert response.status_code == 200
            assert response.data["severity"] == severity

    def test_model_echo_cannot_replace_the_original(self, chat_api, install_service, session):
        # Even a misbehaving completion carrying its own "original" key must
        # not override the learner's stored words (extra keys are ignored).
        echo = json.dumps(
            {
                "original": "MODEL-PARAPHRASED-ORIGINAL",
                "improved": IMPROVED_TEXT,
                "explanation": EXPLANATION,
                "severity": SEVERITY,
            }
        )
        target_row = append_user_message(session)
        install_service(text=echo)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        assert response.data["original"] == SECRET_TEXT

    def test_prompt_is_composed_from_persisted_state_only(self, chat_api, install_service, session):
        target_row = append_user_message(session)
        provider = install_service()

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        (request,) = provider.complete_requests
        system_prompt = request.messages[0].content
        user_prompt = request.messages[-1].content
        assert "JSON" in system_prompt
        assert '"improved"' in system_prompt
        assert '"explanation"' in system_prompt
        assert '"severity"' in system_prompt
        assert "The learner's English level is B2 (CEFR)" in user_prompt
        assert f'The learner\'s message: "{SECRET_TEXT}"' in user_prompt

    def test_auto_level_uses_the_infer_level_wording(self, chat_api, install_service, session):
        Session.objects.filter(pk=session.pk).update(learning_level="AUTO")
        target_row = append_user_message(session)
        provider = install_service()

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        (request,) = provider.complete_requests
        user_prompt = request.messages[-1].content
        assert "The learner's English level is unknown" in user_prompt
        assert "(CEFR)" not in user_prompt

    def test_distinct_messages_produce_distinct_prompts(self, chat_api, install_service, session):
        first_row = append_user_message(session, content="first draft sentence")
        second_row = append_user_message(session, content="second draft sentence")
        provider = install_service()

        first_response = chat_api.post(improve_url(session.pk, first_row.pk))
        second_response = chat_api.post(improve_url(session.pk, second_row.pk))

        assert first_response.status_code == 200
        assert second_response.status_code == 200
        first_prompt = provider.complete_requests[0].messages[-1].content
        second_prompt = provider.complete_requests[1].messages[-1].content
        assert f'"{first_row.content}"' in first_prompt
        assert f'"{second_row.content}"' in second_prompt
        assert first_prompt != second_prompt

    def test_distinct_messages_are_generated_independently(
        self, chat_api, install_service, session
    ):
        first_row = append_user_message(session, content="first draft sentence")
        second_row = append_user_message(session, content="second draft sentence")
        provider = install_service()

        first = chat_api.post(improve_url(session.pk, first_row.pk))
        second = chat_api.post(improve_url(session.pk, second_row.pk))

        assert first.data["improved"] == IMPROVED_TEXT
        assert second.data["improved"] == IMPROVED_TEXT
        assert len(provider.complete_requests) == 2


# ---------------------------------------------------------------------------
# Provider failures map to normalized API errors without touching data.
# ---------------------------------------------------------------------------


class TestProviderFailures:
    def test_retryable_availability_error_maps_to_503(self, chat_api, install_service, session):
        error = LLMAvailabilityError("upstream collapsed")
        target_row = append_user_message(session)
        install_service(error=error)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 503
        assert response.data["detail"] == str(error)

    def test_permanent_authentication_error_maps_to_502(self, chat_api, install_service, session):
        error = LLMAuthenticationError("bad key")
        target_row = append_user_message(session)
        install_service(error=error)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 502
        assert response.data["detail"] == str(error)

    def test_malformed_completion_maps_to_502(self, chat_api, install_service, session):
        target_row = append_user_message(session)
        error = LLMResponseError(
            "Improvement response was not a JSON object.",
            provider="improvement",
            model=SERVED_MODEL,
        )
        install_service(error=error)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 502
        assert response.data["detail"] == str(error)

    def test_invalid_severity_completion_maps_to_502(self, chat_api, install_service, session):
        target_row = append_user_message(session)
        error = LLMResponseError(
            "Improvement response is missing a valid 'severity' (none|minor|critical).",
            provider="improvement",
            model=SERVED_MODEL,
        )
        install_service(error=error)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 502
        assert response.data["detail"] == str(error)


# ---------------------------------------------------------------------------
# The cached improvement never overwrites the learner's original words, and
# no background work (summaries) is scheduled by the flow.
# ---------------------------------------------------------------------------


class TestPurity:
    def test_message_content_stays_untouched_and_no_background_work_is_scheduled(
        self, chat_api, install_service, session
    ):
        target_row = append_user_message(session)
        append_assistant_turn(session)
        install_service()
        before = snapshot(session)
        callbacks_before = list(connection.run_on_commit)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        # Only the improvement_* fields may change (see TestPersistenceAndIdempotence);
        # the message text, roles and statuses are exactly as before.
        after = snapshot(session)
        assert [(row[0], row[1], row[2], row[3]) for row in after] == [
            (row[0], row[1], row[2], row[3]) for row in before
        ]
        assert list(connection.run_on_commit) == callbacks_before


# ---------------------------------------------------------------------------
# Persistence: the first call caches the improvement on the message row.
# ---------------------------------------------------------------------------


class TestPersistenceAndIdempotence:
    def test_first_call_persists_the_cache(self, chat_api, install_service, session):
        target_row = append_user_message(session)
        install_service()
        before = snapshot(session)

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 200
        target_row.refresh_from_db()
        assert target_row.improvement_content == IMPROVED_TEXT
        assert target_row.improvement_explanation == EXPLANATION
        assert target_row.improvement_severity == SEVERITY
        # Only the improvement fields changed on the row.
        after = [(pk, role, status, content) for pk, role, status, content in snapshot(session)]
        assert [
            (pk, role, status, content)
            for pk, role, status, content in after
            if pk == target_row.pk
        ] == [(row[0], row[1], row[2], row[3]) for row in before if row[0] == target_row.pk]

    def test_repeated_call_returns_the_cache_without_a_provider_call(
        self, chat_api, install_service, session
    ):
        target_row = append_user_message(session)
        install_service()
        first = chat_api.post(improve_url(session.pk, target_row.pk))
        assert first.status_code == 200
        provider = install_service(text="SECOND-CALL-OUTPUT")
        provider.complete_requests.clear()

        second = chat_api.post(improve_url(session.pk, target_row.pk))

        assert second.status_code == 200
        assert second.data["improved"] == IMPROVED_TEXT  # cached, not regenerated
        assert second.data["severity"] == SEVERITY
        assert provider.complete_requests == []

    def test_messages_endpoint_embeds_the_cached_improvement(
        self, chat_api, install_service, session
    ):
        target_row = append_user_message(session)
        install_service()
        chat_api.post(improve_url(session.pk, target_row.pk))

        response = chat_api.get(f"/api/v1/sessions/{session.pk}/messages/")

        assert response.status_code == 200
        rows = response.data["results"] if "results" in response.data else response.data
        target = next(row for row in rows if row["id"] == target_row.pk)
        assert target["improvement"] == {
            "original": SECRET_TEXT,
            "improved": IMPROVED_TEXT,
            "explanation": EXPLANATION,
            "severity": SEVERITY,
        }

    def test_uncached_message_serializes_null_improvement(self, chat_api, session):
        append_user_message(session)

        response = chat_api.get(f"/api/v1/sessions/{session.pk}/messages/")

        assert response.status_code == 200
        rows = response.data["results"] if "results" in response.data else response.data
        assert rows[0]["improvement"] is None

    def test_provider_failure_leaves_no_partial_cache(self, chat_api, install_service, session):
        target_row = append_user_message(session)
        install_service(error=LLMAvailabilityError("upstream collapsed"))

        response = chat_api.post(improve_url(session.pk, target_row.pk))

        assert response.status_code == 503
        target_row.refresh_from_db()
        assert target_row.improvement_severity == ""
        assert target_row.improvement_content == ""


# ---------------------------------------------------------------------------
# Wiring and log hygiene.
# ---------------------------------------------------------------------------


class TestWiring:
    def test_improvement_service_seam_is_cached(self):
        from conversations.views import get_improvement_service

        with override_settings(OPENROUTER_API_KEY="test-key"):
            service = get_improvement_service()
            assert isinstance(service, ImprovementService)
            assert get_improvement_service() is service


class TestLogHygiene:
    def test_no_payload_text_is_logged_on_success_or_failure(
        self, chat_api, install_service, session, caplog
    ):
        target_row = append_user_message(session)
        with caplog.at_level(logging.DEBUG):
            install_service()
            success = chat_api.post(improve_url(session.pk, target_row.pk))
            assert success.status_code == 200

            failed_row = append_user_message(session, content="another draft message")
            install_service(error=LLMAvailabilityError("upstream collapsed"))
            failure = chat_api.post(improve_url(session.pk, failed_row.pk))
            assert failure.status_code == 503

        assert SECRET_TEXT not in caplog.text
        assert IMPROVED_TEXT not in caplog.text
        assert EXPLANATION not in caplog.text
