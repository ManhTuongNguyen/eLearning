"""Application-level LLM provider interface.

Application and service code must depend only on :class:`LLMProvider`; concrete
integrations (OpenRouter, test fakes, future local models) implement this
interface behind it. Nothing in this module references any HTTP client or
vendor SDK — the OpenRouter transport arrives in the provider implementation
task and stays invisible to callers.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator

from llm.types import CompletionRequest, CompletionResponse, StreamEvent


class LLMProvider(ABC):
    """Transport-agnostic contract for every LLM integration.

    Implementations translate normalized requests into vendor calls and
    normalize every failure into the :mod:`llm.exceptions` hierarchy.
    """

    @abstractmethod
    def complete(self, request: CompletionRequest) -> CompletionResponse:
        """Return one complete response for the requested conversation."""

    @abstractmethod
    def stream(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        """Yield :data:`llm.types.StreamEvent` items incrementally.

        The first event is always :class:`llm.types.StreamStart`; subsequent
        events carry text deltas. Generator exhaustion signals success; any
        failure is raised as an ``LLMError`` subclass.
        """
