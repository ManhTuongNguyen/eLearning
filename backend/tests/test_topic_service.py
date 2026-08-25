"""Tests for the conversation topic generation service (conversations.topics)."""

import json
from dataclasses import FrozenInstanceError

from django.test import SimpleTestCase

from conversations.topics import GeneratedTopic, TopicGenerationService
from learning.models import Level
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

SERVED_MODEL = "served/topic-model"

VALID_PAYLOAD = {
    "title": "Ordering coffee abroad",
    "description": "Role-play buying coffee in a busy cafe. Practise polite requests.",
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
        raise AssertionError("topic generation never streams")


def make_response(text: str, model: str = SERVED_MODEL) -> CompletionResponse:
    return CompletionResponse(text=text, model=model)


def make_service(
    *, response: CompletionResponse | None = None, error=None
) -> tuple[TopicGenerationService, FakeProvider]:
    provider = FakeProvider(response=response, error=error)
    return TopicGenerationService(provider=provider), provider


def json_payload(payload: dict | list | str | int | None) -> str:
    return json.dumps(payload)


class GeneratedTopicTests(SimpleTestCase):
    """Shape of the structured topic result."""

    def test_topic_is_frozen(self) -> None:
        topic = GeneratedTopic(title="t", description="d")

        with self.assertRaises(FrozenInstanceError):
            topic.title = "mutated"  # type: ignore[misc]

    def test_topics_compare_by_value(self) -> None:
        first = GeneratedTopic(title="t", description="d")
        same = GeneratedTopic(title="t", description="d")
        other = GeneratedTopic(title="x", description="d")

        self.assertEqual(first, same)
        self.assertNotEqual(first, other)


class InputValidationTests(SimpleTestCase):
    """Bad service inputs are rejected before any provider call."""

    def test_unknown_level_is_rejected_without_provider_call(self) -> None:
        for level in ("Z9", "b2", "", "auto"):
            with self.subTest(level=level):
                service, provider = make_service(response=make_response("{}"))

                with self.assertRaises(ValueError):
                    service.generate(level=level)

                self.assertEqual(provider.requests, [])

    def test_level_values_are_all_accepted(self) -> None:
        for level in Level.values:
            with self.subTest(level=level):
                service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

                topic = service.generate(level=level)

                self.assertEqual(topic.title, VALID_PAYLOAD["title"])

    def test_whitespace_only_hint_behaves_like_empty_hint(self) -> None:
        blank_service, blank_provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )
        spaced_service, spaced_provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )

        blank_service.generate(level="B1")
        spaced_service.generate(level="B1", hint="   \n\t ")

        self.assertEqual(
            blank_provider.requests[0].messages,
            spaced_provider.requests[0].messages,
        )


class HappyPathTests(SimpleTestCase):
    """Successful generations return structured topics."""

    def setUp(self) -> None:
        self.service, self.provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )

    def test_empty_hint_generates_a_topic(self) -> None:
        topic = self.service.generate(level="B1")

        self.assertEqual(topic.title, VALID_PAYLOAD["title"])
        self.assertEqual(topic.description, VALID_PAYLOAD["description"])

    def test_parsed_values_are_stripped(self) -> None:
        padded = {"title": "  Spaced title \n", "description": "\t Spaced description "}
        self.provider.response = make_response(json_payload(padded))

        topic = self.service.generate(level="A2")

        self.assertEqual(topic.title, "Spaced title")
        self.assertEqual(topic.description, "Spaced description")

    def test_extra_json_keys_are_ignored(self) -> None:
        payload = {**VALID_PAYLOAD, "vocabulary_focus": ["modal verbs"], "difficulty": 3}
        self.provider.response = make_response(json_payload(payload))

        topic = self.service.generate(level="B2")

        self.assertEqual(topic.title, VALID_PAYLOAD["title"])

    def test_fenced_json_output_is_parsed(self) -> None:
        fenced = "```json\n" + json.dumps(VALID_PAYLOAD) + "\n```"
        self.provider.response = make_response(fenced)

        topic = self.service.generate(level="A1")

        self.assertEqual(topic.title, VALID_PAYLOAD["title"])

    def test_prose_wrapped_json_is_parsed(self) -> None:
        wrapped = f"Here is your topic:\n{json.dumps(VALID_PAYLOAD)}\nHave fun!"
        self.provider.response = make_response(wrapped)

        topic = self.service.generate(level="C1")

        self.assertEqual(topic.description, VALID_PAYLOAD["description"])

    def test_request_contains_exactly_one_system_and_one_user_message(self) -> None:
        self.service.generate(level="B1")

        [request] = self.provider.requests
        self.assertEqual([message.role for message in request.messages], ["system", "user"])
        for message in request.messages:
            self.assertTrue(message.content.strip())

    def test_system_prompt_demands_json_with_required_fields(self) -> None:
        self.service.generate(level="B1")

        system_content = self.provider.requests[0].messages[0].content
        self.assertIn("JSON", system_content)
        for field in ("title", "description"):
            self.assertIn(field, system_content)

    def test_concrete_level_is_echoed_into_the_user_prompt(self) -> None:
        self.service.generate(level="B2")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("B2", user_content)
        self.assertNotIn("infer", user_content.lower())

    def test_auto_level_asks_the_model_to_infer(self) -> None:
        self.service.generate(level=Level.AUTO)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("infer", user_content.lower())
        self.assertNotIn("(CEFR)", user_content)

    def test_hint_influences_the_user_prompt(self) -> None:
        hint = "traveling by night train through Europe"

        self.service.generate(level="B1", hint=hint)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn(hint, user_content)
        self.assertNotIn("gave no preference", user_content)

    def test_distinct_hints_produce_distinct_prompts(self) -> None:
        self.service.generate(level="B1", hint="cooking at home")

        first_prompt = self.provider.requests[0].messages[-1].content
        self.service.generate(level="B1", hint="job interviews")
        second_prompt = self.provider.requests[-1].messages[-1].content

        self.assertNotEqual(first_prompt, second_prompt)
        self.assertIn("job interviews", second_prompt)


