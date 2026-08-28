"""Google Gemini integration behind the application-level LLMProvider interface.

This module is the only place in the backend that knows Gemini's HTTP
surface (``generateContent``, ``streamGenerateContent?alt=sse``, the
``/models`` catalog, ``x-goog-api-key`` authentication). It intentionally
does NOT reuse the OpenAI-compatible machinery: Gemini's payload shape and
paths differ genuinely, and pretending otherwise would couple two vendors
that evolve independently.

Application-level concepts map as follows: ``assistant`` messages become
Gemini ``model`` turns, ``system`` messages collapse into
``systemInstruction``, and streaming consumes Gemini's SSE framing where
chunks arrive as ``data:`` JSON lines without a ``[DONE]`` terminator. Every
failure is normalized into the :mod:`llm.exceptions` hierarchy (shared
mapping via :mod:`llm.provider_errors`) and the API key never appears in
logs, exceptions, or payloads beyond the ``x-goog-api-key`` header.
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

logger = logging.getLogger("llm.gemini")

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

_GENERATE_PATH_TEMPLATE = "/models/{model}:generateContent"
_STREAM_PATH_TEMPLATE = "/models/{model}:streamGenerateContent"
_SSE_ALT_SUFFIX = "?alt=sse"
_MODELS_PATH = "/models"
_MODEL_NAME_PREFIX = "models/"


class GeminiProvider(LLMProvider):
    """LLMProvider implementation talking to Google's Gemini REST API."""

    provider_name = "gemini"
    default_base_url = DEFAULT_BASE_URL

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
        if connect_timeout <= 0:
            raise ValueError(f"{self.provider_name} connect_timeout must be greater than zero.")
        if read_timeout <= 0:
            raise ValueError(f"{self.provider_name} read_timeout must be greater than zero.")

        self.api_key = api_key
        self.base_url = (base_url or self.default_base_url).rstrip("/")
        self.default_model = default_model
        self.connect_timeout = float(connect_timeout)
        self.read_timeout = float(read_timeout)
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
        different provider.
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

    def __enter__(self) -> GeminiProvider:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        """Run one non-streaming generateContent call."""
        model_label = request.model or self.default_model
        payload = self._build_payload(request)
        started_at = time.monotonic()
        try:
            response = self._client.post(
                _GENERATE_PATH_TEMPLATE.format(model=model_label),
                json=payload,
                headers=self._auth_headers(),
            )
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(model_label) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, model_label) from exc

        duration_ms = (time.monotonic() - started_at) * 1000
        if response.status_code != 200:
            logger.warning(
                "gemini completion failed status=%s model=%s duration_ms=%.0f",
                response.status_code,
                model_label,
                duration_ms,
            )
            raise self._http_failure(
                response.status_code,
                extract_error_message(response.text),
                model=model_label,
            )

        body = self._parse_success_json(response.text, model=model_label)
        text = self._extract_candidate_text(body, model=model_label)
        if text is None:
            raise LLMResponseError(
                "Response candidate has no text parts.",
                provider=self.provider_name,
                model=model_label,
            )

        resolved_model = (
            body.get("modelVersion") if isinstance(body.get("modelVersion"), str) else model_label
        )
        request_id = body.get("responseId")
        if not isinstance(request_id, str):
            request_id = response.headers.get("x-request-id")
        finish_reason = self._candidate_finish_reason(body)

        logger.info(
            "gemini completion succeeded model=%s request_id=%s duration_ms=%.0f chars=%d",
            resolved_model,
            request_id,
            duration_ms,
            len(text),
        )
        return CompletionResponse(
            text=text,
            model=resolved_model,
            finish_reason=finish_reason,
            request_id=request_id,
        )

    def stream(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        """Yield StreamStart followed by StreamDelta items for one completion."""
        model_label = request.model or self.default_model
        payload = self._build_payload(request)
        return self._iter_stream_events(payload, model_label=model_label)

    def _iter_stream_events(
        self, payload: dict[str, Any], *, model_label: str
    ) -> Iterator[StreamEvent]:
        effective_model = model_label
        started_at = time.monotonic()
        received_chunk = False
        try:
            with self._client.stream(
                "POST",
                _STREAM_PATH_TEMPLATE.format(model=model_label) + _SSE_ALT_SUFFIX,
                json=payload,
                headers=self._auth_headers(),
            ) as response:
                request_id = response.headers.get("x-request-id")
                if response.status_code != 200:
                    response.read()
                    logger.warning(
                        "gemini stream failed status=%s model=%s request_id=%s",
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
                        continue
                    if not line.startswith("data:"):
                        raise LLMResponseError(
                            f"Unexpected SSE line: {line[:80]!r}",
                            provider=self.provider_name,
                            model=model_label,
                        )
                    data = line[len("data:") :].strip()
                    if not data:
                        continue
                    chunk = self._parse_success_json(data, model=model_label)
                    inline_error = self._inline_error(chunk)
                    if inline_error is not None:
                        message, code = inline_error
                        if code is not None:
                            raise self._http_failure(code, message, model=effective_model)
                        raise LLMResponseError(
                            message,
                            provider=self.provider_name,
                            model=effective_model,
                        )
                    received_chunk = True
                    chunk_model = chunk.get("modelVersion")
                    if isinstance(chunk_model, str) and chunk_model:
                        effective_model = chunk_model
                    if not start_emitted:
                        yield StreamStart(model=effective_model)
                        start_emitted = True

                    piece = self._chunk_text(chunk)
                    if piece:
                        yield StreamDelta(text=piece)
                        delta_count += 1

                if not received_chunk:
                    raise LLMResponseError(
                        "Provider closed the stream without sending any events.",
                        provider=self.provider_name,
                        model=effective_model,
                    )

            logger.info(
                "gemini stream completed model=%s request_id=%s duration_ms=%.0f deltas=%d",
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
        """Retrieve the Gemini model catalog in normalized form."""
        started_at = time.monotonic()
        try:
            response = self._client.get(_MODELS_PATH, headers=self._auth_headers())
        except httpx.TimeoutException as exc:
            raise self._timeout_failure(None) from exc
        except httpx.HTTPError as exc:
            raise self._transport_failure(exc, None) from exc

        if response.status_code != 200:
            logger.warning(
                "gemini models listing failed status=%s duration_ms=%.0f",
                response.status_code,
                (time.monotonic() - started_at) * 1000,
            )
            raise self._http_failure(
                response.status_code,
                extract_error_message(response.text),
                model=None,
            )

        body = self._parse_success_json(response.text, model=None)
        entries = body.get("models")
        if not isinstance(entries, list):
            raise LLMResponseError(
                "Models response contains no models list.", provider=self.provider_name
            )

        models: list[ModelInfo] = []
        skipped = 0
        for entry in entries:
            parsed = _parse_model_entry(entry)
            if parsed is None:
                skipped += 1
                continue
            models.append(parsed)

        logger.info(
            "gemini models listed count=%d skipped=%d duration_ms=%.0f",
            len(models),
            skipped,
            (time.monotonic() - started_at) * 1000,
        )
        return tuple(models)

    def _build_payload(self, request: CompletionRequest) -> dict[str, Any]:
        contents: list[dict[str, Any]] = []
        system_parts: list[str] = []
        for message in request.messages:
            if message.role == "system":
                system_parts.append(message.content)
                continue
            role = "model" if message.role == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": message.content}]})

        payload: dict[str, Any] = {"contents": contents}
        if system_parts:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        if request.temperature is not None:
            payload["generationConfig"] = {"temperature": request.temperature}
        return payload

    def _auth_headers(self) -> dict[str, str]:
        return {
            "x-goog-api-key": self.api_key,
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

    def _candidate_finish_reason(self, body: dict[str, Any]) -> str | None:
        candidates = body.get("candidates")
        if isinstance(candidates, list) and candidates and isinstance(candidates[0], dict):
            finish_reason = candidates[0].get("finishReason")
            if isinstance(finish_reason, str):
                return finish_reason
        return None

    def _extract_candidate_text(self, body: dict[str, Any], *, model: str) -> str | None:
        candidates = body.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            return None
        candidate = candidates[0]
        if not isinstance(candidate, dict):
            return None
        content = candidate.get("content")
        if not isinstance(content, dict):
            return None
        parts = content.get("parts")
        if not isinstance(parts, list):
            return None
        pieces = [
            part["text"]
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        ]
        if not pieces:
            return None
        return "".join(pieces)

    def _chunk_text(self, chunk: dict[str, Any]) -> str:
        candidates = chunk.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            return ""
        candidate = candidates[0]
        if not isinstance(candidate, dict):
            return ""
        content = candidate.get("content")
        if not isinstance(content, dict):
            return ""
        parts = content.get("parts")
        if not isinstance(parts, list):
            return ""
        return "".join(
            part["text"]
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )

    def _inline_error(self, chunk: dict[str, Any]) -> tuple[str, int | None] | None:
        """Return ``(message, status_code)`` for an inline error chunk, or None."""
        error = chunk.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            code = error.get("code")
            if isinstance(code, int) and not isinstance(code, bool):
                return error["message"], code
            return error["message"], None
        return None

    def _http_failure(self, status_code: int, message: str, *, model: str | None) -> LLMError:
        return normalize_http_failure(self.provider_name, status_code, message, model=model)

    def _timeout_failure(self, model: str | None) -> LLMError:
        logger.warning(
            "gemini request timed out model=%s connect_timeout=%.0fs read_timeout=%.0fs",
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
        logger.warning("gemini transport failure model=%s error=%s", model, type(exc).__name__)
        return transport_failure(self.provider_name, exc, model=model)


def _int_or_none(value: Any) -> int | None:
    """Pass through genuine ints only (bool is an int subclass but never valid here)."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _parse_model_entry(entry: Any) -> ModelInfo | None:
    """Normalize one Gemini model-catalog entry; malformed entries yield None."""
    if not isinstance(entry, dict):
        return None
    raw_name = entry.get("name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        return None
    model_id = raw_name.strip()
    if model_id.startswith(_MODEL_NAME_PREFIX):
        model_id = model_id[len(_MODEL_NAME_PREFIX) :]
    if not model_id:
        return None
    display_name = entry.get("displayName")
    description = entry.get("description")
    return ModelInfo(
        id=model_id,
        name=display_name if isinstance(display_name, str) else "",
        description=description if isinstance(description, str) else None,
        context_length=_int_or_none(entry.get("inputTokenLimit")),
        created=None,
    )


__all__ = ["DEFAULT_BASE_URL", "GeminiProvider"]
