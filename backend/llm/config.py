"""Server-mode LLM/model configuration assembled from environment/settings.

This module is the single place where the OpenRouter connection parameters and
the ordered model chain (primary model first, then fallbacks) are read from
Django settings. Providers and fallback logic consume the normalized
:class:`ModelConfiguration` value instead of touching ``settings`` directly,
so business logic never hard-codes model names — every model comes from the
environment (see ``settings.py`` and ``.env.example``).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

logger = logging.getLogger("llm.config")

_MISSING = object()


@dataclass(frozen=True)
class ModelConfiguration:
    """Normalized server-mode LLM configuration.

    ``primary_model`` is tried first; ``fallback_models`` follow in configured
    order. Blank and duplicate entries never reach this point.
    """

    api_key: str
    base_url: str
    timeout_seconds: float
    primary_model: str
    fallback_models: tuple[str, ...]

    @property
    def model_chain(self) -> tuple[str, ...]:
        """Ordered attempt chain: primary model first, then fallbacks."""
        return (self.primary_model, *self.fallback_models)


def load_model_configuration() -> ModelConfiguration:
    """Build a validated :class:`ModelConfiguration` from Django settings.

    Model names are stripped; blank, duplicated, or primary-equal fallback
    entries are dropped while preserving order. Missing or invalid values
    raise :class:`~django.core.exceptions.ImproperlyConfigured` naming the
    offending setting so misconfiguration is obvious at startup.
    """
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
        api_key=str(_setting("OPENROUTER_API_KEY", default="")),
        base_url=_required_text("OPENROUTER_BASE_URL").rstrip("/"),
        timeout_seconds=_timeout_seconds(),
        primary_model=primary,
        fallback_models=tuple(fallbacks),
    )
    logger.debug(
        "model configuration loaded: primary=%s fallbacks=%d",
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


def _timeout_seconds() -> float:
    name = "LLM_REQUEST_TIMEOUT_SECONDS"
    try:
        timeout = float(str(_setting(name)))
    except (TypeError, ValueError) as exc:
        raise ImproperlyConfigured(f"{name} must be a number of seconds.") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise ImproperlyConfigured(f"{name} must be greater than zero.")
    return timeout


__all__ = ["ModelConfiguration", "load_model_configuration"]
