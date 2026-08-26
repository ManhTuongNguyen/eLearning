"""Tests for the rolling conversation summarizer (conversations.summarizer)."""

from django.test import SimpleTestCase

from conversations.summarizer import ConversationSummarizer
from llm.exceptions import (
    LLMAuthenticationError,
    LLMAvailabilityError,
    LLMError,
    LLMResponseError,
)
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

SERVED_MODEL = "served/summary-model"

SUMMARY_TEXT = "The learner is planning a trip to Lisbon and prefers simple past-tense practice."

ARCHIVED = (
    ("user", "I want to talk about my holiday plans."),
    ("assistant", "That sounds fun! Where are you planning to go?"),
    ("user", "Maybe Lisbon next spring."),
)


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
        raise AssertionError("summary generation never streams")


def make_response(text: str, model: str = SERVED_MODEL) -> CompletionResponse:
    return CompletionResponse(text=text, model=model)


def make_service(
    *, response: CompletionResponse | None = None, error=None
) -> tuple[ConversationSummarizer, FakeProvider]:
    provider = FakeProvider(response=response, error=error)
    return ConversationSummarizer(provider=provider), provider


def summarize_once(service: ConversationSummarizer, **kwargs) -> str:
    """Run one summarize call with sensible defaults."""
    kwargs.setdefault("archived_messages", ARCHIVED)
    return service.summarize(**kwargs)


class ServiceShapeTests(SimpleTestCase):
    """Constructor and result-value basics."""

    def test_service_is_not_frozen_but_wraps_provider(self) -> None:
        service, _ = make_service()

        self.assertIsInstance(service.provider, LLMProvider)

    def test_result_is_plain_stripped_text(self) -> None:
        service, _ = make_service(response=make_response(f"  {SUMMARY_TEXT}\n"))

        self.assertEqual(summarize_once(service), SUMMARY_TEXT)

    def test_fenced_output_is_tolerated(self) -> None:
        for wrapped in (
            f"```\n{SUMMARY_TEXT}\n```",
            f"```text\n{SUMMARY_TEXT}\n```",
        ):
            with self.subTest(wrapped=wrapped[:20]):
                service, _ = make_service(response=make_response(wrapped))

                self.assertEqual(summarize_once(service), SUMMARY_TEXT)


class InputBoundaryTests(SimpleTestCase):
    """Bad inputs are rejected before any provider call."""

    def test_empty_archived_messages_is_rejected_without_provider_call(self) -> None:
        service, provider = make_service(response=make_response(SUMMARY_TEXT))

        with self.assertRaises(ValueError):
            service.summarize(archived_messages=[])

        self.assertEqual(provider.requests, [])

    def test_invalid_role_matrix_is_rejected_without_provider_call(self) -> None:
        for role in ("system", "tool", "", "User", "USER", "assistant ", None, 5):
            with self.subTest(role=role):
                service, provider = make_service(response=make_response(SUMMARY_TEXT))

                with self.assertRaises(ValueError):
                    summarize_once(service, archived_messages=[(role, "hello")])

                self.assertEqual(provider.requests, [])

    def test_blank_content_matrix_is_rejected_without_provider_call(self) -> None:
        for content in ("", "   \n\t"):
            with self.subTest(content=content):
                service, provider = make_service(response=make_response(SUMMARY_TEXT))

                with self.assertRaises(ValueError):
                    summarize_once(service, archived_messages=[("user", content)])

                self.assertEqual(provider.requests, [])

    def test_non_string_content_is_rejected(self) -> None:
        service, provider = make_service(response=make_response(SUMMARY_TEXT))

        with self.assertRaises(ValueError):
            summarize_once(service, archived_messages=[("user", 42)])

        self.assertEqual(provider.requests, [])

    def test_malformed_entry_shapes_are_rejected(self) -> None:
        for entry in (("user",), ("user", "a", "b"), "user: hello", None):
            with self.subTest(entry=entry):
                service, provider = make_service(response=make_response(SUMMARY_TEXT))

                with self.assertRaises(ValueError):
                    summarize_once(service, archived_messages=[entry])

                self.assertEqual(provider.requests, [])

    def test_non_string_previous_summary_is_rejected(self) -> None:
        service, provider = make_service(response=make_response(SUMMARY_TEXT))

        for previous_summary in (None, 12, b"text"):
            with self.subTest(previous_summary=previous_summary):
                with self.assertRaises(ValueError):
                    summarize_once(service, previous_summary=previous_summary)

        self.assertEqual(provider.requests, [])


