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
    path(
        "sessions/<int:pk>/messages/<int:message_pk>/retry/",
        views.MessageRetryView.as_view(),
        name="session-message-retry",
    ),
    path(
        "sessions/<int:pk>/messages/<int:message_pk>/suggestions/",
        views.MessageSuggestionsView.as_view(),
        name="session-message-suggestions",
    ),
    path(
        "sessions/<int:pk>/messages/<int:message_pk>/improve/",
        views.MessageImprovementView.as_view(),
        name="session-message-improve",
    ),
]
