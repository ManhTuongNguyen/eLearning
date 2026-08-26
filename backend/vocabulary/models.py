"""Vocabulary models: saved expressions and asynchronous enrichment."""

from django.conf import settings
from django.db import models


class VocabularyItem(models.Model):
    """A word or phrase the learner saved from a conversation.

    Saving is immediate (ROADMAP "Vocabulary"): the item is created in
    ``pending`` status with only the expression and its source filled in;
    enrichment (definition, translation, pronunciation, part of speech,
    example) happens asynchronously via Celery (TASK-068) and transitions
    the status to ``complete`` — or ``failed`` so it can be retried.
    ``expression`` keeps the user's selection verbatim while
    ``normalized_expression`` is the trimmed/lowercase dedupe key.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending (enrichment not yet done)"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed (enrichment retryable)"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="vocabulary_items",
    )
    expression = models.TextField(
        help_text="The saved word or phrase exactly as selected.",
    )
    normalized_expression = models.TextField(
        help_text="Trimmed lowercase form of the expression for duplicate handling.",
    )
    definition = models.TextField(blank=True, default="")
    translation = models.TextField(blank=True, default="")
    pronunciation = models.CharField(max_length=255, blank=True, default="")
    part_of_speech = models.CharField(max_length=64, blank=True, default="")
    example = models.TextField(blank=True, default="")
    source_message = models.ForeignKey(
        "conversations.Message",
        on_delete=models.SET_NULL,
        related_name="vocabulary_items",
        null=True,
        blank=True,
    )
    source_session = models.ForeignKey(
        "conversations.Session",
        on_delete=models.SET_NULL,
        related_name="vocabulary_items",
        null=True,
        blank=True,
    )
    status = models.CharField(
        "Enrichment status",
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        indexes = [
            models.Index(
                fields=("user", "normalized_expression"),
                name="vocabulary_user_normalized_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user.username}: {self.expression}"

    @property
    def is_pending(self) -> bool:
        """True while enrichment has not produced a result yet."""
        return self.status == self.Status.PENDING

    @property
    def is_enriched(self) -> bool:
        """True once enrichment succeeded."""
        return self.status == self.Status.COMPLETE
