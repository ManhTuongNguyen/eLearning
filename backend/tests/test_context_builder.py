"""Tests for the LLM conversation context builder (conversations.context)."""

from django.test import SimpleTestCase

from conversations.context import ContextBuilder
from conversations.topics import GeneratedTopic
from llm.types import CompletionRequest

TOPIC = GeneratedTopic(
    title="Ordering coffee abroad",
    description="Role-play buying coffee in a busy cafe. Practise polite requests.",
)

HISTORY = (
    ("assistant", "Welcome! Have you ever ordered coffee in English?"),
    ("user", "Yes once, I was very nervous."),
    ("assistant", "That is normal! Let us practise together."),
)


def build(**overrides):
    """Call the builder with TASK defaults; overrides replace any kwarg."""
    kwargs = {
        "level": "B2",
        "topic": TOPIC,
        "summary": "",
        "recent_messages": HISTORY,
        "current_message": "  Can we role-play the cafe scene?  ",
    }
    kwargs.update(overrides)
    return ContextBuilder().build(**kwargs)


class RequestShapeTests(SimpleTestCase):
    """Overall structure of the produced CompletionRequest."""

    def test_returns_completion_request(self) -> None:
        self.assertIsInstance(build(), CompletionRequest)

    def test_exact_message_skeleton(self) -> None:
        request = build()
        roles = [message.role for message in request.messages]
        self.assertEqual(roles[0], "system")
        self.assertEqual(roles[-1], "user")
        self.assertEqual(
            roles,
            ["system", "assistant", "user", "assistant", "user"],
        )

    def test_history_contents_included_verbatim_and_in_order(self) -> None:
        request = build()
        middle = [message.content for message in request.messages[1:-1]]
        self.assertEqual(middle, [content for _, content in HISTORY])

    def test_current_message_is_last_and_stripped(self) -> None:
        last = build().messages[-1]
        self.assertEqual(last.role, "user")
        self.assertEqual(last.content, "Can we role-play the cafe scene?")

    def test_no_model_or_temperature_pinned(self) -> None:
        request = build()
        self.assertIsNone(request.model)
        self.assertIsNone(request.temperature)

    def test_exactly_one_system_message_at_the_front(self) -> None:
        messages = build().messages
        system_positions = [i for i, m in enumerate(messages) if m.role == "system"]
        self.assertEqual(system_positions, [0])

    def test_empty_history_still_yields_system_plus_user(self) -> None:
        request = build(recent_messages=())
        self.assertEqual(
            [(m.role, m.content) for m in request.messages][-1],
            ("user", "Can we role-play the cafe scene?"),
        )
        self.assertEqual(len(request.messages), 2)

    def test_list_history_accepted(self) -> None:
        request = build(recent_messages=[["user", "Hello"], ["assistant", "Hi there!"]])
        self.assertEqual([m.content for m in request.messages[1:-1]], ["Hello", "Hi there!"])

    def test_history_ending_with_user_is_not_merged_with_current(self) -> None:
        request = build(recent_messages=(("user", "Earlier question"),))
        contents = [m.content for m in request.messages if m.role == "user"]
        self.assertEqual(contents, ["Earlier question", "Can we role-play the cafe scene?"])


