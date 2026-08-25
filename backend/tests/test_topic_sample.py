"""Tests for sample-conversation generation (conversations.topics)."""

import json
from dataclasses import FrozenInstanceError, asdict

from django.test import SimpleTestCase

from conversations.models import Message
from conversations.topics import (
    GeneratedTopic,
    SampleConversation,
    SampleTurn,
    TopicGenerationService,
)
from learning.models import Level
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

SERVED_MODEL = "served/sample-model"

TOPIC = GeneratedTopic(
    title="Night trains through Europe",
    description="Discuss travelling overnight by train: routes, sleeping cars, "
    "and whether the journey beats flying.",
)

VALID_PAYLOAD = {
    "turns": [
        {"role": "assistant", "content": "Hello! Have you ever travelled by night train?"},
        {"role": "user", "content": "Yes, once. I went from Berlin to Vienna."},
        {"role": "assistant", "content": "That sounds exciting! What was the journey like?"},
        {"role": "user", "content": "It was long, but I slept quite well."},
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
        raise AssertionError("sample conversation generation never streams")


def make_response(text: str, model: str = SERVED_MODEL) -> CompletionResponse:
    return CompletionResponse(text=text, model=model)


def make_service(
    *, response: CompletionResponse | None = None, error=None
) -> tuple[TopicGenerationService, FakeProvider]:
    provider = FakeProvider(response=response, error=error)
    return TopicGenerationService(provider=provider), provider


def json_payload(payload: dict | list | str | int | None) -> str:
    return json.dumps(payload)


class SampleTurnTests(SimpleTestCase):
    """Shape of one sample dialogue line."""

    def test_turn_is_frozen(self) -> None:
        turn = SampleTurn(role=Message.Role.USER, content="Hi")

        with self.assertRaises(FrozenInstanceError):
            turn.content = "mutated"  # type: ignore[misc]

    def test_both_chat_roles_are_accepted(self) -> None:
        for role in (Message.Role.USER, Message.Role.ASSISTANT):
            with self.subTest(role=role):
                self.assertEqual(SampleTurn(role=role, content="x").role, role)

    def test_invalid_role_is_rejected(self) -> None:
        for role in ("system", "moderator", "User", ""):
            with self.subTest(role=role):
                with self.assertRaises(ValueError):
                    SampleTurn(role=role, content="x")

    def test_blank_content_is_rejected(self) -> None:
        for content in ("", "   \n\t"):
            with self.subTest(content=repr(content)):
                with self.assertRaises(ValueError):
                    SampleTurn(role=Message.Role.USER, content=content)


class SampleConversationTests(SimpleTestCase):
    """Shape of the structured sample conversation result."""

    def make_turns(self, count: int) -> list[SampleTurn]:
        roles = [Message.Role.ASSISTANT, Message.Role.USER]
        return [
            SampleTurn(role=roles[index % 2], content=f"line {index}") for index in range(count)
        ]

    def test_conversation_is_frozen(self) -> None:
        conversation = SampleConversation(turns=self.make_turns(2))

        with self.assertRaises(FrozenInstanceError):
            conversation.turns = ()  # type: ignore[misc]

    def test_turns_are_normalized_to_a_tuple(self) -> None:
        turns_list = self.make_turns(3)

        conversation = SampleConversation(turns=turns_list)

        self.assertIsInstance(conversation.turns, tuple)
        self.assertEqual(conversation.turns, tuple(turns_list))

    def test_fewer_than_two_turns_are_rejected(self) -> None:
        for count in (0, 1):
            with self.subTest(count=count):
                with self.assertRaises(ValueError):
                    SampleConversation(turns=self.make_turns(count))


class InputValidationTests(SimpleTestCase):
    """Bad service inputs are rejected before any provider call."""

    def test_unknown_level_is_rejected_without_provider_call(self) -> None:
        for level in ("Z9", "b2", "", "auto"):
            with self.subTest(level=level):
                service, provider = make_service(
                    response=make_response(json_payload(VALID_PAYLOAD))
                )

                with self.assertRaises(ValueError):
                    service.generate_sample(topic=TOPIC, level=level)

                self.assertEqual(provider.requests, [])

    def test_non_topic_argument_is_rejected_without_provider_call(self) -> None:
        for bad_topic in (None, "night trains", {"title": "t"}, VALID_PAYLOAD):
            with self.subTest(bad_topic=type(bad_topic).__name__):
                service, provider = make_service(
                    response=make_response(json_payload(VALID_PAYLOAD))
                )

                with self.assertRaises(ValueError):
                    service.generate_sample(topic=bad_topic, level="B1")  # type: ignore[arg-type]

                self.assertEqual(provider.requests, [])

    def test_level_values_are_all_accepted(self) -> None:
        for level in Level.values:
            with self.subTest(level=level):
                service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

                sample = service.generate_sample(topic=TOPIC, level=level)

                self.assertEqual(len(sample.turns), len(VALID_PAYLOAD["turns"]))


class HappyPathTests(SimpleTestCase):
    """Successful generations return structured sample conversations."""

    def setUp(self) -> None:
        self.service, self.provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )

    def test_empty_generation_returns_the_parsed_dialogue(self) -> None:
        sample = self.service.generate_sample(topic=TOPIC, level="B1")

        self.assertEqual(
            sample,
            SampleConversation(
                turns=tuple(
                    SampleTurn(role=turn["role"], content=turn["content"])
                    for turn in VALID_PAYLOAD["turns"]
                )
            ),
        )

    def test_parsed_content_is_stripped(self) -> None:
        padded = {
            "turns": [
                {"role": "assistant", "content": "  Padded tutor line \n"},
                {"role": "user", "content": "\t Padded learner line "},
            ]
        }
        self.provider.response = make_response(json_payload(padded))

        sample = self.service.generate_sample(topic=TOPIC, level="A2")

        self.assertEqual(
            [turn.content for turn in sample.turns],
            ["Padded tutor line", "Padded learner line"],
        )

    def test_extra_json_keys_are_ignored(self) -> None:
        payload = {
            **VALID_PAYLOAD,
            "title": TOPIC.title,
            "notes": "extra top-level key",
            "turns": [{**turn, "translation": "ignored"} for turn in VALID_PAYLOAD["turns"]],
        }
        self.provider.response = make_response(json_payload(payload))

        sample = self.service.generate_sample(topic=TOPIC, level="B2")

        self.assertEqual(len(sample.turns), len(VALID_PAYLOAD["turns"]))
        self.assertEqual(sample.turns[0].content, VALID_PAYLOAD["turns"][0]["content"])

    def test_fenced_json_output_is_parsed(self) -> None:
        fenced = "```json\n" + json.dumps(VALID_PAYLOAD) + "\n```"
        self.provider.response = make_response(fenced)

        sample = self.service.generate_sample(topic=TOPIC, level="A1")

        self.assertEqual(len(sample.turns), 4)

    def test_prose_wrapped_json_is_parsed(self) -> None:
        wrapped = f"Here is an example:\n{json.dumps(VALID_PAYLOAD)}\nEnjoy!"
        self.provider.response = make_response(wrapped)

        sample = self.service.generate_sample(topic=TOPIC, level="C1")

        self.assertEqual(sample.turns[-1].content, VALID_PAYLOAD["turns"][-1]["content"])

    def test_request_contains_exactly_one_system_and_one_user_message(self) -> None:
        self.service.generate_sample(topic=TOPIC, level="B1")

        [request] = self.provider.requests
        self.assertEqual([message.role for message in request.messages], ["system", "user"])
        for message in request.messages:
            self.assertTrue(message.content.strip())

    def test_system_prompt_demands_json_with_roles(self) -> None:
        self.service.generate_sample(topic=TOPIC, level="B1")

        system_content = self.provider.requests[0].messages[0].content
        self.assertIn("JSON", system_content)
        self.assertIn("turns", system_content)
        for role in ("assistant", "user"):
            self.assertIn(f'"{role}"', system_content)

    def test_concrete_level_is_echoed_into_the_user_prompt(self) -> None:
        self.service.generate_sample(topic=TOPIC, level="B2")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("B2", user_content)
        self.assertNotIn("infer", user_content.lower())

    def test_auto_level_asks_the_model_to_infer(self) -> None:
        self.service.generate_sample(topic=TOPIC, level=Level.AUTO)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("infer", user_content.lower())
        self.assertNotIn("(CEFR)", user_content)

    def test_topic_title_and_description_shape_the_user_prompt(self) -> None:
        self.service.generate_sample(topic=TOPIC, level="B1")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn(TOPIC.title, user_content)
        self.assertIn(TOPIC.description, user_content)

    def test_distinct_topics_produce_distinct_prompts(self) -> None:
        other = GeneratedTopic(title="Job interviews", description="Practise interview answers.")

        self.service.generate_sample(topic=TOPIC, level="B1")
        first_prompt = self.provider.requests[0].messages[-1].content
        self.service.generate_sample(topic=other, level="B1")
        second_prompt = self.provider.requests[-1].messages[-1].content

        self.assertNotEqual(first_prompt, second_prompt)
        self.assertIn(other.title, second_prompt)


class InvalidOutputTests(SimpleTestCase):
    """Malformed completions normalize into attributed response errors."""

    def make_invalid_outputs(self) -> tuple[str, ...]:
        good_turn = {"role": "user", "content": "fine"}
        return (
            "plain prose without any braces",
            json_payload([VALID_PAYLOAD]),
            json_payload("just a string"),
            json_payload(42),
            json_payload(None),
            "{",
            "",
            "   ",
            "{}",
            json_payload({"turns": "not a list"}),
            json_payload({"turns": {"role": "user", "content": "still not a list"}}),
            json_payload({"turns": []}),
            json_payload({"turns": [good_turn]}),
            json_payload({"turns": ["a bare string", "another one"]}),
            json_payload({"turns": [good_turn, 42]}),
            json_payload({"turns": [good_turn, None]}),
            json_payload({"turns": [{"role": "system", "content": "wrong role"}, good_turn]}),
            json_payload({"turns": [good_turn, {"role": "User", "content": "capitalized"}]}),
            json_payload({"turns": [good_turn, {"content": "missing role"}]}),
            json_payload({"turns": [good_turn, {"role": 123, "content": "numeric role"}]}),
            json_payload({"turns": [good_turn, {"role": "user"}]}),
            json_payload({"turns": [good_turn, {"role": "user", "content": 42}]}),
            json_payload({"turns": [good_turn, {"role": "user", "content": True}]}),
            json_payload({"turns": [good_turn, {"role": "user", "content": None}]}),
            json_payload({"turns": [good_turn, {"role": "user", "content": "   "}]}),
            '{"turns": [{"role": "user"',
            "{not valid json at all}",
        )

    def test_invalid_outputs_raise_normalized_response_error(self) -> None:
        for output in self.make_invalid_outputs():
            with self.subTest(output=output[:40]):
                service, _ = make_service(response=make_response(output))

                with self.assertRaises(LLMResponseError) as caught:
                    service.generate_sample(topic=TOPIC, level="B1")

                error = caught.exception
                self.assertFalse(error.retryable)
                self.assertEqual(error.provider, "topics")

    def test_error_carries_the_served_model(self) -> None:
        service, _ = make_service(response=make_response("garbage", model="fallback/secondary"))

        with self.assertRaises(LLMResponseError) as caught:
            service.generate_sample(topic=TOPIC, level="A2")

        self.assertEqual(caught.exception.model, "fallback/secondary")


class ProviderFailureTests(SimpleTestCase):
    """Provider failures propagate unchanged; parsing never masks them."""

    def test_retryable_availability_error_passes_through_identically(self) -> None:
        original = LLMAvailabilityError("capacity exceeded", model="primary/a")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAvailabilityError) as caught:
            service.generate_sample(topic=TOPIC, level="B1")

        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.retryable)

    def test_authentication_error_passes_through_identically(self) -> None:
        original = LLMAuthenticationError("bad key")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAuthenticationError) as caught:
            service.generate_sample(topic=TOPIC, level="B1")

        self.assertIs(caught.exception, original)

    def test_non_llm_errors_propagate_unmasked(self) -> None:
        service, _ = make_service(error=ValueError("programming bug"))

        with self.assertRaises(ValueError) as caught:
            service.generate_sample(topic=TOPIC, level="B1")

        self.assertEqual(str(caught.exception), "programming bug")


