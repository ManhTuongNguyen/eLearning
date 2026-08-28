"""OpenAI integration behind the application-level LLMProvider interface.

OpenAI's own API follows the same chat-completions contract as every other
OpenAI-compatible vendor, so this provider only supplies its identity and
default endpoint on top of the shared OpenAI-compatible implementation.
"""

from __future__ import annotations

from llm.openai_compatible import OpenAICompatibleProvider

DEFAULT_BASE_URL = "https://api.openai.com/v1"


class OpenAIProvider(OpenAICompatibleProvider):
    """LLMProvider implementation talking to the OpenAI chat API."""

    provider_name = "openai"
    default_base_url = DEFAULT_BASE_URL


__all__ = ["DEFAULT_BASE_URL", "OpenAIProvider"]