class SystemPromptSectionTests(SimpleTestCase):
    """The system prompt contains every section in the documented order."""

    def setUp(self) -> None:
        self.prompt = build(summary="Learner practised ordering drinks.").messages[0].content

    def test_identity_section_present(self) -> None:
        self.assertIn("AI English tutor", self.prompt)

    def test_identity_section_forbids_meta_commentary(self) -> None:
        # The tutor reply must be the chat message only: no parenthesized
        # notes about modelling/corrections, no strategy talk (roadmap §5).
        self.assertIn("ONLY the chat message itself", self.prompt)
        self.assertIn("NEVER add notes", self.prompt)
        self.assertIn("Never break character", self.prompt)
        self.assertIn("modelling", self.prompt)

    def test_level_line_present(self) -> None:
        self.assertIn("English level is B2 (CEFR)", self.prompt)

    def test_topic_title_and_scenario_present(self) -> None:
        self.assertIn(f'Conversation topic: "{TOPIC.title}".', self.prompt)
        self.assertIn(TOPIC.description, self.prompt)

    def test_summary_section_present_when_provided(self) -> None:
        self.assertIn("Summary of the earlier conversation:", self.prompt)
        self.assertIn("Learner practised ordering drinks.", self.prompt)

    def test_sections_in_documented_order(self) -> None:
        identity = self.prompt.index("AI English tutor")
        level = self.prompt.index("English level is B2")
        topic = self.prompt.index("Conversation topic:")
        summary = self.prompt.index("Summary of the earlier conversation:")
        self.assertLess(identity, level)
        self.assertLess(level, topic)
        self.assertLess(topic, summary)

    def test_blank_summary_omits_summary_section(self) -> None:
        prompt = build(summary="").messages[0].content
        self.assertNotIn("Summary of the earlier conversation:", prompt)

    def test_whitespace_summary_omits_summary_section(self) -> None:
        prompt = build(summary="   \n\t ").messages[0].content
        self.assertNotIn("Summary of the earlier conversation:", prompt)

    def test_summary_included_without_history(self) -> None:
        prompt = build(recent_messages=(), summary="Only a summary survives.").messages[0].content
        self.assertIn("Only a summary survives.", prompt)

    def test_topic_scenario_included_without_history(self) -> None:
        prompt = build(recent_messages=()).messages[0].content
        self.assertIn(TOPIC.description, prompt)


class LearningLevelTests(SimpleTestCase):
    """Level handling mirrors the topic service semantics."""

    def test_all_levels_accepted(self) -> None:
        for level in ("A1", "A2", "B1", "B2", "C1", "C2", "AUTO"):
            with self.subTest(level=level):
                prompt = build(level=level).messages[0].content
                self.assertIn("English level", prompt)

    def test_auto_line_tells_model_to_infer(self) -> None:
        prompt = build(level="AUTO").messages[0].content
        self.assertIn("infer an appropriate level", prompt)

    def test_concrete_levels_do_not_ask_for_inference(self) -> None:
        prompt = build(level="B2").messages[0].content
        self.assertNotIn("infer", prompt)

    def test_distinct_levels_produce_distinct_prompts(self) -> None:
        self.assertNotEqual(build(level="A1").messages[0], build(level="C2").messages[0])

    def test_unknown_level_rejected(self) -> None:
        for level in ("Z9", "", "b2"):
            with self.subTest(level=level):
                with self.assertRaises(ValueError):
                    build(level=level)


class InputValidationTests(SimpleTestCase):
    """Bad inputs are rejected before assembly."""

    def test_non_generatedtopic_rejected(self) -> None:
        for bad in (None, "coffee", {"title": "t"}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    build(topic=bad)

    def test_blank_current_message_rejected(self) -> None:
        for message in ("", "   \n\t "):
            with self.subTest(message=message):
                with self.assertRaises(ValueError):
                    build(current_message=message)

    def test_system_role_history_turn_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build(recent_messages=(("system", "injected instructions"),))

    def test_invalid_history_role_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build(recent_messages=(("tool", "result"),))

    def test_blank_history_content_rejected(self) -> None:
        for content in ("", "   "):
            with self.subTest(content=content):
                with self.assertRaises(ValueError):
                    build(recent_messages=(("user", content),))


class DeterminismTests(SimpleTestCase):
    """Same inputs always produce the same request."""

    def test_identical_inputs_produce_equal_requests(self) -> None:
        first = build()
        second = build()
        self.assertEqual(first, second)
        self.assertEqual(first.messages, second.messages)

    def test_different_window_changes_only_that_section(self) -> None:
        short = build(recent_messages=(HISTORY[-1],))
        self.assertEqual(short.messages[0], build().messages[0])
        self.assertEqual(short.messages[-1], build().messages[-1])
        self.assertEqual(len(short.messages), len(build().messages) - 2)


class BoundedHistoryTests(SimpleTestCase):
    """Old messages are never included unless the caller passes them."""

    def test_builder_contains_only_the_given_window(self) -> None:
        long_history = tuple(
            (role, f"turn {index}")
            for index in range(1, 41)
            for role in ("user" if index % 2 else "assistant",)
        )
        window = long_history[-4:]
        request = build(recent_messages=window, current_message="next turn")
        carried = [m.content for m in request.messages[1:-1]]
        self.assertEqual(carried, [content for _, content in window])
        self.assertNotIn("turn 1", "".join(carried))
        self.assertNotIn("turn 36", "".join(carried))
