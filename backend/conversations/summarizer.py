"""Application-service layer for rolling conversation summaries.

Implements the summarization half of ROADMAP section 5's context
architecture: as a conversation grows, turns that fall out of the recent
message window are folded into a rolling summary instead of being resent to
the LLM forever.

The service consumes EXACTLY the increment it is handed — the previous
summary plus only the messages that just left the active window — and
produces the updated summary. It never receives (and therefore never
re-processes) the complete conversation.

Design rules mirror :mod:`conversations.topics`:

1. Provider injection — :class:`ConversationSummarizer` wraps ANY
   :class:`~llm.provider.LLMProvider`, so tests substitute a fake.
2. Input validation — bad inputs raise ``ValueError`` before any provider
   request; roles are restricted to ``user``/``assistant`` like
   :class:`~conversations.context.ContextBuilder` history turns.
3. Failure normalization — transport/provider failures propagate unchanged
   as ``LLMError`` subclasses, while unusable completions become
   :class:`~llm.exceptions.LLMResponseError` attributed to the
   ``"summaries"`` provider name with the served model attached.
4. Purity — no database access and no persistence here; callers own the
   session row and store the returned summary text (TASK-038/TASK-039).

Completion payloads are never logged.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable

from conversations.context import HISTORY_ROLES
from llm.exceptions import LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest

logger = logging.getLogger("conversations.summaries")

ERROR_PROVIDER = "summaries"

SYSTEM_PROMPT = (
    "You maintain the rolling summary of an ongoing English-learning chat "
    "between a learner and an AI tutor.\n"
    "Respond with ONLY the updated summary as plain text: no headings, no "
    "markdown formatting, no quotation marks around the whole summary and no "
    "commentary.\n"
    "Keep it concise but preserve names, preferences, corrections and any "
    "unfinished threads so the tutor can continue the conversation naturally."
)

PREVIOUS_SUMMARY_HEADER = "Summary of the conversation so far:"
ARCHIVED_MESSAGES_HEADER = (
    "These messages have just left the recent window and must now be folded into the summary:"
)
WRITE_INSTRUCTION = (
    "Write the updated summary covering everything in the previous summary plus these messages."
)


class ConversationSummarizer:
    """Produce updated rolling summaries through any :class:`LLMProvider`."""

    def __init__(self, provider: LLMProvider) -> None:
        self.provider = provider

    def summarize(
        self,
        *,
        previous_summary: str = "",
        archived_messages: Iterable[tuple[str, str]],
    ) -> str:
        """Return the updated summary text for one compaction step.

        ``archived_messages`` are ``(role, content)`` pairs — ONLY the turns
        that just left the active recent window, in chronological order.
        ``previous_summary`` is the existing rolling summary; blank means
        this is the first compaction. The LLM request contains exactly these
        inputs and nothing else from the conversation.
        """
        if not isinstance(previous_summary, str):
            raise ValueError("previous_summary must be a string.")
        messages = _validate_archived_messages(archived_messages)
        request = CompletionRequest.from_texts(
            [
                ("system", SYSTEM_PROMPT),
                ("user", _build_user_prompt(previous_summary.strip(), messages)),
            ]
        )
        began = time.monotonic()
        response = self.provider.complete(request)
        try:
            summary = _parse_summary(response.text, model=response.model)
        except LLMResponseError as exc:
            logger.warning(
                "summary generation produced unusable output after %.2fs: %s",
                time.monotonic() - began,
                exc,
            )
            raise
        logger.info(
            "summary generated model=%s chars=%d in %.2fs",
            response.model,
            len(response.text),
            time.monotonic() - began,
        )
        return summary


def _validate_archived_messages(messages: Iterable[tuple[str, str]]) -> tuple[tuple[str, str], ...]:
    """Normalize and validate the archived-message batch before any call."""
    normalized = tuple(messages)
    if not normalized:
        raise ValueError(
            "archived_messages must not be empty; summarization runs only when "
            "messages actually leave the recent window."
        )
    allowed = ", ".join(sorted(HISTORY_ROLES))
    for position, entry in enumerate(normalized):
        try:
            role, content = entry
        except (TypeError, ValueError):
            raise ValueError(
                f"Archived message {position} must be a (role, content) pair."
            ) from None
        if not isinstance(role, str) or role not in HISTORY_ROLES:
            raise ValueError(
                f"Archived message {position} has invalid role {role!r}; "
                f"expected one of: {allowed}."
            )
        if not isinstance(content, str) or not content.strip():
            raise ValueError(f"Archived message {position} content must not be empty.")
    return normalized


def _build_user_prompt(previous_summary: str, messages: tuple[tuple[str, str], ...]) -> str:
    """Compose the user-turn instruction from the two summarizer inputs."""
    parts: list[str] = []
    if previous_summary:
        parts.extend([PREVIOUS_SUMMARY_HEADER, previous_summary])
    parts.append(ARCHIVED_MESSAGES_HEADER)
    parts.extend(f"{role}: {content}" for role, content in messages)
    parts.append(WRITE_INSTRUCTION)
    return "\n".join(parts)


def _parse_summary(text: str, *, model: str | None) -> str:
    """Decode one completion into the new summary text.

    Tolerates the completion being wrapped in a single code fence (a common
    model habit even when asked for plain text); rejects blank output.
    """
    stripped = _strip_code_fence(text.strip())
    if not stripped:
        raise LLMResponseError(
            "Summary response was empty.",
            provider=ERROR_PROVIDER,
            model=model,
        )
    return stripped


def _strip_code_fence(text: str) -> str:
    """Remove one surrounding ``` fence (with optional language tag)."""
    if not text.startswith("```"):
        return text
    without_open = text[3:]
    newline = without_open.find("\n")
    if newline == -1:
        return without_open
    body = without_open[newline + 1 :]
    closing = body.rfind("```")
    if closing != -1 and not body[closing + 3 :].strip():
        body = body[:closing]
    return body.rstrip()


__all__ = ["ConversationSummarizer"]
