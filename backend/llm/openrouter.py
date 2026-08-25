"""OpenRouter integration behind the application-level LLMProvider interface.

This module is the only place in the backend that knows about OpenRouter's
HTTP surface (chat completions endpoint, SSE streaming, error payload shapes).
Every failure is normalized into the :mod:`llm.exceptions` hierarchy before it
escapes, and the API key never appears in logs, exceptions, or payloads beyond
the ``Authorization`` header.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from typing import Any

import httpx
from django.conf import settings

from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMBadRequestError,
    LLMError,
    LLMRequestError,
    LLMResponseError,
    LLMTimeoutError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse, StreamDelta, StreamEvent, StreamStart

logger = logging.getLogger("llm.openrouter")

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
CHAT_COMPLETIONS_PATH = "/chat/completions"
MAX_ERROR_SNIPPET_LENGTH = 300

# OpenRouter HTTP status → normalized failure class.
_AUTH_STATUSES = frozenset({401, 403})
_BAD_REQUEST_STATUSES = frozenset({400, 404, 413, 422})
_TIMEOUT_STATUS = 408


class OpenRouterProvider(LLMProvider):
    """LLMProvider implementation talking to the OpenRouter chat API."""

    def __init__(
        self,
        *,
        api_key: str,
        default_model: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("OpenRouter api_key must be a non-empty string.")
        if not default_model.strip():
            raise ValueError("OpenRouter default_model must be a non-empty string.")
        if not base_url.strip():
            raise ValueError("OpenRouter base_url must be a non-empty string.")
        if timeout <= 0:
            raise ValueError("OpenRouter timeout must be greater than zero.")

        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.timeout = float(timeout)
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=self.base_url,
            timeout=httpx.Timeout(self.timeout),
        )

    @classmethod
    def from_settings(cls) -> OpenRouterProvider:
        """Build a provider from Django settings (env-driven configuration)."""
        return cls(
            api_key=settings.OPENROUTER_API_KEY,
            base_url=settings.OPENROUTER_BASE_URL,
            default_model=settings.LLM_PRIMARY_MODEL,
            timeout=float(settings.LLM_REQUEST_TIMEOUT_SECONDS),
        )

    def close(self) -> None:
        """Close the underlying HTTP client when this provider owns it."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> OpenRouterProvider:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        """Run one non-streaming chat completion."""
        payload = self._build_payload(request, stream=False)
        model_label = str(payload["model"])
        started_at = time.monotonic()
        try:
            response = self._client.post(
                CHAT_COMPLETIONS_PATH,
                json=payload,
                headers=self._auth_headers(),
            )
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(model_label) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, model_label) from exc

        duration_ms = (time.monotonic() - started_at) * 1000
        request_id = response.headers.get("x-request-id")
        if response.status_code != 200:
            logger.warning(
                "openrouter completion failed status=%s model=%s request_id=%s duration_ms=%.0f",
                response.status_code,
                model_label,
                request_id,
                duration_ms,
            )
            raise self._http_failure(
                response.status_code,
                self._extract_error_message(response.text),
                model=model_label,
            )

        body = self._parse_success_json(response.text, model=model_label)
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMResponseError(
                "Response contains no choices.", provider="openrouter", model=model_label
            )
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise LLMResponseError(
                "Response choice has no string message content.",
                provider="openrouter",
                model=model_label,
            )

        resolved_model = body.get("model") if isinstance(body.get("model"), str) else model_label
        finish_reason = choices[0].get("finish_reason")
        if request_id is None and isinstance(body.get("id"), str):
            request_id = body["id"]

        logger.info(
            "openrouter completion succeeded model=%s request_id=%s duration_ms=%.0f chars=%d",
            resolved_model,
            request_id,
            duration_ms,
            len(content),
        )
        return CompletionResponse(
            text=content,
            model=resolved_model,
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            request_id=request_id,
        )

    def stream(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        """Yield StreamStart followed by StreamDelta items for one completion."""
        payload = self._build_payload(request, stream=True)
        return self._iter_stream_events(payload, model_label=str(payload["model"]))

    def _iter_stream_events(
        self, payload: dict[str, Any], *, model_label: str
    ) -> Iterator[StreamEvent]:
        effective_model = model_label
        started_at = time.monotonic()
        received_chunk = False
        try:
            with self._client.stream(
                "POST",
                CHAT_COMPLETIONS_PATH,
                json=payload,
                headers=self._auth_headers(),
            ) as response:
                request_id = response.headers.get("x-request-id")
                if response.status_code != 200:
                    response.read()
                    logger.warning(
                        "openrouter stream failed status=%s model=%s request_id=%s",
                        response.status_code,
                        model_label,
                        request_id,
                    )
                    raise self._http_failure(
                        response.status_code,
                        self._extract_error_message(response.text),
                        model=model_label,
                    )

                start_emitted = False
                delta_count = 0
                for line in response.iter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        # Blank separators and OpenRouter keep-alive comments.
                        continue
                    if not line.startswith("data:"):
                        raise LLMResponseError(
                            f"Unexpected SSE line: {line[:80]!r}",
                            provider="openrouter",
                            model=model_label,
                        )
                    data = line[len("data:") :].strip()
                    if data == "[DONE]":
                        break
                    chunk = self._parse_success_json(data, model=model_label)
                    received_chunk = True
                    chunk_model = chunk.get("model")
                    if isinstance(chunk_model, str) and chunk_model:
                        effective_model = chunk_model
                    if not start_emitted:
                        yield StreamStart(model=effective_model)
                        start_emitted = True

                    choices = chunk.get("choices")
                    piece = ""
                    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                        delta = choices[0].get("delta")
                        if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                            piece = delta["content"]
                    if piece:
                        yield StreamDelta(text=piece)
                        delta_count += 1

                if not received_chunk:
                    raise LLMResponseError(
                        "Provider closed the stream without sending any events.",
                        provider="openrouter",
                        model=effective_model,
                    )

            logger.info(
                "openrouter stream completed model=%s request_id=%s duration_ms=%.0f deltas=%d",
                effective_model,
                request_id,
                (time.monotonic() - started_at) * 1000,
                delta_count,
            )
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(effective_model) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, effective_model) from exc

    def _build_payload(self, request: CompletionRequest, *, stream: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": request.model or self.default_model,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "stream": stream,
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        return payload

    def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _parse_success_json(self, raw: str, *, model: str) -> dict[str, Any]:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LLMResponseError(
                f"Malformed JSON from provider: {exc.msg}",
                provider="openrouter",
                model=model,
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMResponseError(
                "Provider returned a non-object JSON payload.",
                provider="openrouter",
                model=model,
            )
        return parsed

    def _extract_error_message(self, body_text: str) -> str:
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

    def _http_failure(self, status_code: int, message: str, *, model: str) -> LLMError:
        kwargs: dict[str, Any] = {"provider": "openrouter", "model": model}
        if status_code in _AUTH_STATUSES:
            return LLMAuthenticationError(message, **kwargs)
        if status_code in _BAD_REQUEST_STATUSES:
            return LLMBadRequestError(message, **kwargs)
        if status_code == _TIMEOUT_STATUS:
            return LLMTimeoutError(message, **kwargs)
        if status_code == 429 or status_code >= 500:
            return LLMAvailabilityError(message, **kwargs)
        return LLMResponseError(f"unexpected HTTP {status_code}: {message}", **kwargs)

    def _timeout_failure(self, model: str) -> LLMTimeoutError:
        logger.warning("openrouter request timed out model=%s timeout=%.0fs", model, self.timeout)
        return LLMTimeoutError(
            f"request exceeded timeout of {self.timeout:g}s",
            provider="openrouter",
            model=model,
        )

    def _transport_failure(self, exc: Exception, model: str) -> LLMRequestError:
        logger.warning("openrouter transport failure model=%s error=%s", model, type(exc).__name__)
        return LLMRequestError(
            f"transport failure: {type(exc).__name__}",
            provider="openrouter",
            model=model,
        )


__all__ = ["DEFAULT_BASE_URL", "OpenRouterProvider"]
