"""HTTP API for account registration and authentication."""

from rest_framework import generics
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from accounts.models import User
from accounts.serializers import LoginSerializer, RegistrationSerializer


class RegistrationView(generics.CreateAPIView):
    """Create a new user account from public registration input."""

    queryset = User.objects.all()
    serializer_class = RegistrationSerializer
    permission_classes = [AllowAny]


class LoginView(TokenObtainPairView):
    """Exchange username-or-email credentials for access/refresh tokens."""

    serializer_class = LoginSerializer
    permission_classes = [AllowAny]


class RefreshView(TokenRefreshView):
    """Exchange a valid refresh token for a fresh access token."""

    permission_classes = [AllowAny]


class MeView(APIView):
    """Return the authenticated user; proof of JWT-protected endpoints."""

    def get(self, request):
        user = request.user
        return Response({"id": user.pk, "username": user.get_username(), "email": user.email})