class InvalidOutputTests(SimpleTestCase):
    """Malformed completions normalize into attributed response errors."""

    INVALID_OUTPUTS = (
        "plain prose without any braces",
        json_payload([VALID_PAYLOAD]),
        json_payload("just a string"),
        json_payload(42),
        json_payload(None),
        '{"title": "Only title"',
        "{",
        "",
        "   ",
        "{}",
        json_payload({"description": "no title here"}),
        json_payload({"title": "no description"}),
        json_payload({"title": 123, "description": "numeric title"}),
        json_payload({"title": True, "description": "boolean title"}),
        json_payload({"title": None, "description": "null title"}),
        json_payload({"title": "   ", "description": "blank title"}),
        json_payload({"title": "ok", "description": "   "}),
        json_payload({"title": "ok", "description": ""}),
        "```python\ndef broken(): pass\n```",
        "{not valid json at all}",
    )

    def test_invalid_outputs_raise_normalized_response_error(self) -> None:
        for output in self.INVALID_OUTPUTS:
            with self.subTest(output=output[:40]):
                service, provider = make_service(response=make_response(output))

                with self.assertRaises(LLMResponseError) as caught:
                    service.generate(level="B1")

                error = caught.exception
                self.assertFalse(error.retryable)
                self.assertEqual(error.provider, "topics")
                self.assertEqual(provider.requests[0], service.provider.requests[0])

    def test_error_carries_the_served_model(self) -> None:
        service, _ = make_service(response=make_response("garbage", model="fallback/secondary"))

        with self.assertRaises(LLMResponseError) as caught:
            service.generate(level="A2")

        self.assertEqual(caught.exception.model, "fallback/secondary")


class ProviderFailureTests(SimpleTestCase):
    """Provider failures propagate unchanged; parsing never masks them."""

    def test_retryable_availability_error_passes_through_identically(self) -> None:
        original = LLMAvailabilityError("capacity exceeded", model="primary/a")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAvailabilityError) as caught:
            service.generate(level="B1")

        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.retryable)

    def test_authentication_error_passes_through_identically(self) -> None:
        original = LLMAuthenticationError("bad key")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAuthenticationError) as caught:
            service.generate(level="B1")

        self.assertIs(caught.exception, original)

    def test_non_llm_errors_propagate_unmasked(self) -> None:
        service, _ = make_service(error=ValueError("programming bug"))

        with self.assertRaises(ValueError) as caught:
            service.generate(level="B1")

        self.assertEqual(str(caught.exception), "programming bug")


class LoggingHygieneTests(SimpleTestCase):
    """Payload text is never logged; only models and durations are."""

    def test_success_log_names_model_but_not_payload(self) -> None:
        service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

        with self.assertLogs("conversations.topics", level="INFO") as captured:
            service.generate(level="B1")

        joined = "\n".join(captured.output)
        self.assertIn(SERVED_MODEL, joined)
        self.assertNotIn(VALID_PAYLOAD["title"], joined)
        self.assertNotIn(VALID_PAYLOAD["description"], joined)

    def test_failure_log_contains_normalized_error_but_not_payload(self) -> None:
        leaky = '{"title": "ok", "description": "SECRET-TOPIC-PAYLOAD"'  # malformed JSON
        service, _ = make_service(response=make_response(leaky))

        with self.assertLogs("conversations.topics", level="WARNING") as captured:
            with self.assertRaises(LLMResponseError):
                service.generate(level="B1")

        joined = "\n".join(captured.output)
        self.assertIn("topics", joined)
        self.assertNotIn("SECRET-TOPIC-PAYLOAD", joined)
