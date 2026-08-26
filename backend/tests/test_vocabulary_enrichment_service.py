"""Tests for the vocabulary enrichment service (vocabulary.enrichment, TASK-068)."""

import pytest
from django.test import SimpleTestCase

from llm.exceptions import LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse
from vocabulary.enrichment import (
    EXPRESSION_INSTRUCTION,
    SYSTEM_PROMPT,
    Enrichment,
    EnrichmentService,
)

SERVED_MODEL = "served/enricher"

FULL_JSON = (
    '{"definition": "to start a journey", '
    '"translation": "begin a trip", '
    '"pronunciation": "/set \u0252f/", '
    '"part_of_speech": "phrasal verb", '
    '"example": "We set off at dawn."}'
)


class ScriptedProvider(LLMProvider):
    """Fake provider returning one scripted outcome and recording requests."""

    def __init__(self, *outcomes) -> None:
        self.outcomes = list(outcomes)
        self.requests: list[CompletionRequest] = []

    def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.requests.append(request)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def stream(self, request: CompletionRequest):
        raise AssertionError("enrichment never streams")


def response(text: str) -> CompletionResponse:
    return CompletionResponse(text=text, model=SERVED_MODEL)


# ---------------------------------------------------------------------------
# Input validation.
# ---------------------------------------------------------------------------


class EnrichmentInputValidation(SimpleTestCase):
    def setUp(self) -> None:
        self.provider = ScriptedProvider(response(FULL_JSON))
        self.service = EnrichmentService(self.provider)

    def test_blank_expression_is_rejected_without_provider_call(self) -> None:
        for expression in ("", "   ", None):
            with pytest.raises(ValueError, match="expression"):
                self.service.enrich(expression=expression, level="B1")
        assert self.provider.requests == []

    def test_unknown_level_is_rejected_without_provider_call(self) -> None:
        with pytest.raises(ValueError, match="Unknown learning level"):
            self.service.enrich(expression="set off", level="Z9")
        assert self.provider.requests == []


# ---------------------------------------------------------------------------
# Prompt construction.
# ---------------------------------------------------------------------------


class EnrichmentPromptTests(SimpleTestCase):
    def enrich(self, *, level: str, expression: str = "set off") -> ScriptedProvider:
        provider = ScriptedProvider(response(FULL_JSON))
        EnrichmentService(provider).enrich(expression=expression, level=level)
        return provider

    def test_system_prompt_demands_strict_json_with_all_fields(self) -> None:
        provider = self.enrich(level="B1")
        system = provider.requests[0].messages[0]
        assert system.role == "system"
        assert system.content == SYSTEM_PROMPT
        for field in ("definition", "translation", "pronunciation", "part_of_speech", "example"):
            assert f'"{field}"' in system.content

    def test_known_level_is_stated_in_user_prompt(self) -> None:
        user_text = self.enrich(level="B2").requests[0].messages[-1].content
        assert "B2" in user_text

    def test_auto_level_lets_the_model_infer(self) -> None:
        user_text = self.enrich(level="AUTO").requests[0].messages[-1].content
        assert "infer an appropriate level" in user_text

    def test_expression_is_quoted_verbatim(self) -> None:
        user_text = (
            self.enrich(level="B1", expression="  bite the bullet ")
            .requests[0]
            .messages[-1]
            .content
        )
        assert EXPRESSION_INSTRUCTION.format(expression="bite the bullet") in user_text


# ---------------------------------------------------------------------------
# Output parsing.
# ---------------------------------------------------------------------------


class EnrichmentParsingTests:
    """Plain class (not unittest) so pytest's ``parametrize`` applies."""

    def parse(self, text: str) -> Enrichment:
        provider = ScriptedProvider(response(text))
        return EnrichmentService(provider).enrich(expression="set off", level="B1")

    def test_valid_json_becomes_a_full_enrichment(self) -> None:
        enrichment = self.parse(FULL_JSON)
        assert enrichment.definition == "to start a journey"
        assert enrichment.translation == "begin a trip"
        assert enrichment.pronunciation == "/set \u0252f/"
        assert enrichment.part_of_speech == "phrasal verb"
        assert enrichment.example == "We set off at dawn."

    def test_json_wrapped_in_code_fences_is_tolerated(self) -> None:
        fenced = f"Here you go:\n```json\n{FULL_JSON}\n```"
        assert self.parse(fenced).definition == "to start a journey"

    def test_extra_json_keys_are_ignored(self) -> None:
        padded = FULL_JSON.replace("{", '{"synonyms": ["depart"], ', 1)
        assert self.parse(padded).translation == "begin a trip"

    def test_non_object_output_is_a_contract_violation(self) -> None:
        with pytest.raises(LLMResponseError, match="not a JSON object") as excinfo:
            self.parse("set off means to begin a journey")
        assert excinfo.value.provider == "vocabulary"
        assert excinfo.value.model == SERVED_MODEL

    def test_missing_field_is_a_contract_violation(self) -> None:
        incomplete = FULL_JSON.replace('"part_of_speech": "phrasal verb", ', "")
        with pytest.raises(LLMResponseError, match="'part_of_speech'"):
            self.parse(incomplete)

    @pytest.mark.parametrize(
        ("field", "value"),
        (
            ("definition", "d"),
            ("translation", "t"),
            ("pronunciation", "p"),
            ("part_of_speech", "pos"),
            ("example", "e"),
        ),
    )
    def test_blank_field_is_a_contract_violation(self, field: str, value: str) -> None:
        payload = (
            '{"definition": "d", "translation": "t", "pronunciation": "p", '
            '"part_of_speech": "pos", "example": "e"}'
        )
        broken = payload.replace(f'"{field}": "{value}"', f'"{field}": ""')
        assert broken != payload
        with pytest.raises(LLMResponseError):
            self.parse(broken)

    def test_non_string_field_is_a_contract_violation(self) -> None:
        payload = FULL_JSON.replace('"pronunciation"', '"pronunciation": null, "x"')
        with pytest.raises(LLMResponseError):
            self.parse(payload)
