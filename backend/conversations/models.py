"""Conversation session models."""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Max, Q

from learning.models import Level


class Session(models.Model):
    """Conversation session belonging to a user.

    Holds the topic, learning level, rolling summary and its boundary so the
    conversation context can be built incrementally without sending the full
    history to the LLM every time.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="conversation_sessions",
    )
    title = models.CharField(max_length=255)
    topic = models.TextField()
    topic_hint = models.TextField(blank=True, default="")
    learning_level = models.CharField(
        "Learning level",
        max_length=4,
        choices=Level.choices,
        default=Level.AUTO,
    )
    summary = models.TextField(blank=True, default="")
    summary_message_boundary = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at",)
        indexes = [
            models.Index(
                fields=("user", "-updated_at"),
                name="conv_session_user_updated",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user.username}: {self.title}"


class Message(models.Model):
    """A single chat message belonging to a conversation session.

    Assistant messages carry generation state: they are created ``pending``
    while the LLM response streams in, become ``complete`` once generation
    finishes, or ``failed`` when it aborts — only failed assistant messages
    are retryable (ROADMAP "Retry"). User messages are always ``complete``.
    """

    class Role(models.TextChoices):
        USER = "user", "User"
        ASSISTANT = "assistant", "Assistant"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending (generation in progress)"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed (retryable)"

    session = models.ForeignKey(
        Session,
        on_delete=models.CASCADE,
        related_name="messages",
    )
    role = models.CharField("Message role", max_length=16, choices=Role.choices)
    status = models.CharField(
        "Generation status",
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    content = models.TextField(
        blank=True,
        default="",
        help_text="Blank is valid only while an assistant message is pending.",
    )
    sequence = models.PositiveIntegerField()
    # Cached grammar improvement for USER messages (the "Improve my English"
    # result). Blank while never generated; the severity of a stored result
    # is "none" | "minor" | "critical". Once stored, the improvement endpoint
    # returns this cache verbatim instead of calling the LLM again — the
    # correction for one message never changes, so neither should the row.
    improvement_content = models.TextField(blank=True, default="")
    improvement_explanation = models.TextField(blank=True, default="")
    improvement_severity = models.CharField(
        blank=True,
        default="",
        max_length=16,
        choices=[
            ("none", "No issues"),
            ("minor", "Minor issues"),
            ("critical", "Critical issues"),
        ],
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("sequence",)
        indexes = [
            models.Index(
                fields=("session", "status", "sequence"),
                name="conv_msg_session_status_seq",
            ),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=("session", "sequence"),
                name="conversations_message_unique_session_sequence",
            ),
            models.CheckConstraint(
                condition=~(Q(role="user") & ~Q(status="complete")),
                name="conversations_message_user_role_complete",
            ),
        ]

    def __str__(self) -> str:
        return f"session={self.session_id} #{self.sequence} {self.role}"

    @property
    def is_retryable(self) -> bool:
        """Only failed assistant generations may be retried."""
        return self.role == self.Role.ASSISTANT and self.status == self.Status.FAILED

    def clean(self) -> None:
        super().clean()
        if self.role == self.Role.USER and self.status != self.Status.COMPLETE:
            raise ValidationError({"status": "User messages must have status 'complete'."})

    @classmethod
    def append(cls, session, *, role, content="", status=None):
        """Create the next message for ``session`` with an allocated sequence.

        User messages default to ``complete``; assistant messages default to
        ``pending`` so streaming services can transition them later.
        """
        if status is None:
            status = cls.Status.COMPLETE if role == cls.Role.USER else cls.Status.PENDING
        last = cls.objects.filter(session=session).aggregate(last_sequence=Max("sequence"))[
            "last_sequence"
        ]
        return cls.objects.create(
            session=session,
            role=role,
            content=content,
            status=status,
            sequence=(last or 0) + 1,
        )
