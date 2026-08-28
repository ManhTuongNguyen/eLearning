"""Complete server-mode user journey validation (TASK-116).

Walks the full server-mode journey from SPEC Phase 20 through the real HTTP
API surface only, with OpenRouter faked at the provider boundary (SPEC
Rule 4 / ROADMAP §18) — every persisted state change comes from the real
application services, serializers and models:

    Register → Login → Choose level → New conversation
    → Generate topic (and sample) → Chat → Stream response
    → History → Rename → Suggest replies → Improve message
    → Save vocabulary → Enrich vocabulary → Export CSV
    → TTS (device-local: no backend involvement) → Delete conversation

Acceptance criterion (SPEC TASK-116): the full journey works without manual
database manipulation — no step reaches around the API to create or mutate
state.
"""

from __future__ import annotations

import csv
import io
import json
from collections import deque
from collections.abc import Iterator

import pytest
from django.urls import get_resolver, reverse
from rest_framework.test import APIClient

import conversations.views as conversations_views
import llm.views as llm_views
from conversations import tasks as conversation_tasks
from conversations.improvement import ImprovementService
from conversations.suggestions import SuggestionService
from conversations.topics import TopicGenerationService
from llm.fallback import FallbackProvider
from llm.provider import LLMProvider
from llm.streaming import StreamingCompletionService
from llm.types import (
    CompletionRequest,
    CompletionResponse,
    StreamDelta,
    StreamEvent,
    StreamStart,
)
from vocabulary import tasks as vocab_tasks
from vocabulary.models import VocabularyItem
from vocabulary.tasks import enrich_vocabulary_item

pytestmark = pytest.mark.django_db

REGISTER_URL = reverse("accounts:register")
LOGIN_URL = reverse("accounts:login")
PROFILE_URL = reverse("learning:profile")
SESSIONS_URL = reverse("conversations:sessions")
SAVE_URL = reverse("vocabulary:vocabulary-save")
EXPORT_URL = reverse("vocabulary:vocabulary-export")

PASSWORD = "pw-123456"
LEARNER = "frida"
MODEL = "openrouter/fake-primary"

TOPIC_PAYLOAD = {
    "title": "Ordering coffee abroad",
    "description": "Role-play buying coffee in a busy cafe and practise polite requests.",
}
SAMPLE_PAYLOAD = {
    "turns": [
        {"role": "assistant", "content": "Good morning! What can I get you today?"},
        {"role": "user", "content": "Hi! Could I have a latte, please?"},
        {"role": "assistant", "content": "Coming right up. Would you like anything else?"},
        {"role": "user", "content": "That is all, thank you!"},
    ]
}
REPLIES_PAYLOAD = {
    "replies": [
        "Could I get a flat white, please?",
        "What do you recommend here?",
        "Is it okay if I pay by card?",
    ]
}
IMPROVED_TEXT = "Could you help me order a coffee, please?"
IMPROVEMENT_PAYLOAD = {
    "improved": IMPROVED_TEXT,
    "explanation": "Polite requests usually add 'please' at the end.",
}
ENRICHMENT_PAYLOAD = {
    "definition": "a coffee made with steamed milk",
    "translation": "café con leche",
    "pronunciation": "/ˈlæt.eɪ/",
    "part_of_speech": "noun",
    "example": "I ordered a latte at the cafe.",
}

USER_TEXT = "Could you help me order a coffee?"
ASSISTANT_TEXT = "Of course! What kind of coffee would you like?"
RENAME_TITLE = "Coffee shop role-play"
EXPRESSION = "latte"


class ScriptedProvider(LLMProvider):
    """One scripted OpenRouter stand-in serving the whole journey.

    Records every completion and stream request so the journey can assert
    the real services composed their prompts correctly, and pops one
    scripted completion outcome per ``complete()`` call in journey order.
    """

    def __init__(self) -> None:
        self.completions: deque[CompletionResponse | Exception] = deque()
        self.stream_script: object = ()
        self.complete_requests: list[CompletionRequest] = []
        self.stream_requests: list[CompletionRequest] = []

    def queue(self, outcome: CompletionResponse | Exception) -> None:
        self.completions.append(outcome)

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.complete_requests.append(request)
        outcome = self.completions.popleft()
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def stream(self, request: CompletionRequest) -> Iterator[StreamEvent]:
        self.stream_requests.append(request)
        if isinstance(self.stream_script, Exception):
            raise self.stream_script
        yield from self.stream_script


