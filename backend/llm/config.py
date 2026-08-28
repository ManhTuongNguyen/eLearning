"""Server-mode LLM/model configuration assembled from environment/settings.

This module is the single place where the configured provider, its connection
parameters (API key and base URL resolved through :mod:`llm.provider_specs`)
and the ordered model chain (primary model first, then fallbacks) are read
from Django settings. Providers, the registry, and fallback logic consume the
normalized :class:`ModelConfiguration` value instead of touching ``settings``
directly, so business logic never hard-codes model names or vendor endpoints
— every one of them comes from the environment (see ``settings.py`` and
``.env.example``).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import httpx
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from llm.provider_specs import DEFAULT_PROVIDER_NAME, get_provider_spec

logger = logging.getLogger("llm.config")

_MISSING = object()


@dataclass(frozen=True)
class ModelConfiguration:
    """Normalized server-mode LLM configuration.

    ``provider`` selects the concrete integration (see :mod:`llm.registry`).
    ``primary_model`` is tried first; ``fallback_models`` follow in configured
    order. Blank and duplicate entries never reach this point.
    """

    provider: str
    api_key: str
    base_url: str
    timeout_seconds: float
    connect_timeout_seconds: float
    read_timeout_seconds: float
    primary_model: str
    fallback_models: tuple[str, ...]

    @property
    def model_chain(self) -> tuple[str, ...]:
        """Ordered attempt chain: primary model first, then fallbacks."""
        return (self.primary_model, *self.fallback_models)

    @property
    def httpx_timeout(self) -> httpx.Timeout:
        """Return an httpx.Timeout configured with separate connect/read timeouts."""
        return httpx.Timeout(
            connect=self.connect_timeout_seconds,
            read=self.read_timeout_seconds,
            write=self.connect_timeout_seconds,
            pool=self.connect_timeout_seconds,
        )


def load_model_configuration() -> ModelConfiguration:
    """Build a validated :class:`ModelConfiguration` from Django settings.

    The provider is selected by ``LLM_PROVIDER`` (default ``openrouter``); the
    API key and base URL are resolved through that provider's dedicated
    settings (``<PREFIX>_API_KEY`` / ``<PREFIX>_BASE_URL``). Model names are
    stripped; blank, duplicated, or primary-equal fallback entries are dropped
    while preserving order. Missing or invalid values raise
    :class:`~django.core.exceptions.ImproperlyConfigured` naming the offending
    setting so misconfiguration is obvious at startup.
    """
    raw_provider = str(_setting("LLM_PROVIDER", default=DEFAULT_PROVIDER_NAME))
    spec = get_provider_spec(raw_provider)

    primary = _clean_model(_setting("LLM_PRIMARY_MODEL"))
    if not primary:
        raise ImproperlyConfigured("LLM_PRIMARY_MODEL must be set to a non-blank model name.")

    fallbacks: list[str] = []
    for raw in _setting("LLM_FALLBACK_MODELS", default=()):
        model = _clean_model(raw)
        if not model or model == primary or model in fallbacks:
            continue
        fallbacks.append(model)

    configuration = ModelConfiguration(
        provider=spec.name,
        api_key=str(_setting(spec.api_key_setting, default="")),
        base_url=_required_text(spec.base_url_setting).rstrip("/"),
        timeout_seconds=_timeout_seconds("LLM_REQUEST_TIMEOUT_SECONDS", 60.0),
        connect_timeout_seconds=_timeout_seconds("LLM_CONNECT_TIMEOUT_SECONDS", 10.0),
        read_timeout_seconds=_timeout_seconds("LLM_READ_TIMEOUT_SECONDS", 60.0),
        primary_model=primary,
        fallback_models=tuple(fallbacks),
    )
    logger.debug(
        "model configuration loaded: provider=%s primary=%s fallbacks=%d",
        configuration.provider,
        configuration.primary_model,
        len(configuration.fallback_models),
    )
    return configuration


def _setting(name: str, default: object = _MISSING) -> object:
    value = getattr(settings, name, _MISSING)
    if value is _MISSING:
        if default is _MISSING:
            raise ImproperlyConfigured(f"{name} is not configured in Django settings.")
        return default
    return value


def _required_text(name: str) -> str:
    value = str(_setting(name, default="")).strip()
    if not value:
        raise ImproperlyConfigured(f"{name} must be set to a non-blank value.")
    return value


def _clean_model(raw: object) -> str:
    return str(raw).strip() if raw is not None else ""


def _timeout_seconds(name: str, default: float) -> float:
    try:
        timeout = float(str(_setting(name, default=default)))
    except (TypeError, ValueError) as exc:
        raise ImproperlyConfigured(f"{name} must be a number of seconds.") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise ImproperlyConfigured(f"{name} must be greater than zero.")
    return timeout


__all__ = ["ModelConfiguration", "load_model_configuration"]
