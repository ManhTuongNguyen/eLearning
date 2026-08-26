"""Tests for the suggested-reply service (conversations.suggestions)."""

import json
from dataclasses import FrozenInstanceError

from django.test import SimpleTestCase

from conversations.suggestions import Suggestions, SuggestionService
from conversations.topics import GeneratedTopic
from learning.models import Level
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

SERVED_MODEL = "served/suggestion-model"

TOPIC = GeneratedTopic(
    title="Ordering coffee abroad",
    description="Role-play buying coffee in a busy cafe. Practise polite requests.",
)

VALID_PAYLOAD = {
    "replies": [
        "Could I get a flat white, please?",
        "Do you have any oat milk?",
        "Is there a loyalty card I can fill in?",
    ]
}


class FakeProvider(LLMProvider):
    """Fake provider returning one scripted outcome and recording requests."""

    def __init__(self, *, response: CompletionResponse | None = None, error=None) -> None:
        self.response = response
        self.error = error
        self.requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response

    def stream(self, request: CompletionRequest):
        raise AssertionError("suggestion generation never streams")


def make_response(text: str, model: str = SERVED_MODEL) -> CompletionResponse:
    return CompletionResponse(text=text, model=model)


def make_service(
    *, response: CompletionResponse | None = None, error=None
) -> tuple[SuggestionService, FakeProvider]:
    provider = FakeProvider(response=response, error=error)
    return SuggestionService(provider=provider), provider


def json_payload(payload: dict | list | str | int | None) -> str:
    return json.dumps(payload)


class SuggestionsTests(SimpleTestCase):
    """Shape of the structured suggestion result."""

    def test_suggestions_are_frozen(self) -> None:
        suggestions = Suggestions(replies=("a", "b", "c"))

        with self.assertRaises(FrozenInstanceError):
            suggestions.replies = ("x", "y", "z")  # type: ignore[misc]

    def test_wrong_count_is_rejected(self) -> None:
        for replies in ((), ("a",), ("a", "b"), ("a", "b", "c", "d")):
            with self.subTest(replies=replies):
                with self.assertRaises(ValueError):
                    Suggestions(replies=replies)

    def test_blank_reply_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Suggestions(replies=("a", "   ", "c"))

    def test_replies_compare_by_value(self) -> None:
        first = Suggestions(replies=("a", "b", "c"))
        same = Suggestions(replies=["a", "b", "c"])

        self.assertEqual(first, same)


class InputValidationTests(SimpleTestCase):
    """Bad service inputs are rejected before any provider call."""

    def make_called_service(self) -> tuple[SuggestionService, FakeProvider]:
        return make_service(response=make_response(json_payload(VALID_PAYLOAD)))

    def assert_no_provider_call(
        self,
        service: SuggestionService,
        provider: FakeProvider,
        call,
    ) -> None:
        with self.assertRaises(ValueError):
            call(service)
        self.assertEqual(provider.requests, [])

    def test_unknown_level_is_rejected_without_provider_call(self) -> None:
        for level in ("Z9", "b2", "", "auto"):
            with self.subTest(level=level):
                service, provider = self.make_called_service()

                self.assert_no_provider_call(
                    service,
                    provider,
                    lambda svc, level=level: svc.suggest(
                        level=level, topic=TOPIC, selected_message="Hi!"
                    ),
                )

    def test_non_generated_topic_is_rejected_without_provider_call(self) -> None:
        service, provider = self.make_called_service()

        self.assert_no_provider_call(
            service,
            provider,
            lambda svc: svc.suggest(
                level="B1",
                topic={"title": "t"},
                selected_message="Hi!",  # type: ignore[arg-type]
            ),
        )

    def test_blank_or_non_string_selected_message_is_rejected(self) -> None:
        for selected in ("", "   ", None, 42):
            with self.subTest(selected=selected):
                service, provider = self.make_called_service()

                self.assert_no_provider_call(
                    service,
                    provider,
                    lambda svc, selected=selected: svc.suggest(
                        level="B1", topic=TOPIC, selected_message=selected
                    ),
                )

    def test_invalid_history_entries_are_rejected_without_provider_call(self) -> None:
        bad_histories = (
            (("system", "hello"),),
            (("wizard", "hello"),),
            (("user", ""),),
            (("user", "   "),),
            (("user",),),
            ("not-a-pair",),
        )
        for history in bad_histories:
            with self.subTest(history=history):
                service, provider = self.make_called_service()

                self.assert_no_provider_call(
                    service,
                    provider,
                    lambda svc, history=history: svc.suggest(
                        level="B1",
                        topic=TOPIC,
                        selected_message="Hi!",
                        history=history,
                    ),
                )


