"""API serializers for the conversations app."""

from rest_framework import serializers

from conversations.models import Session


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
