"""Conversation sessions, topics, messages and rolling summaries."""

from django.apps import AppConfig


class ConversationsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "conversations"

    verbose_name = "Conversations"
