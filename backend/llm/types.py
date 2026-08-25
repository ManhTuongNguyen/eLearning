"""Normalized data structures shared by all LLM provider implementations.

These types are transport-agnostic: they carry no OpenRouter (or any other
vendor) specifics, so application code and tests can build requests and
consume responses without importing any HTTP client.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

MessageRole = Literal["system", "user", "assistant"]

VALID_ROLES: frozenset[str] = frozenset({"system", "user", "assistant"})


@dataclass(frozen=True)
class Message:
    """A single chat message exchanged with the LLM."""

    role: MessageRole
    content: str

    def __post_init__(self) -> None:
        if self.role not in VALID_ROLES:
            allowed = ", ".join(sorted(VALID_ROLES))
            raise ValueError(f"Invalid message role {self.role!r}; expected one of: {allowed}.")
        if not self.content.strip():
            raise ValueError("Message content must not be empty.")


@dataclass(frozen=True)
class CompletionRequest:
    """Parameters for one LLM completion (streaming or non-streaming).

    ``model`` is an optional per-request override; when omitted the provider
    resolves its own configured default. ``temperature`` follows the common
    0.0–2.0 range used across chat completion APIs.
    """

    messages: tuple[Message, ...]
    model: str | None = None
    temperature: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "messages", tuple(self.messages))
        if not self.messages:
            raise ValueError("CompletionRequest requires at least one message.")
        if self.model is not None and not self.model.strip():
            raise ValueError("model must be a non-empty string when provided.")
        if self.temperature is not None and not 0.0 <= self.temperature <= 2.0:
            raise ValueError("temperature must be between 0.0 and 2.0.")

    @classmethod
    def from_texts(
        cls,
        texts: Iterable[tuple[MessageRole, str]],
        *,
        model: str | None = None,
        temperature: float | None = None,
    ) -> CompletionRequest:
        """Build a request from ``(role, content)`` pairs."""
        return cls(
            messages=[Message(role=role, content=content) for role, content in texts],
            model=model,
            temperature=temperature,
        )


@dataclass(frozen=True)
class CompletionResponse:
    """Normalized result of a successful non-streaming completion."""

    text: str
    model: str
    finish_reason: str | None = None
    request_id: str | None = None


@dataclass(frozen=True)
class StreamStart:
    """First event of every stream: announces the resolved model."""

    model: str


@dataclass(frozen=True)
class StreamDelta:
    """Incremental text chunk emitted while the completion is generated."""

    text: str

    def __post_init__(self) -> None:
        if not self.text:
            raise ValueError("StreamDelta text must not be empty.")


StreamEvent = StreamStart | StreamDelta

__all__ = [
    "VALID_ROLES",
    "CompletionRequest",
    "CompletionResponse",
    "Message",
    "MessageRole",
    "StreamDelta",
    "StreamEvent",
    "StreamStart",
]
