"""API serializers for the accounts app."""

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from accounts.models import User


class RegistrationSerializer(serializers.ModelSerializer):
    """Validate registration input and create a user with hashed credentials.

    The password is accepted write-only: it drives validation and account
    creation but never appears in serialized output. Django's configured
    ``AUTH_PASSWORD_VALIDATORS`` run against the password together with a
    candidate user built from the submitted username/email so similarity
    checks apply before anything touches the database.
    """

    password = serializers.CharField(write_only=True, trim_whitespace=False)

    class Meta:
        model = User
        fields = ["id", "username", "email", "password"]

    def validate(self, attrs):
        candidate = User(username=attrs.get("username", ""), email=attrs.get("email", ""))
        try:
            validate_password(attrs["password"], user=candidate)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"password": exc.messages}) from exc
        return attrs

    def create(self, validated_data):
        # create_user hashes the password and normalizes the email domain.
        return User.objects.create_user(**validated_data)