class ApiReturnabilityTests(SimpleTestCase):
    """Sample data is plain structured data ready for API serialization."""

    def test_sample_conversation_serializes_to_plain_json(self) -> None:
        service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))
        sample = service.generate_sample(topic=TOPIC, level="B1")

        encoded = json.dumps(asdict(sample))
        decoded = json.loads(encoded)

        self.assertEqual(decoded["turns"], VALID_PAYLOAD["turns"])
        for turn in decoded["turns"]:
            self.assertIsInstance(turn["role"], str)
            self.assertIsInstance(turn["content"], str)

    def test_generated_topic_serializes_to_plain_json(self) -> None:
        encoded = json.dumps(asdict(TOPIC))

        decoded = json.loads(encoded)

        self.assertEqual(decoded["title"], TOPIC.title)
        self.assertEqual(decoded["description"], TOPIC.description)


class LoggingHygieneTests(SimpleTestCase):
    """Payload text is never logged; only models, counts and durations are."""

    def test_success_log_names_model_but_not_payload(self) -> None:
        service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

        with self.assertLogs("conversations.topics", level="INFO") as captured:
            service.generate_sample(topic=TOPIC, level="B1")

        joined = "\n".join(captured.output)
        self.assertIn(SERVED_MODEL, joined)
        self.assertNotIn(TOPIC.description, joined)
        for turn in VALID_PAYLOAD["turns"]:
            self.assertNotIn(turn["content"], joined)

    def test_failure_log_contains_normalized_error_but_not_payload(self) -> None:
        leaky = '{"turns": [{"role": "user", "content": "SECRET-SAMPLE-PAYLOAD"'  # malformed
        service, _ = make_service(response=make_response(leaky))

        with self.assertLogs("conversations.topics", level="WARNING") as captured:
            with self.assertRaises(LLMResponseError):
                service.generate_sample(topic=TOPIC, level="B1")

        joined = "\n".join(captured.output)
        self.assertIn("topics", joined)
        self.assertNotIn("SECRET-SAMPLE-PAYLOAD", joined)
