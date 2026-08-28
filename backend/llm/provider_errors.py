"""Shared failure normalization for provider HTTP transports.

Every provider adapter translates its vendor's transport, HTTP, and payload
failures into the normalized :mod:`llm.exceptions` hierarchy through the
helpers in this module, so the status→error mapping exists in exactly one
place regardless of how many providers are supported. Error messages are
truncated and never contain authentication material.
"""

from __future__ import annotations

import json
from typing import Any

from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)

MAX_ERROR_SNIPPET_LENGTH = 300

# Shared HTTP status → normalized failure class mapping.
AUTH_STATUSES = frozenset({401, 403})
BAD_REQUEST_STATUSES = frozenset({400, 404, 413, 422})
TIMEOUT_STATUS = 408


def extract_error_message(body_text: str) -> str:
    """Pull a human-readable message out of an error body; never includes secrets."""
    snippet = body_text.strip()[:MAX_ERROR_SNIPPET_LENGTH]
    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        return snippet or "empty error body"
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:MAX_ERROR_SNIPPET_LENGTH]
        if isinstance(payload.get("message"), str):
            return payload["message"][:MAX_ERROR_SNIPPET_LENGTH]
    return snippet or "unrecognized error body"


def normalize_http_failure(
    provider: str,
    status_code: int,
    message: str,
    *,
    model: str | None,
) -> LLMError:
    """Map an HTTP status + message onto the normalized error hierarchy."""
    kwargs: dict[str, Any] = {"provider": provider, "model": model}
    if status_code in AUTH_STATUSES:
        return LLMAuthenticationError(message, **kwargs)
    if status_code in BAD_REQUEST_STATUSES:
        return LLMBadRequestError(message, **kwargs)
    if status_code == TIMEOUT_STATUS:
        return LLMTimeoutError(message, **kwargs)
    if status_code == 429 or status_code >= 500:
        return LLMAvailabilityError(message, **kwargs)
    return LLMResponseError(f"unexpected HTTP {status_code}: {message}", **kwargs)


def timeout_failure(
    provider: str,
    *,
    connect_timeout: float,
    read_timeout: float,
    model: str | None,
) -> LLMTimeoutError:
    """Normalized failure for an exceeded connect/read timeout."""
    return LLMTimeoutError(
        f"request timed out (connect={connect_timeout:g}s, read={read_timeout:g}s)",
        provider=provider,
        model=model,
    )


def transport_failure(provider: str, exc: Exception, *, model: str | None) -> LLMRequestError:
    """Normalized failure for a connection/transport-level problem."""
    return LLMRequestError(
        f"transport failure: {type(exc).__name__}",
        provider=provider,
        model=model,
    )


__all__ = [
    "MAX_ERROR_SNIPPET_LENGTH",
    "extract_error_message",
    "normalize_http_failure",
    "timeout_failure",
    "transport_failure",
]