class HappyPathTests(SimpleTestCase):
    """Successful generations return exactly three validated replies."""

    def setUp(self) -> None:
        self.service, self.provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )

    def suggest_default(self, **overrides):
        kwargs = {"level": "B1", "topic": TOPIC, "selected_message": "Could I have a coffee?"}
        kwargs.update(overrides)
        return self.service.suggest(**kwargs)

    def test_valid_output_returns_exactly_three_stripped_replies(self) -> None:
        padded = {
            "replies": ["  First reply. ", "\nSecond reply.\t", "Third reply."],
        }
        self.provider.response = make_response(json_payload(padded))

        suggestions = self.suggest_default()

        self.assertEqual(suggestions.replies, ("First reply.", "Second reply.", "Third reply."))

    def test_all_levels_are_accepted(self) -> None:
        for level in Level.values:
            with self.subTest(level=level):
                suggestions = self.service.suggest(
                    level=level, topic=TOPIC, selected_message="Hello!"
                )

                self.assertEqual(len(suggestions.replies), 3)

    def test_empty_history_is_allowed(self) -> None:
        suggestions = self.suggest_default(history=())

        self.assertEqual(len(suggestions.replies), 3)

    def test_request_contains_exactly_one_system_and_one_user_message(self) -> None:
        self.suggest_default()

        [request] = self.provider.requests
        self.assertEqual([message.role for message in request.messages], ["system", "user"])
        for message in request.messages:
            self.assertTrue(message.content.strip())

    def test_system_prompt_demands_json_with_three_replies(self) -> None:
        self.suggest_default()

        system_content = self.provider.requests[0].messages[0].content
        self.assertIn("JSON", system_content)
        self.assertIn("replies", system_content)
        self.assertIn("three", system_content)

    def test_topic_title_and_scenario_shape_the_user_prompt(self) -> None:
        self.suggest_default()

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn(TOPIC.title, user_content)
        self.assertIn(TOPIC.description, user_content)

    def test_concrete_level_is_echoed_into_the_user_prompt(self) -> None:
        self.suggest_default(level="B2")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("B2", user_content)
        self.assertNotIn("unknown", user_content)

    def test_auto_level_asks_for_accessible_language(self) -> None:
        self.suggest_default(level=Level.AUTO)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("unknown", user_content)
        self.assertNotIn("(CEFR)", user_content)

    def test_history_becomes_a_transcript_and_selected_message_is_marked(self) -> None:
        history = (
            ("assistant", "Welcome! What would you like to order?"),
            ("user", "One latte, please."),
            ("assistant", "Great choice — anything to eat with that?"),
        )

        selected = "Great choice — anything to eat with that?"

        self.suggest_default(history=history, selected_message=selected)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn(f"Tutor: {history[0][1]}", user_content)
        self.assertIn(f"Learner: {history[1][1]}", user_content)
        self.assertIn(f"Tutor: {history[2][1]}", user_content)
        self.assertIn("long-pressed this message", user_content)
        self.assertIn(selected, user_content)

    def test_distinct_histories_produce_distinct_prompts(self) -> None:
        self.suggest_default(history=(("assistant", "Hello there!"),))
        first_prompt = self.provider.requests[0].messages[-1].content

        self.suggest_default(history=(("assistant", "Good morning!"),))
        second_prompt = self.provider.requests[-1].messages[-1].content

        self.assertNotEqual(first_prompt, second_prompt)
        self.assertIn("Good morning!", second_prompt)

    def test_fenced_json_output_is_parsed(self) -> None:
        fenced = "```json\n" + json.dumps(VALID_PAYLOAD) + "\n```"
        self.provider.response = make_response(fenced)

        suggestions = self.suggest_default()

        self.assertEqual(suggestions.replies, tuple(VALID_PAYLOAD["replies"]))

    def test_prose_wrapped_json_is_parsed(self) -> None:
        wrapped = f"Here are your suggestions:\n{json.dumps(VALID_PAYLOAD)}\nPick one!"
        self.provider.response = make_response(wrapped)

        suggestions = self.suggest_default()

        self.assertEqual(suggestions.replies, tuple(VALID_PAYLOAD["replies"]))

    def test_extra_json_keys_are_ignored(self) -> None:
        payload = {**VALID_PAYLOAD, "tone": "polite", "confidence": 0.8}
        self.provider.response = make_response(json_payload(payload))

        suggestions = self.suggest_default()

        self.assertEqual(suggestions.replies, tuple(VALID_PAYLOAD["replies"]))


