"""API serializers for the accounts app."""

from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.tokens import RefreshToken

from accounts.models import User


class LoginSerializer(TokenObtainPairSerializer):
    """Validate login input and issue access/refresh tokens.

    The user model keeps ``username`` as USERNAME_FIELD, but the roadmap
    requires email-or-username login. Authentication is attempted with the
    submitted identifier directly; when it looks like an email address and
    did not match a username, the account is resolved by email (case
    insensitively, matching the normalized storage) and retried by its
    username. Failure modes are indistinguishable to the caller.
    """

    default_error_messages = {
        "no_active_account": "No active account found with the given credentials."
    }

    def validate(self, attrs):
        request = self.context.get("request")
        identifier = attrs.get(self.username_field, "")
        password = attrs.get("password", "")

        user = authenticate(request=request, username=identifier, password=password)
        if user is None and "@" in identifier:
            matched = User.objects.filter(email__iexact=identifier).first()
            if matched is not None:
                user = authenticate(
                    request=request,
                    username=matched.get_username(),
                    password=password,
                )

        if user is None:
            # InvalidToken (not ValidationError) so failures are HTTP 401.
            raise InvalidToken(self.error_messages["no_active_account"])

        refresh = RefreshToken.for_user(user)

        return {
            "refresh": str(refresh),
            "access": str(refresh.access_token),
            "user": {"id": user.pk, "username": user.get_username(), "email": user.email},
        }


class LogoutSerializer(serializers.Serializer):
    """Validate the refresh token submitted for invalidation at logout.

    The token must parse as a well-formed, non-expired, non-blacklisted
    refresh token; anything else is reported as a field error so the client
    gets a predictable 400 instead of an unhandled server error. Parsing
    here is input validation only — the actual blacklisting happens in the
    view once the payload is trusted.
    """

    refresh = serializers.CharField(write_only=True)

    def validate(self, attrs):
        try:
            attrs["refresh"] = RefreshToken(attrs["refresh"])
        except TokenError as exc:
            raise serializers.ValidationError({"refresh": "Invalid or expired token."}) from exc
        return attrs


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