class PromptContractTests(SimpleTestCase):
    """The LLM request contains exactly the two summarizer inputs."""

    def setUp(self) -> None:
        self.service, self.provider = make_service(response=make_response(SUMMARY_TEXT))

    def user_turn(self, **kwargs) -> str:
        kwargs.setdefault("archived_messages", ARCHIVED)
        summarize_once(self.service, **kwargs)
        request = self.provider.requests[-1]
        return request.messages[-1].content

    def test_request_shape_is_exactly_system_plus_user(self) -> None:
        summarize_once(self.service)

        request = self.provider.requests[-1]
        self.assertEqual([message.role for message in request.messages], ["system", "user"])

    def test_system_prompt_demands_plain_text_summary(self) -> None:
        summarize_once(self.service)

        system_prompt = self.provider.requests[-1].messages[0].content
        self.assertIn("rolling summary", system_prompt.lower())
        self.assertIn("plain text", system_prompt.lower())

    def test_no_model_or_temperature_pins_on_request(self) -> None:
        summarize_once(self.service)

        request = self.provider.requests[-1]
        self.assertIsNone(request.model)
        self.assertIsNone(request.temperature)

    def test_first_compaction_omits_previous_summary_block(self) -> None:
        user_turn = self.user_turn(previous_summary="")

        self.assertNotIn("so far", user_turn.lower())
        self.assertIn("my holiday plans", user_turn)

    def test_existing_summary_is_incorporated_into_the_request(self) -> None:
        user_turn = self.user_turn(
            previous_summary="Earlier the learner introduced herself as Ana."
        )

        self.assertIn("Summary of the conversation so far:", user_turn)
        self.assertIn("introduced herself as Ana.", user_turn)
        self.assertIn("my holiday plans", user_turn)

    def test_distinct_previous_summaries_produce_distinct_prompts(self) -> None:
        first_turn = self.user_turn(previous_summary="Summary about cooking.")
        second_turn = self.user_turn(previous_summary="Summary about football.")

        self.assertNotEqual(first_turn, second_turn)

    def test_whitespace_only_previous_summary_behaves_like_empty(self) -> None:
        blank_service, blank_provider = make_service(response=make_response(SUMMARY_TEXT))
        spaced_service, spaced_provider = make_service(response=make_response(SUMMARY_TEXT))

        summarize_once(blank_service, previous_summary="", archived_messages=ARCHIVED)
        summarize_once(spaced_service, previous_summary="  \n\t ", archived_messages=ARCHIVED)

        self.assertEqual(
            blank_provider.requests[0].messages,
            spaced_provider.requests[0].messages,
        )

    def test_archived_messages_appear_verbatim_in_order_with_roles(self) -> None:
        user_turn = self.user_turn()

        self.assertIn("user: I want to talk about my holiday plans.", user_turn)
        self.assertIn("assistant: That sounds fun! Where are you planning to go?", user_turn)
        self.assertLess(
            user_turn.index("user: I want to talk"),
            user_turn.index("assistant: That sounds fun!"),
        )
        self.assertLess(
            user_turn.index("assistant: That sounds fun!"),
            user_turn.index("user: Maybe Lisbon next spring."),
        )

    def test_only_the_given_messages_are_summarized(self) -> None:
        user_turn = self.user_turn(
            archived_messages=(("user", "turn 21 text"), ("assistant", "turn 22 text"))
        )

        self.assertIn("user: turn 21 text", user_turn)
        self.assertIn("assistant: turn 22 text", user_turn)
        # Nothing outside the handed-in batch may leak into the request.
        for outsider in ("turn 19", "turn 23", "holiday"):
            self.assertNotIn(outsider, user_turn)

    def test_message_lines_between_headers_match_the_batch_exactly(self) -> None:
        batch = (("user", "alpha message"), ("assistant", "beta reply"))
        user_turn = self.user_turn(archived_messages=batch)

        lines = user_turn.splitlines()
        start = lines.index(
            "These messages have just left the recent window "
            "and must now be folded into the summary:"
        )
        end = lines.index(
            "Write the updated summary covering everything "
            "in the previous summary plus these messages."
        )
        self.assertEqual(lines[start + 1 : end], ["user: alpha message", "assistant: beta reply"])

    def test_single_pass_iterable_input_is_accepted(self) -> None:
        summarize_once(self.service, archived_messages=(msg for msg in ARCHIVED))

        request = self.provider.requests[-1]
        self.assertEqual(len(request.messages), 2)

    def test_identical_inputs_produce_identical_requests(self) -> None:
        first_turn = self.user_turn(previous_summary="Same summary.")
        second_turn = self.user_turn(previous_summary="Same summary.")

        self.assertEqual(first_turn, second_turn)

    def test_requests_recorded_in_order_across_calls(self) -> None:
        summarize_once(self.service, archived_messages=(("user", "first batch"),))
        summarize_once(self.service, archived_messages=(("user", "second batch"),))

        self.assertEqual(len(self.provider.requests), 2)
        self.assertIn("first batch", self.provider.requests[0].messages[-1].content)
        self.assertIn("second batch", self.provider.requests[1].messages[-1].content)