def completion(payload: dict) -> CompletionResponse:
    """Build a fake provider completion carrying one JSON payload."""
    return CompletionResponse(text=json.dumps(payload), model=MODEL)


class EagerEnrichmentTask:
    """Runs the real enrichment task inline whenever the scheduler delays it."""

    def __init__(self) -> None:
        self.enqueued: list[int] = []

    def delay(self, vocabulary_id: int) -> None:
        self.enqueued.append(vocabulary_id)
        enrich_vocabulary_item.apply(args=[vocabulary_id])


class RecordingTask:
    """Records ``.delay()`` calls; stands in for broker-bound Celery tasks."""

    def __init__(self) -> None:
        self.enqueued: list[tuple] = []

    def delay(self, *args) -> None:
        self.enqueued.append(args)


def flush_on_commit_callbacks() -> int:
    """Drain pending on-commit hooks to completion; return how many ran.

    Django 6 removed captureOnCommitCallbacks and pytest-django never
    commits, so hooks are drained manually — entries are ``(sids, func,
    robust)`` tuples. Hooks may register follow-up hooks (e.g. the summary
    scheduler), so draining repeats until nothing is left pending. Draining
    stands in for the transaction committing.
    """
    from django.db import connection

    ran = 0
    while connection.run_on_commit:
        pending, connection.run_on_commit = connection.run_on_commit, []
        for _sids, func, _robust in pending:
            func()
            ran += 1
    return ran


@pytest.fixture
def api() -> APIClient:
    return APIClient()


@pytest.fixture
def provider(monkeypatch) -> ScriptedProvider:
    """One fake OpenRouter wired into every journey service seam.

    Session creation runs the real TopicGenerationService, chat/retry the
    real StreamingCompletionService, suggestions the real SuggestionService,
    improvement the real ImprovementService and vocabulary enrichment the
    real task behind the real post-commit scheduler — all on top of this
    scripted provider.
    """
    fake = ScriptedProvider()
    monkeypatch.setattr(
        conversations_views,
        "get_topic_service",
        lambda: TopicGenerationService(provider=FallbackProvider(provider=fake, models=(MODEL,))),
    )
    monkeypatch.setattr(
        conversations_views,
        "get_suggestion_service",
        lambda: SuggestionService(provider=FallbackProvider(provider=fake, models=(MODEL,))),
    )
    monkeypatch.setattr(
        conversations_views,
        "get_improvement_service",
        lambda: ImprovementService(provider=FallbackProvider(provider=fake, models=(MODEL,))),
    )
    monkeypatch.setattr(
        llm_views,
        "get_streaming_service",
        lambda: StreamingCompletionService(
            provider=FallbackProvider(provider=fake, models=(MODEL,))
        ),
    )
    monkeypatch.setattr(vocab_tasks, "get_enrichment_provider", lambda: fake)
    return fake


@pytest.fixture
def eager(monkeypatch) -> EagerEnrichmentTask:
    """Eager stand-in for the registered task behind the real scheduler."""
    task = EagerEnrichmentTask()
    monkeypatch.setattr(vocab_tasks, "enrich_vocabulary_item", task)
    return task


@pytest.fixture
def summary_updates(monkeypatch) -> RecordingTask:
    """Record summary-update scheduling instead of hitting the broker."""
    recorded = RecordingTask()
    monkeypatch.setattr(conversation_tasks, "update_session_summary", recorded)
    return recorded


def all_url_patterns() -> list[str]:
    """Every concrete URL pattern in the backend route table."""

    def walk(patterns) -> Iterator[str]:
        for pattern in patterns:
            if hasattr(pattern, "url_patterns"):
                yield from walk(pattern.url_patterns)
            else:
                yield str(pattern.pattern)

    return list(walk(get_resolver().url_patterns))


def read_frames(response) -> list[tuple[str, dict]]:
    """Parse one SSE response into (event, data) frames."""
    frames = []
    for chunk in response.streaming_content:
        lines = [line for line in chunk.decode("utf-8").split("\n") if line != ""]
        assert len(lines) == 2, f"frame must be one event line + one data line: {chunk!r}"
        event_line, data_line = lines
        assert event_line.startswith("event: "), chunk
        assert data_line.startswith("data: "), chunk
        frames.append(
            (
                event_line.removeprefix("event: "),
                json.loads(data_line.removeprefix("data: ")),
            )
        )
    return frames


