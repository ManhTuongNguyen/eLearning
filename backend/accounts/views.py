"""HTTP API for account registration and authentication."""

from rest_framework import generics
from rest_framework.permissions import AllowAny

from accounts.models import User
from accounts.serializers import RegistrationSerializer


class RegistrationView(generics.CreateAPIView):
    """Create a new user account from public registration input."""

    queryset = User.objects.all()
    serializer_class = RegistrationSerializer
    permission_classes = [AllowAny]
