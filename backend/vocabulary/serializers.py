"""API serializers for the vocabulary app."""

from rest_framework import serializers

from vocabulary.models import VocabularyItem


class VocabularySaveSerializer(serializers.Serializer):
    """Validates the POST body of the vocabulary save endpoint.

    ``expression`` is required and may not be blank after surrounding
    whitespace is stripped; it is stored verbatim (words and phrases, no
    length cap — TASK-065). ``source_message_id`` is optional; when present
    it must be a positive integer so malformed ids are rejected with a 400
    before any lookup happens.
    """

    expression = serializers.CharField()
    source_message_id = serializers.IntegerField(required=False, min_value=1)

    def validate_expression(self, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise serializers.ValidationError("expression must not be empty.")
        return stripped


class VocabularyItemSerializer(serializers.ModelSerializer):
    """Read representation of a saved vocabulary item."""

    class Meta:
        model = VocabularyItem
        fields = [
            "id",
            "expression",
            "normalized_expression",
            "definition",
            "translation",
            "pronunciation",
            "part_of_speech",
            "example",
            "status",
            "source_message",
            "source_session",
            "created_at",
        ]
