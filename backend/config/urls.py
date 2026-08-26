"""Root URL configuration for the eLearning backend."""

from django.contrib import admin
from django.urls import include, path

from config.views import health

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include("accounts.urls")),
    path("api/v1/", include("learning.urls")),
    path("api/v1/", include("llm.urls")),
    path("api/v1/", include("conversations.urls")),
    path("api/v1/", include("vocabulary.urls")),
    path("api/v1/health/", health, name="health"),
]
