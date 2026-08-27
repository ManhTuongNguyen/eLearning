"""HTTP API for account registration and authentication."""

from django.conf import settings
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from accounts.models import User
from accounts.serializers import (
    LoginSerializer,
    LogoutSerializer,
    RegistrationSerializer,
)


class AuthAnonRateThrottle(AnonRateThrottle):
    """Throttle anonymous identity-establishing endpoints.

    Limits are read from ``settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['auth']``
    so they can be tuned per environment without code changes. The scope name
    is the same on every auth view so a single shared bucket constrains
    register/login/refresh/logout from a given client together.

    Overrides ``get_rate`` to read the rate from settings at request time
    (not at class-definition time) so tests can patch the setting.
    """

    scope = "auth"

    def get_rate(self):
        """Read the throttle rate from Django settings at request time."""
        throttle_rates = getattr(settings, "REST_FRAMEWORK", {}).get("DEFAULT_THROTTLE_RATES", {})
        return throttle_rates.get(self.scope, "10/min")


class RegistrationView(generics.CreateAPIView):
    """Create a new user account from public registration input."""

    queryset = User.objects.all()
    serializer_class = RegistrationSerializer
    permission_classes = [AllowAny]
    throttle_classes = [AuthAnonRateThrottle]


class LoginView(TokenObtainPairView):
    """Exchange username-or-email credentials for access/refresh tokens."""

    serializer_class = LoginSerializer
    permission_classes = [AllowAny]
    throttle_classes = [AuthAnonRateThrottle]


class RefreshView(TokenRefreshView):
    """Exchange a valid refresh token for a fresh access token."""

    permission_classes = [AllowAny]
    throttle_classes = [AuthAnonRateThrottle]


class LogoutView(APIView):
    """Invalidate the supplied refresh token by adding it to the blacklist.

    Requires an authenticated request (the user must present a valid access
    token) and accepts ``{"refresh": <token>}``. The blacklisted refresh
    token can no longer be used against the refresh endpoint; outstanding
    access tokens simply expire on their configured lifetime.
    """

    throttle_classes = [AuthAnonRateThrottle]

    def post(self, request):
        serializer = LogoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.validated_data["refresh"].blacklist()
        return Response({"detail": "Logged out."}, status=status.HTTP_200_OK)


class MeView(APIView):
    """Return the authenticated user; proof of JWT-protected endpoints."""

    def get(self, request):
        user = request.user
        return Response({"id": user.pk, "username": user.get_username(), "email": user.email})
