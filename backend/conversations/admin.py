"""Admin registration for conversation models."""

from django.contrib import admin

from conversations.models import Message, Session


@admin.register(Session)
class SessionAdmin(admin.ModelAdmin):
    """Manage user conversation sessions."""

    list_display = ("user", "title", "learning_level", "created_at", "updated_at")
    list_filter = ("learning_level", "created_at", "updated_at")
    search_fields = ("user__username", "user__email", "title", "topic")
    readonly_fields = ("created_at", "updated_at")


@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    """Manage conversation messages."""

    list_display = ("session", "role", "status", "sequence", "created_at")
    list_filter = ("role", "status", "created_at")
    search_fields = ("content", "session__title", "session__user__username")
    readonly_fields = ("created_at",)
