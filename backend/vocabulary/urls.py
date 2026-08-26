"""URL routes for the vocabulary app."""

from django.urls import path

from vocabulary import views

app_name = "vocabulary"

urlpatterns = [
    path("vocabulary/export/", views.VocabularyExportView.as_view(), name="vocabulary-export"),
    path("vocabulary/", views.VocabularySaveView.as_view(), name="vocabulary-save"),
]
