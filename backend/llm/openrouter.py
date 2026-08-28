"""OpenRouter integration behind the application-level LLMProvider interface.

OpenRouter exposes the standard OpenAI chat-completions contract, so the
provider is a thin :class:`llm.openai_compatible.OpenAICompatibleProvider`
subclass supplying only its identity and endpoint. All HTTP mechanics
(streaming, error normalization, model catalog) live in the shared
OpenAI-compatible implementation — this module is deliberately free of
vendor-specific behavior beyond its URL.
"""

from __future__ import annotations

from llm.openai_compatible import (
    CHAT_COMPLETIONS_PATH,
    MODELS_PATH,
    OpenAICompatibleProvider,
)
from llm.provider_errors import MAX_ERROR_SNIPPET_LENGTH

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterProvider(OpenAICompatibleProvider):
    """LLMProvider implementation talking to the OpenRouter chat API."""

    provider_name = "openrouter"
    default_base_url = DEFAULT_BASE_URL


__all__ = [
    "CHAT_COMPLETIONS_PATH",
    "DEFAULT_BASE_URL",
    "MAX_ERROR_SNIPPET_LENGTH",
    "MODELS_PATH",
    "OpenRouterProvider",
]
