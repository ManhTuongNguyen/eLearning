"""Admin registration for learning profile models."""

from django.contrib import admin

from learning.models import Profile


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    """Manage user learning profiles."""

    list_display = ("user", "level")
    list_filter = ("level",)
    search_fields = ("user__username", "user__email")
