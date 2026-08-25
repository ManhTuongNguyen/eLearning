"""Conversation session models."""

from django.conf import settings
from django.db import models

from learning.models import Level


class Session(models.Model):
    """Conversation session belonging to a user.

    Holds the topic, learning level, rolling summary and its boundary so the
    conversation context can be built incrementally without sending the full
    history to the LLM every time.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversation_sessions",
    )
    title = models.CharField(max_length=255)
    topic = models.TextField()
    topic_hint = models.TextField(blank=True, default="")
    learning_level = models.CharField(
        "Learning level",
        max_length=4,
        choices=Level.choices,
        default=Level.AUTO,
    )
    summary = models.TextField(blank=True, default="")
    summary_message_boundary = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at",)

    def __str__(self) -> str:
        return f"{self.user.username}: {self.title}"