class InvalidOutputTests(SimpleTestCase):
    """Malformed completions normalize into attributed response errors."""

    INVALID_OUTPUTS = (
        "plain prose without any braces",
        json_payload(["one", "two", "three"]),
        json_payload("just a string"),
        json_payload(42),
        json_payload(None),
        '{"replies": ["a", "b"',
        "{",
        "",
        "   ",
        "{}",
        json_payload({"suggestions": ["a", "b", "c"]}),
        json_payload({"replies": ["a", "b"]}),
        json_payload({"replies": ["a", "b", "c", "d"]}),
        json_payload({"replies": ["a"]}),
        json_payload({"replies": []}),
        json_payload({"replies": ["a", "b", ""]}),
        json_payload({"replies": ["a", "b", "   "]}),
        json_payload({"replies": ["a", "b", None]}),
        json_payload({"replies": ["a", "b", 42]}),
        json_payload({"replies": ["same text", "same text", "same text"]}),
        json_payload({"replies": ["Same Text.", "same text.", "SAME TEXT."]}),
        "```python\ndef broken(): pass\n```",
        "{not valid json at all}",
    )

    def test_invalid_outputs_raise_normalized_response_error(self) -> None:
        for output in self.INVALID_OUTPUTS:
            with self.subTest(output=output[:40]):
                service, _ = make_service(response=make_response(output))

                with self.assertRaises(LLMResponseError) as caught:
                    service.suggest(
                        level="B1", topic=TOPIC, selected_message="Could I have a coffee?"
                    )

                error = caught.exception
                self.assertFalse(error.retryable)
                self.assertEqual(error.provider, "suggestions")

    def test_error_carries_the_served_model(self) -> None:
        service, _ = make_service(response=make_response("garbage", model="fallback/secondary"))

        with self.assertRaises(LLMResponseError) as caught:
            service.suggest(level="A2", topic=TOPIC, selected_message="Hi!")

        self.assertEqual(caught.exception.model, "fallback/secondary")


class ProviderFailureTests(SimpleTestCase):
    """Provider failures propagate unchanged; parsing never masks them."""

    def test_retryable_availability_error_passes_through_identically(self) -> None:
        original = LLMAvailabilityError("capacity exceeded", model="primary/a")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAvailabilityError) as caught:
            service.suggest(level="B1", topic=TOPIC, selected_message="Hi!")

        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.retryable)

    def test_authentication_error_passes_through_identically(self) -> None:
        original = LLMAuthenticationError("bad key")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAuthenticationError) as caught:
            service.suggest(level="B1", topic=TOPIC, selected_message="Hi!")

        self.assertIs(caught.exception, original)

    def test_non_llm_errors_propagate_unmasked(self) -> None:
        service, _ = make_service(error=ValueError("programming bug"))

        with self.assertRaises(ValueError) as caught:
            service.suggest(level="B1", topic=TOPIC, selected_message="Hi!")

        self.assertEqual(str(caught.exception), "programming bug")


class LoggingHygieneTests(SimpleTestCase):
    """Payload text is never logged; only models and durations are."""

    def test_success_log_names_model_but_not_payload(self) -> None:
        service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

        with self.assertLogs("conversations.suggestions", level="INFO") as captured:
            service.suggest(level="B1", topic=TOPIC, selected_message="Could I have a coffee?")

        joined = "\n".join(captured.output)
        self.assertIn(SERVED_MODEL, joined)
        for reply in VALID_PAYLOAD["replies"]:
            self.assertNotIn(reply, joined)

    def test_failure_log_contains_normalized_error_but_not_payload(self) -> None:
        leaky = '{"replies": ["SECRET-SUGGESTION-PAYLOAD", "b"'  # malformed JSON
        service, _ = make_service(response=make_response(leaky))

        with self.assertLogs("conversations.suggestions", level="WARNING") as captured:
            with self.assertRaises(LLMResponseError):
                service.suggest(level="B1", topic=TOPIC, selected_message="Could I have a coffee?")

        joined = "\n".join(captured.output)
        self.assertIn("suggestions", joined)
        self.assertNotIn("SECRET-SUGGESTION-PAYLOAD", joined)
