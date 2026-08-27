"""Tests for standardized API error format (TASK-095).

Validates that all error responses follow the consistent structure:
{
    "detail": "<human-readable message>",
    "code": "<ERROR_CODE>",
    "error": {"code", "message", "details?"},
    <field_errors for validation>
}
"""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db

ME_URL = reverse("accounts:me")


@pytest.fixture
def api():
    return APIClient()


def test_unauthenticated_request_returns_standard_error(api: APIClient):
    """Unauthenticated requests get AUTHENTICATION_FAILED with WWW-Authenticate."""
    response = api.get(ME_URL)

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
    assert response.headers["WWW-Authenticate"] == 'Bearer realm="api"'
    data = response.json()
    assert data["detail"] == "Authentication failed or credentials invalid."
    assert data["code"] == "AUTHENTICATION_FAILED"
    assert data["error"]["code"] == "AUTHENTICATION_FAILED"
    assert data["error"]["message"] == "Authentication failed or credentials invalid."
    # no sensitive internals leaked
    assert "traceback" not in str(data)


def test_not_found_returns_standard_error(api: APIClient):
    """404 responses use NOT_FOUND code."""
    from accounts.models import User

    User.objects.create_user(username="bob", email="bob@example.com", password="pw")
    from conversations.models import Session

    bob = User.objects.get(username="bob")
    s = Session.objects.create(user=bob, title="t", topic="x", topic_hint="", learning_level="A1")
    # Access stranger's session as authenticated alice
    alice = User.objects.create_user(username="alice", email="alice@example.com", password="pw")
    api.force_authenticate(user=alice)
    response = api.get(f"/api/v1/sessions/{s.pk}/")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.data
    assert data["code"] == "NOT_FOUND"
    assert data["error"]["code"] == "NOT_FOUND"


def test_validation_error_returns_standard_format(api: APIClient):
    """Validation errors use VALIDATION_ERROR with field-level details."""
    from accounts.models import User

    user = User.objects.create_user(username="alice", email="alice@example.com", password="pw")
    api.force_authenticate(user=user)
    from django.urls import reverse

    vocab_url = reverse("vocabulary:vocabulary-save")
    response = api.post(vocab_url, {"expression": ""}, format="json")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    data = response.data
    assert data["code"] == "VALIDATION_ERROR"
    assert data["error"]["code"] == "VALIDATION_ERROR"
    assert "details" in data["error"]
    assert any(d["field"] == "expression" for d in data["error"]["details"])
    # Field errors also available at top level for DRF backward compat
    assert "expression" in data


def test_permission_denied_returns_standard_error(api: APIClient):
    """Permission denied uses PERMISSION_DENIED."""
    # Create an endpoint that explicitly raises PermissionDenied
    from rest_framework.exceptions import PermissionDenied

    from api.errors import api_exception_handler

    exc = PermissionDenied("Custom permission denied")
    response = api_exception_handler(exc, {})

    assert response.status_code == status.HTTP_403_FORBIDDEN
    data = response.data
    assert data["code"] == "PERMISSION_DENIED"
    assert data["error"]["code"] == "PERMISSION_DENIED"
    assert data["detail"] == "You do not have permission to perform this action."


def test_method_not_allowed_returns_standard_error(api: APIClient):
    """MethodNotAllowed uses INVALID_INPUT with 405."""
    response = api.put("/api/v1/health/")
    assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED
    data = response.data
    assert data["code"] == "INVALID_INPUT"
    assert data["error"]["code"] == "INVALID_INPUT"


def test_llm_error_maps_to_correct_code_and_status(api: APIClient):
    """LLM errors map to LLM_* codes and appropriate status."""
    from unittest.mock import patch

    from accounts.models import User
    from conversations.models import Message, Session
    from llm.exceptions import LLMAuthenticationError

    user = User.objects.create_user(username="alice", email="alice@example.com", password="pw")
    api.force_authenticate(user=user)
    session = Session.objects.create(
        user=user, title="t", topic="x", topic_hint="", learning_level="A1"
    )

    # Clear cache to allow re-injection
    from conversations.views import _settings_suggestion_service

    _settings_suggestion_service.cache_clear()

    message = Message.objects.create(
        session=session,
        role=Message.Role.USER,
        content="hello",
        sequence=1,
        status=Message.Status.COMPLETE,
    )
    suggest_url = reverse(
        "conversations:session-message-suggestions",
        kwargs={"pk": session.pk, "message_pk": message.pk},
    )

    with patch("conversations.views.get_suggestion_service") as mock_get_service:
        mock_service = mock_get_service.return_value
        mock_service.suggest.side_effect = LLMAuthenticationError("bad key")

        response = api.post(suggest_url)

        assert response.status_code == status.HTTP_502_BAD_GATEWAY
        data = response.data
        assert data["code"] == "LLM_AUTH_FAILED"
        assert data["error"]["code"] == "LLM_AUTH_FAILED"
        assert "bad key" in data["detail"]


def test_rate_limit_returns_standard_error():
    """Throttled responses use RATE_LIMITED with retry_after."""
    from rest_framework.exceptions import Throttled

    from api.errors import api_exception_handler

    exc = Throttled(wait=30)
    response = api_exception_handler(exc, {})

    assert response.status_code == status.HTTP_429_TOO_MANY_REQUESTS
    data = response.data
    assert data["code"] == "RATE_LIMITED"
    assert data["error"]["code"] == "RATE_LIMITED"
    assert data["error"]["details"]["retry_after_seconds"] == 30


def test_internal_error_never_leaks_details(api: APIClient):
    """Unhandled exceptions produce INTERNAL_ERROR without stack traces."""
    from api.errors import api_exception_handler

    exc = RuntimeError("boom")
    response = api_exception_handler(exc, {})

    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    data = response.data
    assert data["code"] == "INTERNAL_ERROR"
    assert data["error"]["code"] == "INTERNAL_ERROR"
    assert data["detail"] == "An internal server error occurred."
    # No internals leaked
    assert "boom" not in str(data)
    assert "traceback" not in str(data).lower()


def test_conflict_error_returns_standard_format(api: APIClient):
    """409 Conflict uses CONFLICT code."""
    from accounts.models import User
    from conversations.models import Message, Session

    user = User.objects.create_user(username="alice", email="alice@example.com", password="pw")
    api.force_authenticate(user=user)
    session = Session.objects.create(
        user=user, title="t", topic="x", topic_hint="", learning_level="A1"
    )
    # Create a completed user message
    message = Message.objects.create(
        session=session,
        role=Message.Role.USER,
        content="hello",
        sequence=1,
        status=Message.Status.COMPLETE,
    )
    # Try to retry a COMPLETE message (should be 409 Conflict)
    retry_url = reverse(
        "conversations:session-message-retry",
        kwargs={"pk": session.pk, "message_pk": message.pk},
    )
    response = api.post(retry_url)

    assert response.status_code == status.HTTP_409_CONFLICT
    data = response.data
    assert data["code"] == "CONFLICT"
    assert data["error"]["code"] == "CONFLICT"
    assert "Only failed assistant messages can be retried" in data["detail"]