class FailureTests(SimpleTestCase):
    """Unusable completions are normalized; provider failures pass through."""

    def test_blank_completion_raises_response_error_attributed_to_summaries(self) -> None:
        for text in ("", "   \n\t "):
            with self.subTest(text=text):
                service, _ = make_service(response=make_response(text))

                with self.assertRaises(LLMResponseError) as ctx:
                    summarize_once(service)

                error = ctx.exception
                self.assertEqual(error.provider, "summaries")
                self.assertEqual(error.model, SERVED_MODEL)
                self.assertFalse(error.retryable)

    def test_provider_llm_errors_propagate_unchanged(self) -> None:
        auth_error = LLMAuthenticationError("bad key")
        availability_error = LLMAvailabilityError("over capacity")

        for error in (auth_error, availability_error):
            with self.subTest(error=type(error).__name__):
                service, _ = make_service(error=error)

                with self.assertRaises(LLMError) as ctx:
                    summarize_once(service)

                self.assertIs(ctx.exception, error)

    def test_non_llm_errors_are_unmasked(self) -> None:
        service, _ = make_service(error=RuntimeError("boom"))

        with self.assertRaises(RuntimeError):
            summarize_once(service)

    def test_base_llm_error_is_an_llm_error_instance(self) -> None:
        base_error = LLMError("generic failure", retryable=True)
        service, _ = make_service(error=base_error)

        with self.assertRaises(LLMError) as ctx:
            summarize_once(service)

        self.assertIs(ctx.exception, base_error)


class LogHygieneTests(SimpleTestCase):
    """Request/completion payloads never reach the logs; metadata does."""

    SECRET = "SECRET-PAYLOAD-TEXT"

    def test_success_log_carries_model_but_not_payload(self) -> None:
        service, _ = make_service(response=make_response(f"Summary mentioning {self.SECRET}."))

        with self.assertLogs("conversations.summaries", level="INFO") as logs:
            summarize_once(
                service,
                archived_messages=(("user", f"message containing {self.SECRET}"),),
            )

        joined = "\n".join(logs.output)
        self.assertIn(SERVED_MODEL, joined)
        self.assertNotIn(self.SECRET, joined)

    def test_failure_log_carries_error_but_not_request_payload(self) -> None:
        service, _ = make_service(response=make_response("   \n\t "))

        with self.assertLogs("conversations.summaries", level="WARNING") as logs:
            with self.assertRaises(LLMResponseError):
                summarize_once(
                    service,
                    archived_messages=(("user", f"message containing {self.SECRET}"),),
                    previous_summary=f"summary containing {self.SECRET}",
                )

        joined = "\n".join(logs.output)
        self.assertIn("Summary response was empty.", joined)
        self.assertIn(SERVED_MODEL, joined)
        self.assertNotIn(self.SECRET, joined)
