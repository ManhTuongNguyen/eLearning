"""URL routes for the learning app."""

from django.urls import path

from learning import views

app_name = "learning"

urlpatterns = [
    path("profile/", views.ProfileView.as_view(), name="profile"),
]
