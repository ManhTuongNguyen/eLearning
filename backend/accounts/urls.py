"""URL routes for the accounts app."""

from django.urls import path

from accounts import views

app_name = "accounts"

urlpatterns = [
    path("auth/register/", views.RegistrationView.as_view(), name="register"),
]
