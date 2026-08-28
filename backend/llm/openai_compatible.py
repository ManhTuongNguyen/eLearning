"""OpenAI-compatible chat API integration behind the LLMProvider interface.

This module implements the ``/chat/completions`` contract (non-streaming,
SSE streaming, ``/models`` catalog) that OpenRouter, OpenAI, 9Router, and
most OpenAI-compatible vendors share. Concrete providers subclass
:class:`OpenAICompatibleProvider` and only supply their identity
(``provider_name``) and default endpoint (``default_base_url``) — no vendor
logic is duplicated per provider.

Every failure is normalized into the :mod:`llm.exceptions` hierarchy before
it escapes (shared with all other providers via :mod:`llm.provider_errors`),
and the API key never appears in logs, exceptions, or payloads beyond the
``Authorization`` header.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from typing import Any, Self

import httpx
from django.core.exceptions import ImproperlyConfigured

from llm.config import load_model_configuration
from llm.exceptions import LLMError, LLMResponseError
from llm.provider import LLMProvider
from llm.provider_errors import (
    extract_error_message,
    normalize_http_failure,
    timeout_failure,
    transport_failure,
)
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    ModelInfo,
    StreamDelta,
    StreamEvent,
    StreamStart,
)

CHAT_COMPLETIONS_PATH = "/chat/completions"
MODELS_PATH = "/models"


class OpenAICompatibleProvider(LLMProvider):
    """Provider for any vendor exposing the OpenAI chat-completions API.

    Subclasses set ``provider_name`` (used in logs and normalized errors) and
    ``default_base_url`` (used when no explicit base URL is given; generic
    OpenAI-compatible deployments must pass one).
    """

    provider_name: str = "openai-compatible"
    default_base_url: str | None = None

    def __init__(
        self,
        *,
        api_key: str,
        default_model: str,
        base_url: str | None = None,
        connect_timeout: float = 10.0,
        read_timeout: float = 60.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key.strip():
            raise ValueError(f"{self.provider_name} api_key must be a non-empty string.")
        if not default_model.strip():
            raise ValueError(f"{self.provider_name} default_model must be a non-empty string.")
        if base_url is not None and not base_url.strip():
            raise ValueError(f"{self.provider_name} base_url must be a non-empty string.")
        if base_url is None and self.default_base_url is None:
            raise ValueError(f"{self.provider_name} requires an explicit base_url.")
        if connect_timeout <= 0:
            raise ValueError(f"{self.provider_name} connect_timeout must be greater than zero.")
        if read_timeout <= 0:
            raise ValueError(f"{self.provider_name} read_timeout must be greater than zero.")

        self.api_key = api_key
        self.base_url = (base_url or self.default_base_url or "").rstrip("/")
        self.default_model = default_model
        self.connect_timeout = float(connect_timeout)
        self.read_timeout = float(read_timeout)
        self._log = logging.getLogger(f"llm.{self.provider_name}")
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=self.base_url,
            timeout=httpx.Timeout(
                connect=self.connect_timeout,
                read=self.read_timeout,
                write=self.connect_timeout,
                pool=self.connect_timeout,
            ),
        )

    @classmethod
    def from_settings(cls) -> Self:
        """Build this provider from the settings-driven model configuration.

        Raises :class:`ImproperlyConfigured` when ``LLM_PROVIDER`` selects a
        different provider — provider selection is centralized in the
        registry, never implied by which class happens to call this.
        """
        config = load_model_configuration()
        if config.provider != cls.provider_name:
            raise ImproperlyConfigured(
                f"LLM_PROVIDER is {config.provider!r}; {cls.provider_name} cannot be "
                "built from these settings."
            )
        return cls(
            api_key=config.api_key,
            base_url=config.base_url,
            default_model=config.primary_model,
            connect_timeout=config.connect_timeout_seconds,
            read_timeout=config.read_timeout_seconds,
        )

    def close(self) -> None:
        """Close the underlying HTTP client when this provider owns it."""
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
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
            self._log.warning(
                "%s completion failed status=%s model=%s request_id=%s duration_ms=%.0f",
                self.provider_name,
                response.status_code,
                model_label,
                request_id,
                duration_ms,
            )
            raise self._http_failure(
                response.status_code,
                extract_error_message(response.text),
                model=model_label,
            )

        body = self._parse_success_json(response.text, model=model_label)
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMResponseError(
                "Response contains no choices.",
                provider=self.provider_name,
                model=model_label,
            )
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str):
            raise LLMResponseError(
                "Response choice has no string message content.",
                provider=self.provider_name,
                model=model_label,
            )

        resolved_model = body.get("model") if isinstance(body.get("model"), str) else model_label
        finish_reason = choices[0].get("finish_reason")
        if request_id is None and isinstance(body.get("id"), str):
            request_id = body["id"]

        self._log.info(
            "%s completion succeeded model=%s request_id=%s duration_ms=%.0f chars=%d",
            self.provider_name,
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
                    self._log.warning(
                        "%s stream failed status=%s model=%s request_id=%s",
                        self.provider_name,
                        response.status_code,
                        model_label,
                        request_id,
                    )
                    raise self._http_failure(
                        response.status_code,
                        extract_error_message(response.text),
                        model=model_label,
                    )

                start_emitted = False
                delta_count = 0
                for line in response.iter_lines():
                    line = line.strip()
                    if not line or line.startswith(":"):
                        # Blank separators and provider keep-alive comments.
                        continue
                    if not line.startswith("data:"):
                        raise LLMResponseError(
                            f"Unexpected SSE line: {line[:80]!r}",
                            provider=self.provider_name,
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
                        provider=self.provider_name,
                        model=effective_model,
                    )

            self._log.info(
                "%s stream completed model=%s request_id=%s duration_ms=%.0f deltas=%d",
                self.provider_name,
                effective_model,
                request_id,
                (time.monotonic() - started_at) * 1000,
                delta_count,
            )
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(effective_model) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, effective_model) from exc

    def list_models(self) -> tuple[ModelInfo, ...]:
        """Retrieve the provider's available models in normalized form."""
        started_at = time.monotonic()
        try:
            response = self._client.get(MODELS_PATH, headers=self._auth_headers())
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(None) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, None) from exc

        if response.status_code != 200:
            self._log.warning(
                "%s models listing failed status=%s duration_ms=%.0f",
                self.provider_name,
                response.status_code,
                (time.monotonic() - started_at) * 1000,
            )
            raise self._http_failure(
                response.status_code,
                extract_error_message(response.text),
                model=None,
            )

        body = self._parse_success_json(response.text, model=None)
        entries = body.get("data")
        if not isinstance(entries, list):
            raise LLMResponseError(
                "Models response contains no data list.", provider=self.provider_name
            )

        models: list[ModelInfo] = []
        skipped = 0
        for entry in entries:
            parsed = _parse_model_entry(entry)
            if parsed is None:
                skipped += 1
                continue
            models.append(parsed)

        self._log.info(
            "%s models listed count=%d skipped=%d duration_ms=%.0f",
            self.provider_name,
            len(models),
            skipped,
            (time.monotonic() - started_at) * 1000,
        )
        return tuple(models)

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

    def _parse_success_json(self, raw: str, *, model: str | None) -> dict[str, Any]:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise LLMResponseError(
                f"Malformed JSON from provider: {exc.msg}",
                provider=self.provider_name,
                model=model,
            ) from exc
        if not isinstance(parsed, dict):
            raise LLMResponseError(
                "Provider returned a non-object JSON payload.",
                provider=self.provider_name,
                model=model,
            )
        return parsed

    def _http_failure(self, status_code: int, message: str, *, model: str | None) -> LLMError:
        return normalize_http_failure(self.provider_name, status_code, message, model=model)

    def _timeout_failure(self, model: str | None) -> LLMError:
        self._log.warning(
            "%s request timed out model=%s connect_timeout=%.0fs read_timeout=%.0fs",
            self.provider_name,
            model,
            self.connect_timeout,
            self.read_timeout,
        )
        return timeout_failure(
            self.provider_name,
            connect_timeout=self.connect_timeout,
            read_timeout=self.read_timeout,
            model=model,
        )

    def _transport_failure(self, exc: Exception, model: str | None) -> LLMError:
        self._log.warning(
            "%s transport failure model=%s error=%s",
            self.provider_name,
            model,
            type(exc).__name__,
        )
        return transport_failure(self.provider_name, exc, model=model)


def _int_or_none(value: Any) -> int | None:
    """Pass through genuine ints only (bool is an int subclass but never valid here)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _parse_model_entry(entry: Any) -> ModelInfo | None:
    """Normalize one model-catalog entry; malformed entries yield None."""
    if not isinstance(entry, dict):
        return None
    model_id = entry.get("id")
    if not isinstance(model_id, str) or not model_id.strip():
        return None
    name = entry.get("name")
    description = entry.get("description")
    return ModelInfo(
        id=model_id.strip(),
        name=name if isinstance(name, str) else "",
        description=description if isinstance(description, str) else None,
        context_length=_int_or_none(entry.get("context_length")),
        created=_int_or_none(entry.get("created")),
    )


__all__ = ["CHAT_COMPLETIONS_PATH", "MODELS_PATH", "OpenAICompatibleProvider"]
