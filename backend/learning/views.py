"""HTTP API for the learning profile."""

from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from learning.models import Profile
from learning.serializers import ProfileSerializer


class ProfileView(APIView):
    """Read and update the authenticated user's learning profile.

    Both methods lazily provision the profile row on first access, so a
    freshly registered user can ``GET`` their profile without any separate
    creation step; the model default (``AUTO``) applies until updated.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        profile = self._profile_for(request.user)
        return Response(ProfileSerializer(profile).data)

    def patch(self, request):
        profile = self._profile_for(request.user)
        serializer = ProfileSerializer(profile, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @staticmethod
    def _profile_for(user) -> Profile:
        profile, _ = Profile.objects.get_or_create(user=user)
        return profile
