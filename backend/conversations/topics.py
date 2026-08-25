"""Application-service layer for conversation-topic generation.

Generates a structured conversation topic from the learner's English level and
an optional user hint by asking any :class:`~llm.provider.LLMProvider` for
strict JSON output. The service owns three concerns:

1. Prompt construction — the learning level and hint shape the user message;
   ``AUTO`` lets the model infer an appropriate difficulty.
2. Structured-output parsing — the completion must decode into a
   :class:`GeneratedTopic`; anything else is a contract violation.
3. Failure normalization — transport/provider failures propagate unchanged as
   ``LLMError`` subclasses (callers above decide on retries), while malformed
   completions become :class:`~llm.exceptions.LLMResponseError` attributed to
   the ``"topics"`` provider name with the served model attached.

Completion payloads are never logged.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

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


@dataclass(frozen=True)
class GeneratedTopic:
    """Structured result of one topic generation.

    ``title`` is the short display name (also suitable as a session title);
    ``description`` carries enough scenario detail for the AI tutor to conduct
    the English-learning conversation (ROADMAP section 6).
    """

    title: str
    description: str


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


__all__ = ["GeneratedTopic", "TopicGenerationService"]
