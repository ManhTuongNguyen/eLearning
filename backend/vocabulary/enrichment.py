"""Application-service layer for asynchronous vocabulary enrichment (TASK-068).

Enriches one saved word or phrase through any :class:`~llm.provider.LLMProvider`
after the save API has already responded (ROADMAP "Vocabulary": the learner
never waits for enrichment). The service owns four concerns:

1. Prompt construction — the expression and the learner's English level shape
   the request; ``AUTO`` lets the model infer an appropriate difficulty.
2. Structured-output parsing — completions must decode into the five fields of
   an :class:`Enrichment` value object (definition, translation, pronunciation,
   part of speech, example); anything else is a contract violation.
3. Failure normalization — transport/provider failures propagate unchanged as
   ``LLMError`` subclasses (the Celery task decides retry vs abandon), while
   malformed completions become :class:`~llm.exceptions.LLMResponseError`
   attributed to the ``"vocabulary"`` provider name with the served model
   attached.
4. Purity — enrichment is in-memory display data; this module never touches
   the database. Persisting results and status transitions lives in
   :mod:`vocabulary.tasks`.

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

logger = logging.getLogger("vocabulary.enrichment")

ERROR_PROVIDER = "vocabulary"

SYSTEM_PROMPT = (
    "You enrich vocabulary items saved by a learner in an English-learning chat "
    "application.\n"
    "Respond with ONLY one JSON object and nothing else, using exactly this shape:\n"
    '{"definition": "<clear definition at the learner\'s level>", '
    '"translation": "<plain-English equivalent or short gloss>", '
    '"pronunciation": "<IPA transcription>", '
    '"part_of_speech": "<noun, verb, phrase, ...>", '
    '"example": "<one natural sentence using the expression>"}\n'
    "The expression may be a single word, a phrase or a multi-word expression. "
    "Keep every field short and useful for a flashcard."
)

USER_PROMPT_HEADER = (
    "Enrich this English expression that the learner saved from an English-learning chat session."
)
EXPRESSION_INSTRUCTION = 'The learner\'s expression: "{expression}"'


@dataclass(frozen=True)
class Enrichment:
    """Structured result of one vocabulary-enrichment request.

    All five fields are required non-empty strings so a persisted item always
    carries complete, card-ready data once its status flips to ``complete``.
    """

    definition: str
    translation: str
    pronunciation: str
    part_of_speech: str
    example: str

    def __post_init__(self) -> None:
        for field_name in (
            "definition",
            "translation",
            "pronunciation",
            "part_of_speech",
            "example",
        ):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Enrichment {field_name} must be a non-empty string.")


class EnrichmentService:
    """Enrich vocabulary expressions through any :class:`LLMProvider`."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def enrich(self, *, expression: str, level: str) -> Enrichment:
        """Return an :class:`Enrichment` for one saved expression.

        ``level`` shapes the definition's difficulty; ``AUTO`` lets the model
        infer an appropriate level.
        """
        if not isinstance(expression, str) or not expression.strip():
            raise ValueError("expression must be a non-empty string.")
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        request = CompletionRequest.from_texts(
            [
                ("system", SYSTEM_PROMPT),
                ("user", _build_user_prompt(level=level, expression=expression.strip())),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            enrichment = _parse_enrichment(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "enrichment produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        logger.info(
            "expression enriched model=%s chars=%d in %.2fs",
            response.model,
            len(response.text),
            time.monotonic() - began,
        )
        return enrichment


def _build_user_prompt(*, level: str, expression: str) -> str:
    """Compose the user-turn instruction from level and expression."""
    parts: list[str] = [USER_PROMPT_HEADER]
    if level == Level.AUTO:
        parts.append(
            "The learner's English level is unknown; infer an appropriate level for the definition."
        )
    else:
        parts.append(
            f"The learner's English level is {level} (CEFR); keep the definition "
            "and example at that level."
        )
    parts.append(EXPRESSION_INSTRUCTION.format(expression=expression))
    return "\n".join(parts)


def _parse_enrichment(text: str, *, model: str | None) -> Enrichment:
    """Decode one completion into an :class:`Enrichment`.

    Tolerates JSON wrapped in code fences or surrounding prose (the outermost
    brace span is retried once), but rejects every other deviation: missing,
    blank or non-string fields are all contract violations. Extra JSON keys
    are ignored.
    """
    payload = _extract_json_object(text)
    if not isinstance(payload, dict):
        raise LLMResponseError(
            "Vocabulary enrichment response was not a JSON object.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    fields: dict[str, str] = {}
    for field_name in (
        "definition",
        "translation",
        "pronunciation",
        "part_of_speech",
        "example",
    ):
        value = payload.get(field_name)
        if not isinstance(value, str) or not value.strip():
            raise LLMResponseError(
                f"Vocabulary enrichment response is missing a non-empty '{field_name}' string.",
                provider=ERROR_PROVIDER,
                model=model,
            )
        fields[field_name] = value.strip()
    return Enrichment(**fields)


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


__all__ = ["Enrichment", "EnrichmentService"]
