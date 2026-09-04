"""Application-service layer for "Improve my English" corrections.

Improves one learner-written message on explicit request (ROADMAP section 8):
the corrected sentence plus a short level-appropriate explanation of what
changed. The service owns four concerns:

1. Prompt construction — the learner's English level shapes how the
   explanation is written; ``AUTO`` lets the model infer an appropriate
   level. The message under correction is quoted verbatim.
2. Structured-output parsing — completions must decode into the
   ``improved`` / ``explanation`` / ``severity`` fields of a
   :class:`Improvement` value object; anything else is a contract violation.
   The model is never asked to echo the original text: ``original`` is
   composed from the caller's input so the learner always sees exactly what
   they wrote. ``severity`` classifies how wrong the original was —
   ``none`` (already correct), ``minor`` (small slips) or ``critical``
   (meaning-breaking mistakes) — so the mobile app can badge the message
   without a second provider call.
3. Failure normalization — transport/provider failures propagate unchanged
   as ``LLMError`` subclasses (callers above decide on retries), while
   malformed completions become :class:`~llm.exceptions.LLMResponseError`
   attributed to the ``"improvement"`` provider name with the served model
   attached.
4. Purity — improvements are in-memory display data returned to the caller;
   nothing here touches the database and no correction is ever persisted
   back onto the chat :class:`~conversations.models.Message` row.

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

logger = logging.getLogger("conversations.improvement")

ERROR_PROVIDER = "improvement"

SYSTEM_PROMPT = (
    "You correct English messages written by a learner in an English-learning "
    "chat application.\n"
    "Respond with ONLY one JSON object and nothing else, using exactly this shape:\n"
    '{"improved": "<the corrected message>", '
    '"explanation": "<short reason for the changes>", '
    '"severity": "<none|minor|critical>"}\n'
    "Fix grammar, spelling, word choice and natural phrasing while keeping the "
    "learner's meaning and tone. If the message is already correct, return it "
    'unchanged as "improved", say so briefly and use severity "none". Rate '
    'severity by how much the mistakes hurt understanding: "none" for a '
    'correct message, "minor" for small slips a reader easily overlooks '
    '(typos, a missing article), "critical" for mistakes that break or '
    "materially distort the meaning (wrong verb tense changing when something "
    "happened, wrong negation, wrong key vocabulary). Keep the explanation to "
    "one or two short sentences."
)

SEVERITY_NONE = "none"
SEVERITY_MINOR = "minor"
SEVERITY_CRITICAL = "critical"
SEVERITY_VALUES = (SEVERITY_NONE, SEVERITY_MINOR, SEVERITY_CRITICAL)

USER_PROMPT_HEADER = (
    "Improve this English message that the learner wrote in an ongoing "
    "English-learning chat session."
)
MESSAGE_INSTRUCTION = 'The learner\'s message: "{message}"'


@dataclass(frozen=True)
class Improvement:
    """Structured result of one improvement request.

    ``original`` is the learner's message exactly as supplied (whitespace-
    trimmed only); ``improved`` is the corrected version and ``explanation``
    concisely describes the important corrections at the learner's level.
    ``severity`` classifies how wrong the original was — ``none`` (already
    correct), ``minor`` (small slips) or ``critical`` (meaning-breaking
    mistakes). Pure display data: never persisted over the original chat
    message.
    """

    original: str
    improved: str
    explanation: str
    severity: str

    def __post_init__(self) -> None:
        for field_name in ("original", "improved", "explanation"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Improvement {field_name} must be a non-empty string.")
        if isinstance(self.severity, str):
            # Case-insensitive by contract: "Minor" means "minor".
            object.__setattr__(self, "severity", self.severity.strip().lower())
        if self.severity not in SEVERITY_VALUES:
            raise ValueError(f"Improvement severity must be one of: {', '.join(SEVERITY_VALUES)}.")


class ImprovementService:
    """Improve learner messages through any :class:`LLMProvider`."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def improve(self, *, level: str, original_message: str) -> Improvement:
        """Return a :class:`Improvement` for one learner message.

        ``original_message`` is the user-authored text to correct; it is
        echoed back unchanged (trimmed) as :attr:`Improvement.original`.
        """
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        if not isinstance(original_message, str) or not original_message.strip():
            raise ValueError("original_message must be a non-empty string.")
        message = original_message.strip()
        request = CompletionRequest.from_texts(
            [
                ("system", SYSTEM_PROMPT),
                ("user", _build_user_prompt(level=level, message=message)),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            improved, explanation, severity = _parse_correction(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "improvement produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        result = Improvement(
            original=message,
            improved=improved,
            explanation=explanation,
            severity=severity,
        )
        logger.info(
            "improvement generated model=%s in %.2fs",
            response.model,
            time.monotonic() - began,
        )
        return result


def _build_user_prompt(*, level: str, message: str) -> str:
    """Compose the user-turn instruction from level and message."""
    parts: list[str] = [USER_PROMPT_HEADER]
    if level == Level.AUTO:
        parts.append(
            "The learner's English level is unknown; infer an appropriate level "
            "for the explanation."
        )
    else:
        parts.append(
            f"The learner's English level is {level} (CEFR); write the "
            "explanation so a learner at that level understands it."
        )
    parts.append(MESSAGE_INSTRUCTION.format(message=message))
    return "\n".join(parts)


def _parse_correction(text: str, *, model: str | None) -> tuple[str, str, str]:
    """Decode one completion into ``(improved, explanation, severity)``.

    Tolerates JSON wrapped in code fences or surrounding prose (the outermost
    brace span is retried once), but rejects every other deviation: missing,
    blank or non-string fields and severities outside the allowed set are all
    contract violations. Extra JSON keys are ignored.
    """
    payload = _extract_json_object(text)
    if not isinstance(payload, dict):
        raise LLMResponseError(
            "Improvement response was not a JSON object.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    fields: dict[str, str] = {}
    for field_name in ("improved", "explanation"):
        value = payload.get(field_name)
        if not isinstance(value, str) or not value.strip():
            raise LLMResponseError(
                f"Improvement response is missing a non-empty '{field_name}' string.",
                provider=ERROR_PROVIDER,
                model=model,
            )
        fields[field_name] = value.strip()
    raw_severity = payload.get("severity")
    # Case-insensitive: models routinely answer "None"/"Minor"/"Critical";
    # only genuinely unknown values stay contract violations.
    severity = raw_severity.strip().lower() if isinstance(raw_severity, str) else raw_severity
    if severity not in SEVERITY_VALUES:
        raise LLMResponseError(
            f"Improvement response is missing a valid 'severity' ({'|'.join(SEVERITY_VALUES)}).",
            provider=ERROR_PROVIDER,
            model=model,
        )
    return fields["improved"], fields["explanation"], severity


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


__all__ = ["SEVERITY_VALUES", "Improvement", "ImprovementService"]
