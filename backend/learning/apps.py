"""Learning profile: user English level (A1-C2/AUTO) and profile management."""

from django.apps import AppConfig


class LearningConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "learning"

    verbose_name = "Learning"
