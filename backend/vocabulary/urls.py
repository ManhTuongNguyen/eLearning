"""URL routes for the vocabulary app."""

from django.urls import path

from vocabulary import views

app_name = "vocabulary"

urlpatterns = [
    path("vocabulary/", views.VocabularySaveView.as_view(), name="vocabulary-save"),
]
