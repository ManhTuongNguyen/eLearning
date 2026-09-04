"""Tests for the English-improvement service (conversations.improvement)."""

import json
from dataclasses import FrozenInstanceError

from django.test import SimpleTestCase

from conversations.improvement import (
    SEVERITY_VALUES,
    Improvement,
    ImprovementService,
)
from learning.models import Level
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

SERVED_MODEL = "served/improvement-model"

ORIGINAL = "I have went to store yesterday"
TRIMMED_ORIGINAL = ORIGINAL.strip()

VALID_PAYLOAD = {
    "improved": "I went to the store yesterday.",
    "explanation": 'Use past simple ("went") with "yesterday" instead of present perfect.',
    "severity": "critical",
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
        raise AssertionError("improvement never streams")


def make_response(text: str, model: str = SERVED_MODEL) -> CompletionResponse:
    return CompletionResponse(text=text, model=model)


def make_service(
    *, response: CompletionResponse | None = None, error=None
) -> tuple[ImprovementService, FakeProvider]:
    provider = FakeProvider(response=response, error=error)
    return ImprovementService(provider=provider), provider


def json_payload(payload: dict | list | str | int | None) -> str:
    return json.dumps(payload)


class ImprovementTests(SimpleTestCase):
    """Shape of the structured improvement result."""

    def test_improvement_is_frozen(self) -> None:
        improvement = Improvement(original="a", improved="b", explanation="c", severity="none")

        with self.assertRaises(FrozenInstanceError):
            improvement.improved = "x"  # type: ignore[misc]

    def test_blank_field_is_rejected(self) -> None:
        cases = (
            {"original": "", "improved": "b", "explanation": "c", "severity": "none"},
            {"original": "   ", "improved": "b", "explanation": "c", "severity": "none"},
            {"original": "a", "improved": "", "explanation": "c", "severity": "none"},
            {"original": "a", "improved": "b", "explanation": "", "severity": "none"},
            {"original": None, "improved": "b", "explanation": "c", "severity": "none"},
            {"original": "a", "improved": 42, "explanation": "c", "severity": "none"},  # type: ignore[dict-item]
        )
        for fields in cases:
            with self.subTest(fields=fields):
                with self.assertRaises(ValueError):
                    Improvement(**fields)

    def test_invalid_severity_is_rejected(self) -> None:
        for severity in ("", "  ", "major", None, 42):
            with self.subTest(severity=severity):
                with self.assertRaises(ValueError):
                    Improvement(original="a", improved="b", explanation="c", severity=severity)

    def test_severity_is_normalized_to_lowercase(self) -> None:
        for raw, normalized in (
            ("NONE", "none"),
            ("Minor", "minor"),
            ("  CRITICAL  ", "critical"),
        ):
            with self.subTest(raw=raw):
                improvement = Improvement(original="a", improved="b", explanation="c", severity=raw)
                self.assertEqual(improvement.severity, normalized)

    def test_allowed_severities_are_accepted(self) -> None:
        for severity in SEVERITY_VALUES:
            with self.subTest(severity=severity):
                improvement = Improvement(
                    original="a", improved="b", explanation="c", severity=severity
                )
                self.assertEqual(improvement.severity, severity)

    def test_improvements_compare_by_value(self) -> None:
        first = Improvement(original="a", improved="b", explanation="c", severity="minor")
        same = Improvement(original="a", improved="b", explanation="c", severity="minor")

        self.assertEqual(first, same)


class InputValidationTests(SimpleTestCase):
    """Bad service inputs are rejected before any provider call."""

    def make_called_service(self) -> tuple[ImprovementService, FakeProvider]:
        return make_service(response=make_response(json_payload(VALID_PAYLOAD)))

    def assert_no_provider_call(
        self,
        service: ImprovementService,
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
                    lambda svc, level=level: svc.improve(level=level, original_message="Hello"),
                )

    def test_blank_or_non_string_message_is_rejected_without_provider_call(self) -> None:
        for message in ("", "   ", None, 42):
            with self.subTest(message=message):
                service, provider = self.make_called_service()

                self.assert_no_provider_call(
                    service,
                    provider,
                    lambda svc, message=message: svc.improve(level="B1", original_message=message),
                )


class HappyPathTests(SimpleTestCase):
    """Successful corrections preserve the original and validate output."""

    def setUp(self) -> None:
        self.service, self.provider = make_service(
            response=make_response(json_payload(VALID_PAYLOAD))
        )

    def improve_default(self, **overrides):
        kwargs = {"level": "B1", "original_message": ORIGINAL}
        kwargs.update(overrides)
        return self.service.improve(**kwargs)

    def test_valid_output_returns_original_verbatim_and_stripped_fields(self) -> None:
        padded_payload = {
            "improved": f"  {VALID_PAYLOAD['improved']} ",
            "explanation": f"\n{VALID_PAYLOAD['explanation']}\t",
            "severity": f"  {VALID_PAYLOAD['severity']} ",
        }
        self.provider.response = make_response(json_payload(padded_payload))

        improvement = self.improve_default()

        self.assertEqual(improvement.original, TRIMMED_ORIGINAL)
        self.assertEqual(improvement.improved, VALID_PAYLOAD["improved"])
        self.assertEqual(improvement.explanation, VALID_PAYLOAD["explanation"])
        self.assertEqual(improvement.severity, VALID_PAYLOAD["severity"])

    def test_original_is_never_taken_from_the_model_output(self) -> None:
        paraphrased = {**VALID_PAYLOAD, "original": "A PARAPHRASED ECHO"}
        self.provider.response = make_response(json_payload(paraphrased))

        improvement = self.improve_default()

        self.assertEqual(improvement.original, TRIMMED_ORIGINAL)

    def test_all_levels_are_accepted(self) -> None:
        for level in Level.values:
            with self.subTest(level=level):
                improvement = self.service.improve(level=level, original_message="Hello world")

                self.assertTrue(improvement.improved.strip())

    def test_already_correct_message_keeps_it_unchanged(self) -> None:
        correct = "Could I have a coffee, please?"
        payload = {
            "improved": correct,
            "explanation": "Your message is already correct.",
            "severity": "none",
        }
        self.provider.response = make_response(json_payload(payload))

        improvement = self.service.improve(level="C1", original_message=correct)

        self.assertEqual(improvement.original, improvement.improved)
        self.assertEqual(improvement.severity, "none")

    def test_minor_and_critical_severities_round_trip(self) -> None:
        for severity in ("minor", "critical"):
            with self.subTest(severity=severity):
                service, _ = make_service(
                    response=make_response(json_payload({**VALID_PAYLOAD, "severity": severity}))
                )

                improvement = service.improve(level="B1", original_message=ORIGINAL)

                self.assertEqual(improvement.severity, severity)

    def test_request_contains_exactly_one_system_and_one_user_message(self) -> None:
        self.improve_default()

        [request] = self.provider.requests
        self.assertEqual([message.role for message in request.messages], ["system", "user"])
        for message in request.messages:
            self.assertTrue(message.content.strip())

    def test_system_prompt_demands_json_with_improved_explanation_and_severity(self) -> None:
        self.improve_default()

        system_content = self.provider.requests[0].messages[0].content
        self.assertIn("JSON", system_content)
        self.assertIn("improved", system_content)
        self.assertIn("explanation", system_content)
        self.assertIn("severity", system_content)
        self.assertIn("none", system_content)
        self.assertIn("minor", system_content)
        self.assertIn("critical", system_content)

    def test_user_prompt_quotes_the_learner_message(self) -> None:
        self.improve_default()

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn(TRIMMED_ORIGINAL, user_content)

    def test_concrete_level_is_echoed_into_the_user_prompt(self) -> None:
        self.improve_default(level="B2")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("B2", user_content)
        self.assertNotIn("unknown", user_content)

    def test_concrete_level_asks_for_an_extension_one_sub_level_above(self) -> None:
        self.improve_default(level="A2")

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("Extend the message as well", user_content)
        self.assertIn("guides the learner to say more", user_content)
        # A2 learners are stretched toward B1: slightly above, not a leap.
        self.assertIn("around B1 rather than A2", user_content)

    def test_extension_target_advances_the_whole_cefr_ladder(self) -> None:
        for level, target in (("A1", "A2"), ("A2", "B1"), ("B1", "B2"), ("B2", "C1"), ("C1", "C2")):
            with self.subTest(level=level, target=target):
                self.improve_default(level=level)

                user_content = self.provider.requests[-1].messages[-1].content
                self.assertIn(f"around {target} rather than {level}", user_content)

    def test_extension_target_caps_at_c2(self) -> None:
        self.improve_default(level="C2")

        user_content = self.provider.requests[-1].messages[-1].content
        self.assertIn("top of the CEFR scale (C2)", user_content)
        self.assertIn("extend the message", user_content)
        self.assertNotIn("rather than C2", user_content)

    def test_auto_level_stays_correction_only(self) -> None:
        self.improve_default(level=Level.AUTO)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("unknown", user_content)
        self.assertNotIn("(CEFR)", user_content)
        # AUTO keeps the historic behaviour: corrections only, no extension.
        self.assertIn("Correct the message only", user_content)
        self.assertNotIn("Extend the message as well", user_content)

    def test_system_prompt_describes_both_behaviours(self) -> None:
        self.improve_default()

        system_content = self.provider.requests[0].messages[0].content
        # Known level: correct AND extend slightly above; unknown: correct only.
        self.assertIn("extend the message", system_content)
        self.assertIn("slightly above their level", system_content)
        self.assertIn("only correct it", system_content)

    def test_auto_level_asks_for_an_inferred_explanation_level(self) -> None:
        self.improve_default(level=Level.AUTO)

        user_content = self.provider.requests[0].messages[-1].content
        self.assertIn("unknown", user_content)
        self.assertNotIn("(CEFR)", user_content)

    def test_distinct_messages_produce_distinct_prompts(self) -> None:
        self.improve_default(original_message="First message here")
        first_prompt = self.provider.requests[0].messages[-1].content

        self.improve_default(original_message="Second message here")
        second_prompt = self.provider.requests[-1].messages[-1].content

        self.assertNotEqual(first_prompt, second_prompt)
        self.assertIn("Second message here", second_prompt)

    def test_fenced_json_output_is_parsed(self) -> None:
        fenced = "```json\n" + json.dumps(VALID_PAYLOAD) + "\n```"
        self.provider.response = make_response(fenced)

        improvement = self.improve_default()

        self.assertEqual(improvement.improved, VALID_PAYLOAD["improved"])
        self.assertEqual(improvement.explanation, VALID_PAYLOAD["explanation"])

    def test_prose_wrapped_json_is_parsed(self) -> None:
        wrapped = f"Here is your correction:\n{json.dumps(VALID_PAYLOAD)}\nKeep going!"
        self.provider.response = make_response(wrapped)

        improvement = self.improve_default()

        self.assertEqual(improvement.improved, VALID_PAYLOAD["improved"])

    def test_extra_json_keys_are_ignored(self) -> None:
        payload = {**VALID_PAYLOAD, "confidence": 0.9, "notes": ["tense"]}
        self.provider.response = make_response(json_payload(payload))

        improvement = self.improve_default()

        self.assertEqual(improvement.improved, VALID_PAYLOAD["improved"])
        self.assertEqual(improvement.explanation, VALID_PAYLOAD["explanation"])


class InvalidOutputTests(SimpleTestCase):
    """Malformed completions normalize into attributed response errors."""

    INVALID_OUTPUTS = (
        "plain prose without any braces",
        json_payload(["one", "two"]),
        json_payload("just a string"),
        json_payload(42),
        json_payload(None),
        '{"improved": "a"',
        "{",
        "",
        "   ",
        "{}",
        json_payload({"corrected": "a", "explanation": "b"}),
        json_payload({"improved": "a"}),
        json_payload({"explanation": "b"}),
        json_payload({"improved": "", "explanation": "b"}),
        json_payload({"improved": "   ", "explanation": "b"}),
        json_payload({"improved": "a", "explanation": ""}),
        json_payload({"improved": "a", "explanation": "   "}),
        json_payload({"improved": "a", "explanation": None}),
        json_payload({"improved": 42, "explanation": "b"}),
        json_payload({"improved": ["a"], "explanation": "b"}),
        json_payload({"improved": "a", "explanation": "b"}),  # severity missing
        json_payload({**VALID_PAYLOAD, "severity": None}),
        json_payload({**VALID_PAYLOAD, "severity": 42}),
        json_payload({**VALID_PAYLOAD, "severity": ""}),
        json_payload({**VALID_PAYLOAD, "severity": "major"}),
        json_payload({**VALID_PAYLOAD, "severity": ["minor"]}),
        "```python\ndef broken(): pass\n```",
        "{not valid json at all}",
    )

    def test_invalid_outputs_raise_normalized_response_error(self) -> None:
        for output in self.INVALID_OUTPUTS:
            with self.subTest(output=output[:40]):
                service, _ = make_service(response=make_response(output))

                with self.assertRaises(LLMResponseError) as caught:
                    service.improve(level="B1", original_message=ORIGINAL)

                error = caught.exception
                self.assertFalse(error.retryable)
                self.assertEqual(error.provider, "improvement")

    def test_error_carries_the_served_model(self) -> None:
        service, _ = make_service(response=make_response("garbage", model="fallback/secondary"))

        with self.assertRaises(LLMResponseError) as caught:
            service.improve(level="A2", original_message="Hi!")

        self.assertEqual(caught.exception.model, "fallback/secondary")


class ProviderFailureTests(SimpleTestCase):
    """Provider failures propagate unchanged; parsing never masks them."""

    def test_retryable_availability_error_passes_through_identically(self) -> None:
        original = LLMAvailabilityError("capacity exceeded", model="primary/a")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAvailabilityError) as caught:
            service.improve(level="B1", original_message="Hi!")

        self.assertIs(caught.exception, original)
        self.assertTrue(caught.exception.retryable)

    def test_authentication_error_passes_through_identically(self) -> None:
        original = LLMAuthenticationError("bad key")
        service, _ = make_service(error=original)

        with self.assertRaises(LLMAuthenticationError) as caught:
            service.improve(level="B1", original_message="Hi!")

        self.assertIs(caught.exception, original)

    def test_non_llm_errors_propagate_unmasked(self) -> None:
        service, _ = make_service(error=ValueError("programming bug"))

        with self.assertRaises(ValueError) as caught:
            service.improve(level="B1", original_message="Hi!")

        self.assertEqual(str(caught.exception), "programming bug")


