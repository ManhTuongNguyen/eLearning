"""URL routes for the conversations app."""

from django.urls import path

from conversations import views

app_name = "conversations"

urlpatterns = [
    path("sessions/", views.SessionCollectionView.as_view(), name="sessions"),
]
