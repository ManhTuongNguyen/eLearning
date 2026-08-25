"""Saved words/phrases, asynchronous enrichment and Anki-compatible export."""

from django.apps import AppConfig


class VocabularyConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "vocabulary"

    verbose_name = "Vocabulary"
