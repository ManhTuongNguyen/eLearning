"""Static provider registry metadata.

This module maps each supported provider id to the Django settings that
configure it (API key and base URL) plus its default endpoint. It is pure
data — no provider classes, no HTTP, no model names — so both
:mod:`llm.config` and ``config.settings`` can import it safely before the
app registry is loaded.

Adding a new provider means adding a spec here, a provider class in
:mod:`llm.registry`'s factory table, and the matching environment entries in
``settings.py`` / ``.env.example``.
"""

from __future__ import annotations

from dataclasses import dataclass

from django.core.exceptions import ImproperlyConfigured


@dataclass(frozen=True)
class ProviderSpec:
    """Configuration metadata for one supported LLM provider.

    ``settings_prefix`` is the upper-case environment prefix: the API key is
    read from ``<PREFIX>_API_KEY`` and the endpoint from ``<PREFIX>_BASE_URL``.
    ``default_base_url`` is used when the base-URL setting is absent from
    Django settings; ``None`` means the URL must be configured explicitly.
    """

    name: str
    label: str
    settings_prefix: str
    default_base_url: str | None

    @property
    def api_key_setting(self) -> str:
        return f"{self.settings_prefix}_API_KEY"

    @property
    def base_url_setting(self) -> str:
        return f"{self.settings_prefix}_BASE_URL"


PROVIDER_SPECS: dict[str, ProviderSpec] = {
    spec.name: spec
    for spec in (
        ProviderSpec(
            name="openrouter",
            label="OpenRouter",
            settings_prefix="OPENROUTER",
            default_base_url="https://openrouter.ai/api/v1",
        ),
        ProviderSpec(
            name="gemini",
            label="Google Gemini",
            settings_prefix="GEMINI",
            default_base_url="https://generativelanguage.googleapis.com/v1beta",
        ),
        ProviderSpec(
            name="openai",
            label="OpenAI",
            settings_prefix="OPENAI",
            default_base_url="https://api.openai.com/v1",
        ),
        ProviderSpec(
            name="ninerouter",
            label="9Router",
            settings_prefix="NINEROUTER",
            default_base_url="http://localhost:20128/v1",
        ),
        ProviderSpec(
            name="openai-compatible",
            label="OpenAI-compatible provider",
            settings_prefix="OPENAI_COMPATIBLE",
            default_base_url=None,
        ),
    )
}

DEFAULT_PROVIDER_NAME = "openrouter"


def get_provider_spec(name: str) -> ProviderSpec:
    """Return the spec for ``name`` or raise :class:`ImproperlyConfigured`.

    Unknown (or blank) provider names always name the ``LLM_PROVIDER``
    setting so misconfiguration is obvious at startup.
    """
    normalized = name.strip().lower()
    spec = PROVIDER_SPECS.get(normalized)
    if spec is None:
        supported = ", ".join(sorted(PROVIDER_SPECS))
        raise ImproperlyConfigured(
            f"LLM_PROVIDER {name!r} is not a supported provider. Supported providers: {supported}."
        )
    return spec


__all__ = [
    "DEFAULT_PROVIDER_NAME",
    "PROVIDER_SPECS",
    "ProviderSpec",
    "get_provider_spec",
]
