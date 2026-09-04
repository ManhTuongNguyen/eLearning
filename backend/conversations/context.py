"""Application-service layer for building LLM conversation context.

Assembles the context for one chat turn exactly as ROADMAP section 5
prescribes:

    system instructions + learning profile + topic + summary +
    recent messages + current user message

The result is a single :class:`~llm.types.CompletionRequest` whose first
message is the system prompt (identity, learning level, topic and — when the
session already has one — the rolling summary) followed by the recent history
turns verbatim and the current user message last.

Design rules:

1. Deterministic — identical inputs always produce an identical request; no
   clocks, randomness or I/O take part in assembly.
2. Bounded by construction — the builder consumes only the history window it
   is handed. Selecting that window (and compacting older messages into the
   summary) is the caller's concern (TASK-036/TASK-037), so old messages can
   never silently creep back into the context forever.
3. Pure — no database access and no provider calls; callers read session and
   profile data themselves and pass plain values in.
"""

from __future__ import annotations

from collections.abc import Iterable

from conversations.topics import GeneratedTopic
from learning.models import Level
from llm.types import CompletionRequest, MessageRole

HISTORY_ROLES: frozenset[str] = frozenset({"user", "assistant"})

IDENTITY_SECTION = (
    "You are an AI English tutor chatting with a learner who practises "
    "conversational English with you.\n"
    "Keep your replies natural, friendly and appropriate for the learner's "
    "level, and gently model correct English through the wording of your own "
    "reply.\n"
    "Your reply must be ONLY the chat message itself: one natural, "
    "conversational turn, as if spoken aloud in the conversation.\n"
    "NEVER add notes, explanations or commentary about your teaching "
    "choices, grammar modelling, corrections or strategy — not even in "
    "parentheses, brackets or as a postscript after the message. Never say "
    "or imply that you are modelling, demonstrating or correcting grammar. "
    "Never break character or talk about your role as a tutor inside the "
    "reply. If you want to show correct English, simply use it naturally in "
    "your own sentences."
)

LEVEL_LINES: dict[str, str] = {
    level: (
        f"The learner's English level is {level} (CEFR); keep vocabulary, "
        "grammar and explanations at that level."
    )
    for level in Level.values
    if level != Level.AUTO
}
LEVEL_LINES[Level.AUTO] = (
    "The learner's English level is unknown; infer an appropriate level from "
    "how they write and adjust your language accordingly."
)

TOPIC_TITLE_LINE = 'Conversation topic: "{title}".'
TOPIC_SCENARIO_LINE = "Topic scenario: {description}"

SUMMARY_HEADER = "Summary of the earlier conversation:"


class ContextBuilder:
    """Construct the LLM context for one turn of a conversation."""

    def build(
        self,
        *,
        level: str,
        topic: GeneratedTopic,
        summary: str = "",
        recent_messages: Iterable[tuple[str, str]] = (),
        current_message: str,
    ) -> CompletionRequest:
        """Return the :class:`CompletionRequest` for the next chat turn.

        ``recent_messages`` are ``(role, content)`` pairs in chronological
        order containing only the turns the caller wants the model to see;
        they are included verbatim between the system prompt and the current
        user message. ``summary`` is the rolling summary text; blank means
        "no summary yet" and omits the section entirely.
        """
        if level not in Level.values:
            allowed = ", ".join(Level.values)
            raise ValueError(f"Unknown learning level {level!r}; expected one of: {allowed}.")
        if not isinstance(topic, GeneratedTopic):
            raise ValueError("topic must be a GeneratedTopic instance.")
        stripped_current = current_message.strip()
        if not stripped_current:
            raise ValueError("current_message must not be empty.")
        system_prompt = _build_system_prompt(level=level, topic=topic, summary=summary)
        return CompletionRequest.from_texts(
            [
                ("system", system_prompt),
                *(_history_turn(recent_messages)),
                ("user", stripped_current),
            ]
        )


def _build_system_prompt(*, level: str, topic: GeneratedTopic, summary: str) -> str:
    """Assemble the system prompt sections in fixed order."""
    blocks: list[str] = [
        IDENTITY_SECTION,
        LEVEL_LINES[level],
        "\n".join(
            [
                TOPIC_TITLE_LINE.format(title=topic.title),
                TOPIC_SCENARIO_LINE.format(description=topic.description),
            ]
        ),
    ]
    if summary.strip():
        blocks.append("\n".join([SUMMARY_HEADER, summary]))
    return "\n\n".join(blocks)


def _history_turn(recent_messages: Iterable[tuple[str, str]]) -> list[tuple[MessageRole, str]]:
    """Validate and pass through the given history window unchanged."""
    turns: list[tuple[MessageRole, str]] = []
    for position, (role, content) in enumerate(recent_messages):
        if role not in HISTORY_ROLES:
            allowed = ", ".join(sorted(HISTORY_ROLES))
            raise ValueError(
                f"History turn {position} has invalid role {role!r}; expected one of: {allowed}."
            )
        turns.append((role, content))
    return turns


__all__ = ["ContextBuilder"]
