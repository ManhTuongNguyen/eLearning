"""Standardized API error response format.

All API errors returned to clients follow a consistent structure:

{
    "detail": "<human-readable message>",
    "code": "<ERROR_CODE>",
    "error": {
        "code": "<ERROR_CODE>",
        "message": "<human-readable message>",
        "details": {...}  # Optional structured details
    }
}

The top-level ``detail`` and ``code`` fields keep DRF's default error
contract for backward compatibility (callers reading ``response.data['detail']``
or ``response.data['code']`` keep working). The nested ``error`` block
carries the richer structured form so new clients (and tests) can rely
on a single canonical shape:

- ``error.code`` - machine-readable error code (e.g. ``VALIDATION_ERROR``)
- ``error.message`` - human-readable description
- ``error.details`` - optional structured details (field-level errors,
  retry hints, etc.)

Goals:
- Predictable validation error structure
- Predictable authentication error structure
- Server errors never leak internal details
- Frontend can reliably parse and display useful messages
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class APIErrorCode(StrEnum):
    """Standardized error codes for API responses."""

    # Validation errors
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INVALID_INPUT = "INVALID_INPUT"
    MISSING_FIELD = "MISSING_FIELD"

    # Authentication/Authorization errors
    AUTHENTICATION_FAILED = "AUTHENTICATION_FAILED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_INVALID = "TOKEN_INVALID"
    PERMISSION_DENIED = "PERMISSION_DENIED"

    # Resource errors
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    ALREADY_EXISTS = "ALREADY_EXISTS"

    # LLM/Provider errors
    LLM_ERROR = "LLM_ERROR"
    LLM_TIMEOUT = "LLM_TIMEOUT"
    LLM_UNAVAILABLE = "LLM_UNAVAILABLE"
    LLM_AUTH_FAILED = "LLM_AUTH_FAILED"
    LLM_BAD_REQUEST = "LLM_BAD_REQUEST"

    # Server errors
    INTERNAL_ERROR = "INTERNAL_ERROR"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"

    # Rate limiting
    RATE_LIMITED = "RATE_LIMITED"


@dataclass(frozen=True, slots=True)
class ErrorDetail:
    """Structured error detail for a single validation failure."""

    field: str
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class APIError(Exception):
    """Base API error with structured response format.

    Carries both a flat ``detail``/``code`` shape (DRF default) and a
    richer nested ``error`` block (canonical shape). Handlers can build
    either form from one error instance.
    """

    code: APIErrorCode
    message: str
    field_errors: list[ErrorDetail] | None = None
    extra: dict[str, Any] | None = None
    status_code: int = 400

    def to_dict(self) -> dict[str, Any]:
        """Build the full response body, DRF-compatible + canonical block."""
        body: dict[str, Any] = {
            "detail": self.message,
            "code": self.code.value,
        }
        error_block: dict[str, Any] = {
            "code": self.code.value,
            "message": self.message,
        }
        if self.field_errors:
            error_block["details"] = [
                {"field": d.field, "code": d.code, "message": d.message} for d in self.field_errors
            ]
        if self.extra:
            error_block["details"] = {**(error_block.get("details") or {}), **self.extra}
        body["error"] = error_block
        return body


# Mapping of LLMError subclass -> APIErrorCode.
_LLM_ERROR_CODE_MAP = {
    "LLMRequestError": APIErrorCode.LLM_ERROR,
    "LLMTimeoutError": APIErrorCode.LLM_TIMEOUT,
    "LLMAuthenticationError": APIErrorCode.LLM_AUTH_FAILED,
    "LLMBadRequestError": APIErrorCode.LLM_BAD_REQUEST,
    "LLMAvailabilityError": APIErrorCode.LLM_UNAVAILABLE,
    "LLMResponseError": APIErrorCode.LLM_ERROR,
}


def api_exception_handler(exc: Exception, context: dict[str, Any]) -> Any:
    """DRF exception handler that normalizes all errors to the standard format.

    Every error response includes:

    - ``detail`` (DRF-compatible human-readable message)
    - ``code`` (machine-readable error code)
    - ``error`` (canonical nested block: code, message, optional details)

    Mapping:
    - DRF ``ValidationError`` -> ``VALIDATION_ERROR`` with field-level
      ``details`` entries plus the DRF-compatible ``field_errors`` map.
    - DRF ``AuthenticationFailed`` / ``NotAuthenticated`` ->
      ``AUTHENTICATION_FAILED`` (401) with a ``WWW-Authenticate: Bearer``
      header.
    - DRF ``PermissionDenied`` -> ``PERMISSION_DENIED`` (403).
    - DRF ``NotFound`` -> ``NOT_FOUND`` (404).
    - DRF ``Throttled`` -> ``RATE_LIMITED`` (429) with ``retry_after``.
    - LLM ``LLMError`` -> the matching ``LLM_*`` code; status is 503 for
      retryable failures, 502 otherwise.
    - ``APIException`` (other) -> ``INVALID_INPUT`` at the exception's
      status code.
    - ``django.http.Http404`` -> ``NOT_FOUND`` (404).
    - Anything else -> ``INTERNAL_ERROR`` (500); internal details are
      never leaked into the payload (logged separately).
    """
    from django.http import Http404
    from rest_framework import exceptions as drf_exceptions
    from rest_framework import status
    from rest_framework.response import Response

    from llm.exceptions import LLMError

    # Validation errors
    if isinstance(exc, drf_exceptions.ValidationError):
        api_error = _from_validation_error(exc)
        body = api_error.to_dict()
        # Preserve DRF's default field-error map for backward compatibility
        # with existing API consumers (top-level field keys remain reachable).
        field_map = exc.detail if isinstance(exc.detail, dict) else {}
        for field, errors in field_map.items():
            body[field] = errors
        return Response(body, status=api_error.status_code)

    # Authentication
    if isinstance(exc, (drf_exceptions.AuthenticationFailed, drf_exceptions.NotAuthenticated)):
        api_error = APIError(
            code=APIErrorCode.AUTHENTICATION_FAILED,
            message="Authentication failed or credentials invalid.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
        response = Response(api_error.to_dict(), status=api_error.status_code)
        response["WWW-Authenticate"] = 'Bearer realm="api"'
        return response

    # Permission denied
    if isinstance(exc, drf_exceptions.PermissionDenied):
        api_error = APIError(
            code=APIErrorCode.PERMISSION_DENIED,
            message="You do not have permission to perform this action.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Not found
    if isinstance(exc, drf_exceptions.NotFound):
        api_error = APIError(
            code=APIErrorCode.NOT_FOUND,
            message="The requested resource was not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Throttling
    if isinstance(exc, drf_exceptions.Throttled):
        wait = getattr(exc, "wait", None)
        message = "Too many requests. Please slow down."
        if wait is not None:
            message = f"Too many requests. Please retry in {int(wait)} seconds."
        api_error = APIError(
            code=APIErrorCode.RATE_LIMITED,
            message=message,
            extra={"retry_after_seconds": int(wait)} if wait is not None else None,
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # LLM errors
    if isinstance(exc, LLMError):
        api_error = _from_llm_error(exc)
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Conflict (409) - e.g. retry/improve on non-retryable message state
    if (
        isinstance(exc, drf_exceptions.APIException)
        and getattr(exc, "status_code", None) == status.HTTP_409_CONFLICT
    ):
        message = str(exc.detail) if hasattr(exc, "detail") else "Conflict."
        api_error = APIError(
            code=APIErrorCode.CONFLICT,
            message=message,
            status_code=status.HTTP_409_CONFLICT,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Generic DRF APIException (ParseError, UnsupportedMediaType, MethodNotAllowed, etc.)
    if isinstance(exc, drf_exceptions.APIException):
        message = str(exc.detail) if hasattr(exc, "detail") else "Invalid request."
        status_code = (
            getattr(exc, "status_code", status.HTTP_400_BAD_REQUEST) or status.HTTP_400_BAD_REQUEST
        )
        api_error = APIError(
            code=APIErrorCode.INVALID_INPUT,
            message=message,
            status_code=status_code,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Django Http404 (raised explicitly by some views)
    if isinstance(exc, Http404):
        api_error = APIError(
            code=APIErrorCode.NOT_FOUND,
            message="The requested resource was not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
        return Response(api_error.to_dict(), status=api_error.status_code)

    # Unhandled exception: never leak internals.
    import logging

    logger = logging.getLogger(__name__)
    logger.exception("Unhandled API exception: %s", exc)

    api_error = APIError(
        code=APIErrorCode.INTERNAL_ERROR,
        message="An internal server error occurred.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )
    return Response(api_error.to_dict(), status=api_error.status_code)


def _from_validation_error(exc: Any) -> APIError:
    """Convert a DRF ValidationError into an APIError with field details."""
    from rest_framework import status

    field_errors = _extract_field_errors(exc.detail)
    return APIError(
        code=APIErrorCode.VALIDATION_ERROR,
        message="Request validation failed.",
        field_errors=field_errors,
        status_code=status.HTTP_400_BAD_REQUEST,
    )


def _extract_field_errors(detail: Any) -> list[ErrorDetail]:
    """Flatten a DRF ValidationError detail into per-field entries."""
    items: list[ErrorDetail] = []
    if isinstance(detail, dict):
        for field, errors in detail.items():
            for error in _as_list(errors):
                items.append(ErrorDetail(field=str(field), code="INVALID", message=str(error)))
    else:
        for error in _as_list(detail):
            items.append(ErrorDetail(field="non_field_errors", code="INVALID", message=str(error)))
    return items


def _as_list(value: Any) -> list[Any]:
    """DRF returns a single message or a list; normalize to a list."""
    if isinstance(value, list):
        return value
    return [value]


def _from_llm_error(exc: Any) -> APIError:
    """Convert an LLMError to an APIError."""
    from rest_framework import status

    code = _LLM_ERROR_CODE_MAP.get(type(exc).__name__, APIErrorCode.LLM_ERROR)
    status_code = (
        status.HTTP_503_SERVICE_UNAVAILABLE
        if getattr(exc, "retryable", False)
        else status.HTTP_502_BAD_GATEWAY
    )
    # Use the full ``str(exc)`` form (provider + model + message) for the
    # public detail so existing clients see the same wording they did
    # before the standard error format landed.
    detail_message = str(exc)
    return APIError(
        code=code,
        message=detail_message,
        status_code=status_code,
    )
