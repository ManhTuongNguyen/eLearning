"""URL routes for the accounts app."""

from django.urls import path

from accounts import views

app_name = "accounts"

urlpatterns = [
    path("auth/register/", views.RegistrationView.as_view(), name="register"),
    path("auth/login/", views.LoginView.as_view(), name="login"),
    path("auth/refresh/", views.RefreshView.as_view(), name="refresh"),
    path("auth/me/", views.MeView.as_view(), name="me"),
]
