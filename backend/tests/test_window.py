"""Tests for recent-message window selection (conversations.window)."""

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings

from conversations.context import ContextBuilder
from conversations.topics import GeneratedTopic
from conversations.window import (
    DEFAULT_RECENT_MESSAGE_WINDOW,
    recent_message_window,
    select_recent_messages,
)

TOPIC = GeneratedTopic(
    title="Ordering coffee abroad",
    description="Role-play buying coffee in a busy cafe. Practise polite requests.",
)


def transcript(count: int) -> list[tuple[str, str]]:
    """A chronological chat transcript alternating turns, assistant first
    (ROADMAP section 6: the session begins with an AI message)."""
    return [("assistant" if (i - 1) % 2 == 0 else "user", f"turn {i}") for i in range(1, count + 1)]


class WindowConfigurationTests(SimpleTestCase):
    """Resolution and validation of the configured window size."""

    def test_recommended_default_is_20(self) -> None:
        self.assertEqual(DEFAULT_RECENT_MESSAGE_WINDOW, 20)

    def test_reads_configured_setting(self) -> None:
        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=7):
            self.assertEqual(recent_message_window(), 7)

    def test_falls_back_to_default_when_setting_absent(self) -> None:
        with override_settings():
            del settings.CONTEXT_RECENT_MESSAGE_WINDOW
            self.assertEqual(recent_message_window(), DEFAULT_RECENT_MESSAGE_WINDOW)

    def test_boundary_value_one_accepted(self) -> None:
        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=1):
            self.assertEqual(recent_message_window(), 1)

    def test_large_values_accepted(self) -> None:
        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=10_000):
            self.assertEqual(recent_message_window(), 10_000)

    def test_invalid_configured_matrix_names_the_variable(self) -> None:
        for bad in (0, -3, "20", "many", None, 2.5, True):
            with self.subTest(bad=bad):
                with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=bad):
                    with self.assertRaises(ImproperlyConfigured) as ctx:
                        recent_message_window()
            self.assertIn("CONTEXT_RECENT_MESSAGE_WINDOW", str(ctx.exception))


class SelectionTests(SimpleTestCase):
    """Tail selection semantics with an explicit limit (settings-free)."""

    def test_more_than_limit_returns_exactly_the_last_turns_in_order(self) -> None:
        history = transcript(40)
        selected = select_recent_messages(history, limit=20)
        self.assertEqual(len(selected), 20)
        self.assertEqual(selected, tuple(history[-20:]))

    def test_selection_preserves_chronological_order(self) -> None:
        history = transcript(30)
        contents = [content for _, content in select_recent_messages(history, limit=5)]
        self.assertEqual(contents, ["turn 26", "turn 27", "turn 28", "turn 29", "turn 30"])

    def test_earlier_messages_never_leak_into_selection(self) -> None:
        history = transcript(30)
        contents = [content for _, content in select_recent_messages(history, limit=5)]
        for archived in range(1, 26):
            self.assertNotIn(f"turn {archived}", contents)

    def test_history_exactly_limit_returns_everything(self) -> None:
        history = transcript(20)
        self.assertEqual(select_recent_messages(history, limit=20), tuple(history))

    def test_history_shorter_than_limit_returns_all_unchanged(self) -> None:
        history = transcript(3)
        self.assertEqual(select_recent_messages(history, limit=20), tuple(history))

    def test_empty_history_yields_empty_tuple(self) -> None:
        self.assertEqual(select_recent_messages([], limit=4), ())
        self.assertEqual(select_recent_messages(iter(()), limit=4), ())

    def test_single_pass_iterables_accepted(self) -> None:
        selected = select_recent_messages(iter(transcript(10)), limit=3)
        self.assertEqual([content for _, content in selected], ["turn 8", "turn 9", "turn 10"])

    def test_pairs_pass_through_verbatim_without_stripping_or_reordering(self) -> None:
        history = [("assistant", "  Padded greeting.  "), ("user", "later")]
        self.assertEqual(select_recent_messages(history, limit=2), tuple(history))

    def test_result_is_a_tuple(self) -> None:
        self.assertIsInstance(select_recent_messages(transcript(2), limit=1), tuple)

    def test_invalid_explicit_limit_matrix(self) -> None:
        for bad in (0, -1, "5", 1.5, True, [5]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    select_recent_messages(transcript(3), limit=bad)

    def test_none_limit_resolves_configuration(self) -> None:
        history = transcript(6)
        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=2):
            selected = select_recent_messages(history)
        self.assertEqual([content for _, content in selected], ["turn 5", "turn 6"])

    def test_configured_zero_is_rejected_not_whole_sequence_footgun(self) -> None:
        # Guards Python's seq[-0:] == whole-sequence behaviour.
        with (
            override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=0),
            self.assertRaises(ImproperlyConfigured),
        ):
            select_recent_messages(transcript(4))


class CompositionTests(SimpleTestCase):
    """End-to-end contract with ContextBuilder (acceptance criteria)."""

    def build_with_window(self, history, *, window, current="  Please continue.  ", **kwargs):
        with override_settings(CONTEXT_RECENT_MESSAGE_WINDOW=window):
            selected = select_recent_messages(history)
        return ContextBuilder().build(
            level="B2",
            topic=TOPIC,
            summary="",
            recent_messages=selected,
            current_message=current,
            **kwargs,
        )

    def test_long_conversation_context_is_bounded_and_ordered(self) -> None:
        history = transcript(40)
        request = self.build_with_window(history, window=20)
        messages = request.messages
        self.assertEqual(len(messages), 22)
        self.assertEqual(messages[0].role, "system")
        self.assertEqual([m.content for m in messages[1:-1]], [f"turn {i}" for i in range(21, 41)])

    def test_roles_of_windowed_history_are_verbatim(self) -> None:
        history = transcript(40)
        request = self.build_with_window(history, window=20)
        self.assertEqual(
            [(m.role, m.content) for m in request.messages[1:-1]],
            [tuple(pair) for pair in history[-20:]],
        )

    def test_archived_head_of_conversation_is_absent_from_context(self) -> None:
        request = self.build_with_window(transcript(40), window=20)
        contents = [m.content for m in request.messages]
        for archived in range(1, 21):
            self.assertNotIn(f"turn {archived}", contents)

    def test_current_message_is_last_stripped_and_not_duplicated(self) -> None:
        history = transcript(40)
        request = self.build_with_window(history, window=20, current="  sentinel now  ")
        last = request.messages[-1]
        self.assertEqual((last.role, last.content), ("user", "sentinel now"))
        all_contents = [m.content for m in request.messages]
        self.assertEqual(all_contents.count("sentinel now"), 1)

    def test_current_message_survives_even_when_window_is_tiny(self) -> None:
        request = self.build_with_window(transcript(40), window=1, current="now")
        history_part = request.messages[1:-1]
        self.assertEqual(len(history_part), 1)
        self.assertEqual(history_part[0].content, "turn 40")
        self.assertEqual(request.messages[-1].content, "now")

    def test_short_conversation_fully_included_when_under_window(self) -> None:
        request = self.build_with_window(transcript(5), window=20)
        self.assertEqual(
            [(m.role, m.content) for m in request.messages[1:-1]],
            [tuple(pair) for pair in transcript(5)],
        )
