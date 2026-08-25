"""Application-service layer for conversation-topic generation.

Generates a structured conversation topic — plus an optional short example
dialogue for that topic — from the learner's English level and an optional
user hint by asking any :class:`~llm.provider.LLMProvider` for strict JSON
output. The service owns four concerns:

1. Prompt construction — the learning level and hint shape the user message;
   ``AUTO`` lets the model infer an appropriate difficulty.
2. Structured-output parsing — completions must decode into a
   :class:`GeneratedTopic` / :class:`SampleConversation`; anything else is a
   contract violation.
3. Failure normalization — transport/provider failures propagate unchanged as
   ``LLMError`` subclasses (callers above decide on retries), while malformed
   completions become :class:`~llm.exceptions.LLMResponseError` attributed to
   the ``"topics"`` provider name with the served model attached.
4. Purity — sample conversations are in-memory value objects returned to the
   caller (and serializable for API responses); they are never persisted as
   chat :class:`~conversations.models.Message` rows.

Completion payloads are never logged.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from conversations.models import Message
from learning.models import Level
from llm.exceptions import LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest

logger = logging.getLogger("conversations.topics")

ERROR_PROVIDER = "topics"

SYSTEM_PROMPT = (
    "You create conversation topics for an English-learning chat application "
    "where a learner practises English with an AI tutor.\n"
    "Respond with ONLY one JSON object and nothing else, using exactly this shape:\n"
    '{"title": "<short engaging topic name>", '
    '"description": "<two or three sentences describing the scenario and what '
    'the learner should practise>"}'
)

SAMPLE_SYSTEM_PROMPT = (
    "You write short example conversations for an English-learning chat "
    "application where a learner practises English with an AI tutor.\n"
    "Respond with ONLY one JSON object and nothing else, using exactly this shape:\n"
    '{"turns": [{"role": "assistant", "content": "<what the tutor says>"}, '
    '{"role": "user", "content": "<what the learner replies>"}]}\n'
    'Use only the roles "assistant" and "user". Write 4 to 6 turns in total, '
    'alternating between them and starting with "assistant".'
)

SAMPLE_ROLES = (Message.Role.ASSISTANT, Message.Role.USER)
MIN_SAMPLE_TURNS = 2


@dataclass(frozen=True)
class GeneratedTopic:
    """Structured result of one topic generation.

    ``title`` is the short display name (also suitable as a session title);
    ``description`` carries enough scenario detail for the AI tutor to conduct
    the English-learning conversation (ROADMAP section 6).
    """

    title: str
    description: str


@dataclass(frozen=True)
class SampleTurn:
    """One dialogue line of a sample conversation.

    ``role`` mirrors the chat message roles (``"assistant"`` = AI tutor,
    ``"user"`` = learner) so the example can be rendered and spoken like a
    normal exchange.
    """

    role: str
    content: str

    def __post_init__(self) -> None:
        if self.role not in SAMPLE_ROLES:
            allowed = ", ".join(SAMPLE_ROLES)
            raise ValueError(f"Invalid sample turn role {self.role!r}; expected one of: {allowed}.")
        if not self.content.strip():
            raise ValueError("Sample turn content must not be empty.")


@dataclass(frozen=True)
class SampleConversation:
    """A short example dialogue belonging to one generated topic.

    Pure display data: it is returned through the API for the "Show me an
    example" flow but never persisted as user chat messages.
    """

    turns: tuple[SampleTurn, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "turns", tuple(self.turns))
        if len(self.turns) < MIN_SAMPLE_TURNS:
            raise ValueError(f"A sample conversation needs at least {MIN_SAMPLE_TURNS} turns.")


class TopicGenerationService:
    """Generate structured topics through any :class:`LLMProvider`."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def generate(self, *, level: str, hint: str = "") -> GeneratedTopic:
        """Return a :class:`GeneratedTopic` for ``level`` and optional ``hint``."""
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        request = CompletionRequest.from_texts(
            [
                ("system", SYSTEM_PROMPT),
                ("user", _build_user_prompt(level, hint.strip())),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            topic = _parse_topic(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "topic generation produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        logger.info(
            "topic generated model=%s chars=%d in %.2fs",
            response.model,
            len(response.text),
            time.monotonic() - began,
        )
        return topic

    def generate_sample(self, *, topic: GeneratedTopic, level: str) -> SampleConversation:
        """Return a short example dialogue demonstrating ``topic`` at ``level``.

        The result is display data only; callers must not persist it as chat
        messages.
        """
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        if not isinstance(topic, GeneratedTopic):
            raise ValueError("topic must be a GeneratedTopic instance.")
        request = CompletionRequest.from_texts(
            [
                ("system", SAMPLE_SYSTEM_PROMPT),
                ("user", _build_sample_user_prompt(level, topic)),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            sample = _parse_sample(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "sample conversation generation produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        logger.info(
            "sample conversation generated model=%s turns=%d in %.2fs",
            response.model,
            len(sample.turns),
            time.monotonic() - began,
        )
        return sample


def _build_user_prompt(level: str, hint: str) -> str:
    """Compose the user-turn instruction from level and hint."""
    parts: list[str] = [
        "Create a conversation topic for a new English-learning chat session.",
    ]
    if level == Level.AUTO:
        parts.append(
            "The learner's English level is unknown; infer an appropriate level "
            "for the topic you choose."
        )
    else:
        parts.append(
            f"The learner's English level is {level} (CEFR); keep vocabulary and "
            "grammar at that level."
        )
    if hint:
        parts.append(f'Topic idea from the learner: "{hint}". Build the topic around this idea.')
    else:
        parts.append("The learner gave no preference; choose an engaging everyday topic.")
    return "\n".join(parts)


def _parse_topic(text: str, *, model: str | None) -> GeneratedTopic:
    """Decode one completion into a :class:`GeneratedTopic`.

    Tolerates JSON wrapped in code fences or surrounding prose (the outermost
    brace span is retried once), but rejects every other deviation.
    """
    payload = _extract_json_object(text)
    if not isinstance(payload, dict):
        raise LLMResponseError(
            "Topic response was not a JSON object.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    title = payload.get("title")
    description = payload.get("description")
    if not isinstance(title, str) or not title.strip():
        raise LLMResponseError(
            "Topic response is missing a non-empty 'title' string.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    if not isinstance(description, str) or not description.strip():
        raise LLMResponseError(
            "Topic response is missing a non-empty 'description' string.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    return GeneratedTopic(title=title.strip(), description=description.strip())


def _build_sample_user_prompt(level: str, topic: GeneratedTopic) -> str:
    """Compose the user-turn instruction for one sample conversation."""
    parts: list[str] = [
        "Write an example conversation that demonstrates this topic for a new "
        "English-learning chat session.",
    ]
    if level == Level.AUTO:
        parts.append(
            "The learner's English level is unknown; infer an appropriate level "
            "for the topic you choose."
        )
    else:
        parts.append(
            f"The learner's English level is {level} (CEFR); keep vocabulary and "
            "grammar at that level."
        )
    parts.append(f'Topic title: "{topic.title}".')
    parts.append(f"Topic scenario: {topic.description}")
    return "\n".join(parts)


def _parse_sample(text: str, *, model: str | None) -> SampleConversation:
    """Decode one completion into a :class:`SampleConversation`.

    Tolerates JSON wrapped in code fences or surrounding prose (the outermost
    brace span is retried once), but rejects every other deviation. Extra JSON
    keys are ignored.
    """
    payload = _extract_json_object(text)
    if not isinstance(payload, dict):
        raise LLMResponseError(
            "Sample conversation response was not a JSON object.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    raw_turns = payload.get("turns")
    if not isinstance(raw_turns, list):
        raise LLMResponseError(
            "Sample conversation response is missing a 'turns' list.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    if len(raw_turns) < MIN_SAMPLE_TURNS:
        raise LLMResponseError(
            f"Sample conversation needs at least {MIN_SAMPLE_TURNS} turns.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    turns: list[SampleTurn] = []
    for index, entry in enumerate(raw_turns):
        turns.append(_parse_turn(entry, position=index, model=model))
    return SampleConversation(turns=turns)


def _parse_turn(entry: Any, *, position: int, model: str | None) -> SampleTurn:
    """Decode one ``turns`` entry into a :class:`SampleTurn`."""
    if not isinstance(entry, dict):
        raise LLMResponseError(
            "Sample conversation turns must be JSON objects.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    role = entry.get("role")
    if role not in SAMPLE_ROLES:
        raise LLMResponseError(
            f"Sample conversation turn {position} has an invalid role.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    content = entry.get("content")
    if not isinstance(content, str) or not content.strip():
        raise LLMResponseError(
            f"Sample conversation turn {position} is missing a non-empty content string.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    return SampleTurn(role=role, content=content.strip())


def _extract_json_object(text: str) -> Any | None:
    """Parse ``text`` as JSON, falling back to its outermost brace span."""
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


__all__ = ["GeneratedTopic", "SampleConversation", "SampleTurn", "TopicGenerationService"]
