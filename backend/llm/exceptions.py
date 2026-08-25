"""Normalized LLM provider errors.

Every provider implementation must translate transport- or vendor-specific
failures into this hierarchy so application code never handles raw HTTP
errors. ``retryable`` marks failures where trying again (or another model,
see model fallback) may succeed; permanent request problems are not
retryable.
"""

from __future__ import annotations

from typing import Any


class LLMError(Exception):
    """Base class for all normalized LLM provider failures."""

    def __init__(
        self,
        message: str,
        *,
        provider: str = "llm",
        model: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.provider = provider
        self.model = model
        self.retryable = retryable

    def __str__(self) -> str:
        target = f" [{self.model}]" if self.model else ""
        return f"{self.provider}{target}: {self.message}"


class LLMRequestError(LLMError):
    """Transport-level failure while contacting the provider (retryable)."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        kwargs.setdefault("retryable", True)
        super().__init__(message, **kwargs)


class LLMTimeoutError(LLMRequestError):
    """Provider request exceeded its configured timeout."""


class LLMAuthenticationError(LLMError):
    """Provider rejected credentials (not retryable)."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        kwargs.setdefault("retryable", False)
        super().__init__(message, **kwargs)


class LLMBadRequestError(LLMError):
    """Provider rejected the request payload as invalid (not retryable)."""


class LLMAvailabilityError(LLMError):
    """Provider-side capacity or availability problem (retryable)."""

    def __init__(self, message: str, **kwargs: Any) -> None:
        kwargs.setdefault("retryable", True)
        super().__init__(message, **kwargs)


class LLMResponseError(LLMError):
    """Provider returned a malformed or unusable response."""