class LoggingHygieneTests(SimpleTestCase):
    """Payload text is never logged; only models and durations are."""

    def test_success_log_names_model_but_not_payload(self) -> None:
        service, _ = make_service(response=make_response(json_payload(VALID_PAYLOAD)))

        with self.assertLogs("conversations.improvement", level="INFO") as captured:
            service.improve(level="B1", original_message=ORIGINAL)

        joined = "\n".join(captured.output)
        self.assertIn(SERVED_MODEL, joined)
        for secret in (
            TRIMMED_ORIGINAL,
            VALID_PAYLOAD["improved"],
            VALID_PAYLOAD["explanation"],
        ):
            self.assertNotIn(secret, joined)

    def test_failure_log_contains_normalized_error_but_not_payload(self) -> None:
        leaky = '{"improved": "SECRET-IMPROVEMENT-PAYLOAD"'  # malformed JSON
        service, _ = make_service(response=make_response(leaky))

        with self.assertLogs("conversations.improvement", level="WARNING") as captured:
            with self.assertRaises(LLMResponseError):
                service.improve(level="B1", original_message=ORIGINAL)

        joined = "\n".join(captured.output)
        self.assertIn("improvement", joined)
        self.assertNotIn("SECRET-IMPROVEMENT-PAYLOAD", joined)
        self.assertNotIn(TRIMMED_ORIGINAL, joined)
