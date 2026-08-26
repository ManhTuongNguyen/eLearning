"""Application-service layer for suggested-reply generation.

Generates exactly three candidate replies the learner could send next,
based on the selected chat message, the conversation up to that message,
the session topic and the learner's English level (ROADMAP section 8).
The service owns four concerns:

1. Prompt construction — topic, level line, a ``Learner``/``Tutor``
   transcript of the supplied history window and the selected message
   shape the user turn.
2. Structured-output parsing — completions must decode into a
   :class:`Suggestions` value object holding exactly three non-blank,
   mutually distinct replies; anything else is a contract violation.
3. Failure normalization — transport/provider failures propagate unchanged
   as ``LLMError`` subclasses (callers above decide on retries), while
   malformed completions become :class:`~llm.exceptions.LLMResponseError`
   attributed to the ``"suggestions"`` provider name with the served model
   attached.
4. Purity — suggestions are in-memory display data returned to the caller;
   nothing here touches the database and no suggestion is ever persisted as
   a chat :class:`~conversations.models.Message` row.

Completion payloads are never logged.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from conversations.context import HISTORY_ROLES
from conversations.topics import GeneratedTopic
from learning.models import Level
from llm.exceptions import LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest

logger = logging.getLogger("conversations.suggestions")

ERROR_PROVIDER = "suggestions"
SUGGESTION_COUNT = 3

SYSTEM_PROMPT = (
    "You suggest possible next replies for a learner in an English-learning "
    "chat where they practise conversational English with an AI tutor.\n"
    "Respond with ONLY one JSON object and nothing else, using exactly this "
    'shape:\n{"replies": ["<first reply>", "<second reply>", "<third reply>"]}\n'
    "The replies list must contain exactly three items: short natural messages "
    "the learner could send next, written at their English level, relevant to "
    "the topic and conversation so far, and meaningfully different from each "
    "other."
)

SPEAKER_LABELS = {"user": "Learner", "assistant": "Tutor"}

TRANSCRIPT_HEADER = "Conversation so far:"
EMPTY_TRANSCRIPT_LINE = "The conversation has just started; there are no earlier messages."
SELECTED_MESSAGE_INSTRUCTION = (
    'The learner long-pressed this message: "{selected}"\n'
    "Write exactly three replies that the learner could send next."
)


@dataclass(frozen=True)
class Suggestions:
    """Exactly three candidate replies the learner could send next.

    Pure display data: rendered as tappable chips whose selection fills the
    composer; never persisted as chat messages by this service.
    """

    replies: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "replies", tuple(self.replies))
        if len(self.replies) != SUGGESTION_COUNT:
            raise ValueError(f"Suggestions must contain exactly {SUGGESTION_COUNT} replies.")
        for reply in self.replies:
            if not isinstance(reply, str) or not reply.strip():
                raise ValueError("Suggestion replies must be non-empty strings.")


class SuggestionService:
    """Generate suggested replies through any :class:`LLMProvider`."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def suggest(
        self,
        *,
        level: str,
        topic: GeneratedTopic,
        selected_message: str,
        history: Iterable[tuple[str, str]] = (),
    ) -> Suggestions:
        """Return three suggested replies for ``selected_message``.

        ``history`` holds ``(role, content)`` pairs — ONLY the turns before
        the selected message, in chronological order; it may be empty when
        the selected message opens the conversation. The LLM request contains
        exactly these inputs and nothing else from the conversation.
        """
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        if not isinstance(topic, GeneratedTopic):
            raise ValueError("topic must be a GeneratedTopic instance.")
        if not isinstance(selected_message, str) or not selected_message.strip():
            raise ValueError("selected_message must be a non-empty string.")
        context = _validate_history(history)
        request = CompletionRequest.from_texts(
            [
                ("system", SYSTEM_PROMPT),
                (
                    "user",
                    _build_user_prompt(
                        level=level,
                        topic=topic,
                        history=context,
                        selected_message=selected_message.strip(),
                    ),
                ),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            suggestions = _parse_suggestions(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "suggestion generation produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        logger.info(
            "suggestions generated model=%s count=%d in %.2fs",
            response.model,
            len(suggestions.replies),
            time.monotonic() - began,
        )
        return suggestions


def _validate_history(history: Iterable[tuple[str, str]]) -> tuple[tuple[str, str], ...]:
    """Validate the pre-selection history window before any call."""
    normalized = tuple(history)
    allowed = ", ".join(sorted(HISTORY_ROLES))
    for position, entry in enumerate(normalized):
        try:
            role, content = entry
        except (TypeError, ValueError):
            raise ValueError(
                f"History message {position} must be a (role, content) pair."
            ) from None
        if not isinstance(role, str) or role not in HISTORY_ROLES:
            raise ValueError(
                f"History message {position} has invalid role {role!r}; expected one of: {allowed}."
            )
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"History message {position} content must not be empty.")
    return normalized


def _build_user_prompt(
    *,
    level: str,
    topic: GeneratedTopic,
    history: tuple[tuple[str, str], ...],
    selected_message: str,
) -> str:
    """Compose the user-turn instruction from all four suggestion inputs."""
    parts: list[str] = [
        "Suggest possible next replies for the learner in an ongoing "
        "English-learning chat session.",
    ]
    if level == Level.AUTO:
        parts.append("The learner's English level is unknown; keep the replies broadly accessible.")
    else:
        parts.append(
            f"The learner's English level is {level} (CEFR); keep vocabulary "
            "and grammar at that level."
        )
    parts.append(f'Topic title: "{topic.title}".')
    parts.append(f"Topic scenario: {topic.description}")
    parts.append(TRANSCRIPT_HEADER)
    if history:
        parts.extend(f"{SPEAKER_LABELS[role]}: {content}" for role, content in history)
    else:
        parts.append(EMPTY_TRANSCRIPT_LINE)
    parts.append(SELECTED_MESSAGE_INSTRUCTION.format(selected=selected_message))
    return "\n".join(parts)


def _parse_suggestions(text: str, *, model: str | None) -> Suggestions:
    """Decode one completion into a :class:`Suggestions` object.

    Tolerates JSON wrapped in code fences or surrounding prose (the outermost
    brace span is retried once), but rejects every other deviation: wrong
    reply count, blank/non-string entries and near-duplicate replies are all
    contract violations. Extra JSON keys are ignored.
    """
    payload = _extract_json_object(text)
    if not isinstance(payload, dict):
        raise LLMResponseError(
            "Suggestions response was not a JSON object.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    raw_replies = payload.get("replies")
    if not isinstance(raw_replies, list):
        raise LLMResponseError(
            "Suggestions response is missing a 'replies' list.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    if len(raw_replies) != SUGGESTION_COUNT:
        raise LLMResponseError(
            f"Suggestions response must contain exactly {SUGGESTION_COUNT} "
            f"replies; got {len(raw_replies)}.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    replies: list[str] = []
    for position, entry in enumerate(raw_replies):
        if not isinstance(entry, str) or not entry.strip():
            raise LLMResponseError(
                f"Suggestion {position} is missing a non-empty string.",
                provider=ERROR_PROVIDER,
                model=model,
            )
        replies.append(entry.strip())
    lowered = {reply.lower() for reply in replies}
    if len(lowered) != SUGGESTION_COUNT:
        raise LLMResponseError(
            "Suggestions must be meaningfully different from each other.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    return Suggestions(replies=replies)


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


__all__ = ["Suggestions", "SuggestionService"]
