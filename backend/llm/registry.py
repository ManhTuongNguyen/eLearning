"""Provider registry: builds concrete LLMProvider instances from configuration.

This is the seam that decouples conversation features from any specific
vendor. Application services receive whatever :class:`LLMProvider` the
registry assembles; selecting a provider is a configuration change
(``LLM_PROVIDER``), never a code change.

Two shapes of integrations exist:

- OpenAI-compatible providers (OpenRouter, OpenAI, 9Router, and generic
  compatible deployments) share one implementation
  (:mod:`llm.openai_compatible`) because their wire contract is genuinely
  the same; each registers as a thin subclass.
- Providers with genuinely different API surfaces (Gemini) implement
  :class:`llm.provider.LLMProvider` directly in their own module.

Every registered factory receives the same normalized
:class:`llm.config.ModelConfiguration`-derived keyword arguments, so new
providers plug in without touching conversation logic.
"""

from __future__ import annotations

import logging

from llm.config import ModelConfiguration, load_model_configuration
from llm.gemini import GeminiProvider
from llm.ninerouter import NineRouterProvider
from llm.openai import OpenAIProvider
from llm.openai_compatible import OpenAICompatibleProvider
from llm.openrouter import OpenRouterProvider
from llm.provider import LLMProvider
from llm.provider_specs import get_provider_spec

logger = logging.getLogger("llm.registry")

PROVIDER_FACTORIES: dict[str, type[LLMProvider]] = {
    "openrouter": OpenRouterProvider,
    "gemini": GeminiProvider,
    "openai": OpenAIProvider,
    "ninerouter": NineRouterProvider,
    "openai-compatible": OpenAICompatibleProvider,
}


def build_provider(config: ModelConfiguration) -> LLMProvider:
    """Instantiate the provider selected by ``config.provider``.

    Every provider receives the same normalized connection parameters
    (API key, base URL, primary model, timeouts), so provider selection
    never leaks into calling code.
    """
    spec = get_provider_spec(config.provider)
    factory = PROVIDER_FACTORIES[spec.name]
    logger.debug("building provider=%s base_url_setting=%s", spec.name, spec.base_url_setting)
    return factory(
        api_key=config.api_key,
        base_url=config.base_url,
        default_model=config.primary_model,
        connect_timeout=config.connect_timeout_seconds,
        read_timeout=config.read_timeout_seconds,
    )


def build_provider_from_settings() -> LLMProvider:
    """Load the settings-driven configuration and build its provider."""
    return build_provider(load_model_configuration())


def available_provider_names() -> tuple[str, ...]:
    """All provider ids that can be selected via ``LLM_PROVIDER``."""
    return tuple(sorted(PROVIDER_FACTORIES))


__all__ = [
    "PROVIDER_FACTORIES",
    "available_provider_names",
    "build_provider",
    "build_provider_from_settings",
]
