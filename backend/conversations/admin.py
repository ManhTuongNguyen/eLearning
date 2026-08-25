"""Admin registration for conversation models."""

from django.contrib import admin

from conversations.models import Session


@admin.register(Session)
class SessionAdmin(admin.ModelAdmin):
    """Manage user conversation sessions."""

    list_display = ("user", "title", "learning_level", "created_at", "updated_at")
    list_filter = ("learning_level", "created_at", "updated_at")
    search_fields = ("user__username", "user__email", "title", "topic")
    readonly_fields = ("created_at", "updated_at")
