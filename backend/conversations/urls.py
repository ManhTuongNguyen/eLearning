"""URL routes for the conversations app."""

from django.urls import path

from conversations import views

app_name = "conversations"

urlpatterns = [
    path("sessions/", views.SessionCollectionView.as_view(), name="sessions"),
    path("sessions/<int:pk>/", views.SessionDetailView.as_view(), name="session-detail"),
    path(
        "sessions/<int:pk>/messages/",
        views.MessageListView.as_view(),
        name="session-messages",
    ),
    path(
        "sessions/<int:pk>/messages/stream/",
        views.MessageStreamView.as_view(),
        name="session-message-stream",
    ),
]
