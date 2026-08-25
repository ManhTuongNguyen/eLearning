"""LLM provider abstraction, OpenRouter integration, fallback and streaming."""

from django.apps import AppConfig


class LlmConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "llm"

    verbose_name = "LLM"
