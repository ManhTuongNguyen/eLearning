"""API serializers for the conversations app."""

from rest_framework import serializers

from conversations.models import Message, Session


class SessionCreateSerializer(serializers.Serializer):
    """Validates the POST body for creating a conversation session.

    ``topic_hint`` is optional; blank and whitespace-only values normalize to
    the empty string, which makes topic generation behave as "let AI choose".
    Unknown fields are ignored.
    """

    topic_hint = serializers.CharField(required=False, allow_blank=True)

    def validate_topic_hint(self, value: str) -> str:
        return value.strip()

    def to_hint(self) -> str:
        return self.validated_data.get("topic_hint", "")


class SessionSerializer(serializers.ModelSerializer):
    """Read representation of a conversation session."""

    class Meta:
        model = Session
        fields = ["id", "title", "topic", "topic_hint", "learning_level", "created_at"]


class SessionRenameSerializer(serializers.ModelSerializer):
    """Validates PATCH bodies for renaming a session.

    Only ``title`` is declared, so every other session field is immutable
    through this endpoint regardless of what the client sends. The title is
    required and may not be blank after surrounding whitespace is stripped.
    """

    class Meta:
        model = Session
        fields = ["title"]

    def validate_title(self, value: str) -> str:
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Title cannot be blank.")
        return value


class MessageSerializer(serializers.ModelSerializer):
    """Read representation of a chat message."""

    class Meta:
        model = Message
        fields = ["id", "role", "status", "content", "sequence", "created_at"]
