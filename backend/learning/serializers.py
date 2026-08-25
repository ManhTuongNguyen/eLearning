"""API serializers for the learning app."""

from rest_framework import serializers

from learning.models import Profile


class ProfileSerializer(serializers.ModelSerializer):
    """Read and update the authenticated user's English level.

    ``level`` is the only exposed field; it is generated as a choice field
    from :class:`learning.models.Level`, so anything outside the CEFR/AUTO
    set (including wrong-case or blank values) fails validation with a
    standard DRF field error.
    """

    class Meta:
        model = Profile
        fields = ["level"]
