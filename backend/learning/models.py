"""Learning profile models."""

from django.conf import settings
from django.db import models


class Level(models.TextChoices):
    """CEFR English levels plus AUTO for LLM-inferred difficulty."""

    A1 = "A1", "A1 — Beginner"
    A2 = "A2", "A2 — Elementary"
    B1 = "B1", "B1 — Intermediate"
    B2 = "B2", "B2 — Upper Intermediate"
    C1 = "C1", "C1 — Advanced"
    C2 = "C2", "C2 — Proficiency"
    AUTO = "AUTO", "Auto (let AI decide)"


class Profile(models.Model):
    """Per-user learning profile holding their English level.

    One-to-one with :class:`accounts.models.User`; ``AUTO`` (the default)
    lets the AI infer an appropriate level instead of forcing the user to
    self-assess during onboarding.
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="learning_profile",
    )
    level = models.CharField(
        "English level",
        max_length=4,
        choices=Level.choices,
        default=Level.AUTO,
    )

    def __str__(self) -> str:
        return f"{self.user.username}: {self.level}"
