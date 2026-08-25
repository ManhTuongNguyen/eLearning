"""URL routes for the llm app."""

from django.urls import path

from llm import views

app_name = "llm"

urlpatterns = [
    path("llm/stream/", views.LLMStreamView.as_view(), name="stream"),
]
