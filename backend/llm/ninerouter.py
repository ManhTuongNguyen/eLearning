"""9Router integration behind the application-level LLMProvider interface.

9Router is an OpenAI-compatible gateway: it exposes the standard
``/chat/completions`` contract on a local (or remotely deployed) router
endpoint, so this provider only supplies its identity and default endpoint
on top of the shared OpenAI-compatible implementation. Deployments that run
the router elsewhere override the endpoint via ``NINEROUTER_BASE_URL``.
"""

from __future__ import annotations

from llm.openai_compatible import OpenAICompatibleProvider

DEFAULT_BASE_URL = "http://localhost:20128/v1"


class NineRouterProvider(OpenAICompatibleProvider):
    """LLMProvider implementation talking to a 9Router chat API endpoint."""

    provider_name = "ninerouter"
    default_base_url = DEFAULT_BASE_URL


__all__ = ["DEFAULT_BASE_URL", "NineRouterProvider"]