# ---------------------------------------------------------------------------
# The full server-mode journey.
# ---------------------------------------------------------------------------


class TestServerModeUserJourney:
    def test_complete_journey_from_registration_to_deletion(
        self, api, provider, eager, summary_updates
    ):
        # -- Register --------------------------------------------------------
        registered = api.post(
            REGISTER_URL,
            {"username": LEARNER, "email": f"{LEARNER}@example.com", "password": PASSWORD},
            format="json",
        )
        assert registered.status_code == 201, registered.data

        # -- Login -----------------------------------------------------------
        logged_in = api.post(LOGIN_URL, {"username": LEARNER, "password": PASSWORD}, format="json")
        assert logged_in.status_code == 200, logged_in.data
        api.credentials(HTTP_AUTHORIZATION=f"Bearer {logged_in.data['access']}")

        # -- Choose level ----------------------------------------------------
        level_update = api.patch(PROFILE_URL, {"level": "B2"}, format="json")
        assert level_update.status_code == 200, level_update.data
        assert level_update.data["level"] == "B2"

        # -- New conversation + generated topic and sample --------------------
        provider.queue(completion(TOPIC_PAYLOAD))
        provider.queue(completion(SAMPLE_PAYLOAD))
        created = api.post(SESSIONS_URL, {"topic_hint": "ordering coffee"}, format="json")
        assert created.status_code == 201, created.data
        session = created.data
        assert session["title"] == TOPIC_PAYLOAD["title"]
        assert session["topic"] == TOPIC_PAYLOAD["description"]
        assert session["topic_hint"] == "ordering coffee"
        assert session["learning_level"] == "B2"
        assert list(session["sample_conversation"]["turns"]) == SAMPLE_PAYLOAD["turns"]
        topic_request, sample_request = provider.complete_requests
        assert "ordering coffee" in topic_request.messages[-1].content
        assert "B2" in topic_request.messages[-1].content
        assert TOPIC_PAYLOAD["title"] in sample_request.messages[-1].content

        # -- Chat with a streamed AI response ---------------------------------
        provider.stream_script = (
            StreamStart(model=MODEL),
            StreamDelta(text="Of course!"),
            StreamDelta(text=" What kind of coffee would you like?"),
        )
        stream_response = api.post(
            reverse("conversations:session-message-stream", kwargs={"pk": session["id"]}),
            {"text": USER_TEXT},
            format="json",
        )
        assert stream_response.status_code == 200
        frames = read_frames(stream_response)
        assert frames[0] == ("start", {"model": MODEL})
        assert [name for name, _ in frames[1:-1]] == ["delta", "delta"]
        assert frames[-1] == (
            "completed",
            {"text": ASSISTANT_TEXT, "model": MODEL, "delta_count": 2},
        )
        (stream_request,) = provider.stream_requests
        assert [m.role for m in stream_request.messages] == ["system", "user"]
        assert TOPIC_PAYLOAD["description"] in stream_request.messages[0].content
        assert stream_request.messages[-1].content == USER_TEXT
        # The completed turn scheduled its rolling-summary update post-commit.
        assert flush_on_commit_callbacks() >= 1
        assert summary_updates.enqueued == [(session["id"],)]

        # -- History (session listing and stored messages) --------------------
        history = api.get(SESSIONS_URL, format="json")
        assert history.status_code == 200
        assert history.data["count"] == 1
        assert history.data["results"][0]["id"] == session["id"]
        messages_response = api.get(
            reverse("conversations:session-messages", kwargs={"pk": session["id"]}),
            format="json",
        )
        assert messages_response.status_code == 200
        rows = messages_response.data["results"]
        assert [(row["sequence"], row["role"], row["status"]) for row in rows] == [
            (1, "user", "complete"),
            (2, "assistant", "complete"),
        ]
        assert rows[0]["content"] == USER_TEXT
        assert rows[1]["content"] == ASSISTANT_TEXT
        user_message_id, assistant_message_id = rows[0]["id"], rows[1]["id"]

        # -- Rename ------------------------------------------------------------
        renamed = api.patch(
            reverse("conversations:session-detail", kwargs={"pk": session["id"]}),
            {"title": RENAME_TITLE},
            format="json",
        )
        assert renamed.status_code == 200, renamed.data
        assert renamed.data["title"] == RENAME_TITLE
        assert renamed.data["topic"] == TOPIC_PAYLOAD["description"]  # immutable

        # -- Suggest replies (three, from the completed assistant message) -----
        provider.queue(completion(REPLIES_PAYLOAD))
        suggestions = api.post(
            reverse(
                "conversations:session-message-suggestions",
                kwargs={"pk": session["id"], "message_pk": assistant_message_id},
            ),
            format="json",
        )
        assert suggestions.status_code == 200, suggestions.data
        assert suggestions.data == {"replies": REPLIES_PAYLOAD["replies"]}
        (suggestion_request,) = provider.complete_requests[2:]
        assert ASSISTANT_TEXT in suggestion_request.messages[-1].content

        # -- Improve message (explicit request, on the user message) ----------
        provider.queue(completion(IMPROVEMENT_PAYLOAD))
        improvement = api.post(
            reverse(
                "conversations:session-message-improve",
                kwargs={"pk": session["id"], "message_pk": user_message_id},
            ),
            format="json",
        )
        assert improvement.status_code == 200, improvement.data
        assert improvement.data["original"] == USER_TEXT
        assert improvement.data["improved"] == IMPROVED_TEXT
        assert improvement.data["explanation"] == IMPROVEMENT_PAYLOAD["explanation"]
        (improvement_request,) = provider.complete_requests[3:]
        assert USER_TEXT in improvement_request.messages[-1].content

        # -- Save vocabulary (immediate, enrichment deferred) ------------------
        provider.queue(completion(ENRICHMENT_PAYLOAD))
        saved = api.post(
            SAVE_URL,
            {"expression": EXPRESSION, "source_message_id": assistant_message_id},
            format="json",
        )
        assert saved.status_code == 201, saved.data
        assert saved.data["status"] == VocabularyItem.Status.PENDING
        assert saved.data["definition"] == ""
        assert eager.enqueued == []  # nothing reaches the broker before commit

        # -- Enrich vocabulary (real task, real post-commit scheduling) --------
        assert flush_on_commit_callbacks() == 1
        assert eager.enqueued == [saved.data["id"]]
        listed = api.get(SAVE_URL, format="json")
        assert listed.status_code == 200
        (item,) = listed.data["results"]
        assert item["id"] == saved.data["id"]
        assert item["expression"] == EXPRESSION
        assert item["status"] == VocabularyItem.Status.COMPLETE
        assert item["definition"] == ENRICHMENT_PAYLOAD["definition"]
        (enrichment_request,) = provider.complete_requests[4:]
        assert EXPRESSION in enrichment_request.messages[-1].content
        assert "B2" in enrichment_request.messages[-1].content  # session level

        # -- Export CSV (Anki-ready, from genuinely enriched data) -------------
        export = api.get(EXPORT_URL)
        assert export.status_code == 200
        rows = list(csv.reader(io.StringIO(export.content.decode("utf-8"), newline="")))
        assert rows[0] == ["Front", "Back", "Example", "Pronunciation"]
        assert rows[1] == [
            EXPRESSION,
            ENRICHMENT_PAYLOAD["definition"],
            ENRICHMENT_PAYLOAD["example"],
            ENRICHMENT_PAYLOAD["pronunciation"],
        ]

        # -- TTS (device-local: reads AI text already delivered by the API) ----
        assert all("tts" not in pattern for pattern in all_url_patterns())

        # -- Delete conversation -----------------------------------------------
        deleted = api.delete(reverse("conversations:session-detail", kwargs={"pk": session["id"]}))
        assert deleted.status_code == 204
        assert api.get(SESSIONS_URL, format="json").data["count"] == 0
        assert (
            api.get(
                reverse("conversations:session-messages", kwargs={"pk": session["id"]}),
                format="json",
            ).status_code
            == 404
        )
        # Vocabulary outlives the conversation it came from.
        survivor = api.get(SAVE_URL, format="json").data["results"][0]
        assert survivor["id"] == saved.data["id"]
        assert survivor["status"] == VocabularyItem.Status.COMPLETE
