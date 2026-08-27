"""Model fallback composition on top of any :class:`llm.provider.LLMProvider`.

A :class:`FallbackProvider` owns an ordered model chain (primary first, then
configured fallbacks) and drives one inner provider with per-request model
overrides. Only retryable failures (transport, timeout, availability — see
:mod:`llm.exceptions`) move to the next model; permanent request problems
(auth, invalid payload, malformed response) surface immediately because a
different model cannot fix them.

Streaming falls back only while probing for the first event. Once any event
has been emitted the attempt is committed — restarting with another model
would duplicate text already consumed downstream, so mid-stream failures
propagate unchanged.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Sequence
from dataclasses import replace

from llm.config import load_model_configuration
from llm.exceptions import LLMAvailabilityError, LLMError, LLMResponseError
from llm.openrouter import OpenRouterProvider
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse, StreamEvent

logger = logging.getLogger("llm.fallback")


class FallbackProvider(LLMProvider):
    """LLMProvider decorator trying configured models in order.

    ``models`` is the ordered chain; entry 0 is the primary model. When a
    request pins its own ``model``, that pin is used for a single attempt and
    the chain is bypassed. The wrapped provider is never closed implicitly by
    attempts themselves; :meth:`close` delegates to it when it offers one.
    """

    def __init__(self, *, provider: LLMProvider, models: Sequence[str]) -> None:
        cleaned = tuple(model.strip() for model in models)
        if not cleaned or any(not model for model in cleaned):
            raise ValueError("FallbackProvider requires at least one non-blank model name.")
        self.provider = provider
        self.models = cleaned

    @classmethod
    def from_settings(cls) -> FallbackProvider:
        """Build a settings-driven OpenRouter provider with its model chain."""
        config = load_model_configuration()
        return cls(
            provider=OpenRouterProvider(
                api_key=config.api_key,
                base_url=config.base_url,
                default_model=config.primary_model,
                connect_timeout=config.connect_timeout_seconds,
                read_timeout=config.read_timeout_seconds,
            ),
            models=config.model_chain,
        )

    @property
    def primary_model(self) -> str:
        return self.models[0]

    def close(self) -> None:
        """Close the inner provider when it supports closing."""
        closer = getattr(self.provider, "close", None)
        if callable(closer):
            closer()

    def __enter__(self) -> FallbackProvider:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        errors: list[tuple[str, str]] = []
        last_error: LLMError | None = None
        for index, model in enumerate(self._chain_for(request)):
            try:
                response = self.provider.complete(replace(request, model=model))
            except LLMError as exc:
                errors.append((model, exc.message))
                last_error = exc
                if not exc.retryable:
                    logger.warning(
                        "fallback aborted: non-retryable %s from model=%s",
                        type(exc).__name__,
                        model,
                    )
                    raise
                logger.warning(
                    "fallback: model=%s failed (%s); %d model(s) remaining",
                    model,
                    exc,
                    len(self.models) - index - 1,
                )
                continue
            if index > 0:
                logger.info(
                    "completion succeeded on fallback model=%s after %d attempt(s)",
                    response.model,
                    index + 1,
                )
            return response
        raise self._all_models_failed(errors, last_error)

    def stream(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        return self._stream_with_fallback(request)

    def _stream_with_fallback(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        errors: list[tuple[str, str]] = []
        last_error: LLMError | None = None
        for index, model in enumerate(self._chain_for(request)):
            events = self.provider.stream(replace(request, model=model))
            try:
                first_event = next(events)
            except StopIteration as exc:
                # Provider contract violation: streams must begin with an event.
                raise LLMResponseError(
                    "Provider stream ended before emitting any event.",
                    provider="fallback",
                    model=model,
                ) from exc
            except LLMError as exc:
                if not exc.retryable:
                    logger.warning(
                        "fallback aborted before first event: non-retryable %s from model=%s",
                        type(exc).__name__,
                        model,
                    )
                    raise
                errors.append((model, exc.message))
                last_error = exc
                logger.warning(
                    "fallback: stream probe failed for model=%s (%s); %d model(s) remaining",
                    model,
                    exc,
                    len(self.models) - index - 1,
                )
                continue
            if index > 0:
                logger.info(
                    "stream committed to fallback model=%s after %d attempt(s)",
                    model,
                    index + 1,
                )
            yield first_event
            yield from events
            return
        raise self._all_models_failed(errors, last_error)

    def _chain_for(self, request: CompletionRequest) -> tuple[str, ...]:
        """An explicit per-request model pin replaces the whole chain."""
        if request.model is not None:
            return (request.model,)
        return self.models

    def _all_models_failed(
        self,
        errors: list[tuple[str, str]],
        last_error: LLMError | None,
    ) -> LLMAvailabilityError:
        detail = "; ".join(f"{model}: {message}" for model, message in errors)
        logger.warning("fallback exhausted after %d attempt(s)", len(errors))
        raise LLMAvailabilityError(
            f"all {len(errors)} configured model(s) failed: {detail}",
            provider="fallback",
        ) from last_error


__all__ = ["FallbackProvider"]
