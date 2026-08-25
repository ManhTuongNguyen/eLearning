"""Recent-message window selection for conversation context.

ROADMAP section 5 forbids sending the complete conversation to the LLM
indefinitely. :class:`~conversations.context.ContextBuilder` consumes only
the history window it is handed; this module implements the caller side of
that contract: given the full prior history of a session in chronological
order, :func:`select_recent_messages` returns only the most recent turns —
still in chronological order — ready to pass as ``recent_messages``.

The current user message is deliberately NOT part of the window. It is
passed to the builder separately as ``current_message``, so it always
appears last and can never be crowded out or duplicated by older turns.

Design rules mirror :mod:`conversations.context`: pure (no database access,
no provider calls), deterministic, and bounded by construction.

The window size is configurable through the ``CONTEXT_RECENT_MESSAGE_WINDOW``
Django setting (see ``.env.example``); the default is 20 as recommended by
the specification.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

DEFAULT_RECENT_MESSAGE_WINDOW = 20


def recent_message_window() -> int:
    """Return the configured window size, validated to be a positive int."""
    raw: Any = getattr(settings, "CONTEXT_RECENT_MESSAGE_WINDOW", DEFAULT_RECENT_MESSAGE_WINDOW)
    try:
        return _validate_window(raw)
    except ValueError as exc:
        raise ImproperlyConfigured(
            f"CONTEXT_RECENT_MESSAGE_WINDOW must be a positive integer (got {raw!r})."
        ) from exc


def select_recent_messages(
    messages: Iterable[tuple[str, str]],
    *,
    limit: int | None = None,
) -> tuple[tuple[str, str], ...]:
    """Return the most recent ``limit`` messages in chronological order.

    ``messages`` is the full prior history of a session as ``(role,
    content)`` pairs in chronological order; any single-pass iterable is
    accepted. The returned tuple contains at most ``limit`` pairs taken from
    the tail, preserving their original order verbatim.

    ``limit=None`` (the default) resolves the configured window via
    :func:`recent_message_window`. An explicit ``limit`` must be a positive
    integer.
    """
    if limit is None:
        limit = recent_message_window()
    else:
        limit = _validate_window(limit)
    history = tuple(messages)
    return history[-limit:]


def _validate_window(value: Any) -> int:
    """Reject anything that is not a positive integer (bool included)."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Window size must be an integer (got {value!r}).")
    if value < 1:
        raise ValueError(f"Window size must be at least 1 (got {value!r}).")
    return value


__all__ = ["DEFAULT_RECENT_MESSAGE_WINDOW", "recent_message_window", "select_recent_messages"]
