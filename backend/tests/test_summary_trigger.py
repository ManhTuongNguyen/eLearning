"""Tests for the summary trigger (conversations.trigger, TASK-038)."""

import logging

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, override_settings

from conversations.models import Message, Session
from conversations.summarizer import PREVIOUS_SUMMARY_HEADER
from conversations.trigger import (
    DEFAULT_SUMMARY_TRIGGER_THRESHOLD,
    SessionSummaryTrigger,
    archive_range,
    summary_threshold,
)
from llm.exceptions import LLMAvailabilityError, LLMResponseError
from llm.provider import LLMProvider
from llm.types import CompletionRequest, CompletionResponse

WINDOW = 20
THRESHOLD = 40

SUMMARY_ONE = "First forty turns: learner plans a trip to Lisbon and prefers past-tense practice."
SUMMARY_TWO = "Through turn eighty: trip booked for April; learner still confuses present perfect."

SERVED_MODEL = "served/trigger-model"

ARCHIVED_HEADER = (
    "These messages have just left the recent window and must now be folded into the summary:"
)
WRITE_PREFIX = "Write the updated summary covering everything"


class ScriptedProvider(LLMProvider):
    """Fake provider popping one scripted outcome per call and recording requests."""

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
        raise AssertionError("summary maintenance never streams")


def response(text: str) -> CompletionResponse:
    return CompletionResponse(text=text, model=SERVED_MODEL)


def archived_lines(request: CompletionRequest) -> list[str]:
    """The labeled `role: content` lines inside one summarizer prompt."""
    user_text = request.messages[-1].content
    body = user_text.split(ARCHIVED_HEADER, 1)[1]
    body = body.split(WRITE_PREFIX, 1)[0]
    return [line.strip() for line in body.strip().splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# Pure configuration and planning (no database).
# ---------------------------------------------------------------------------


class ThresholdConfigurationTests(SimpleTestCase):
    """Resolution and validation of CONTEXT_SUMMARY_TRIGGER_THRESHOLD."""

    def test_recommended_default_is_40(self) -> None:
        self.assertEqual(DEFAULT_SUMMARY_TRIGGER_THRESHOLD, 40)

    def test_reads_configured_setting(self) -> None:
        with override_settings(CONTEXT_SUMMARY_TRIGGER_THRESHOLD=10):
            self.assertEqual(summary_threshold(), 10)

    def test_falls_back_to_default_when_setting_absent(self) -> None:
        with override_settings():
            del settings.CONTEXT_SUMMARY_TRIGGER_THRESHOLD
            self.assertEqual(summary_threshold(), DEFAULT_SUMMARY_TRIGGER_THRESHOLD)

    def test_boundary_value_one_accepted(self) -> None:
        with override_settings(CONTEXT_SUMMARY_TRIGGER_THRESHOLD=1):
            self.assertEqual(summary_threshold(), 1)

    def test_large_values_accepted(self) -> None:
        with override_settings(CONTEXT_SUMMARY_TRIGGER_THRESHOLD=10_000):
            self.assertEqual(summary_threshold(), 10_000)

    def test_invalid_configured_matrix_names_the_variable(self) -> None:
        for bad in (0, -3, "20", "many", None, 2.5, True):
            with self.subTest(bad=bad):
                with override_settings(CONTEXT_SUMMARY_TRIGGER_THRESHOLD=bad):
                    with self.assertRaises(ImproperlyConfigured) as ctx:
                        summary_threshold()
                self.assertIn("CONTEXT_SUMMARY_TRIGGER_THRESHOLD", str(ctx.exception))


class ArchiveRangeTests(SimpleTestCase):
    """Trigger math with explicit window/threshold (settings-free)."""

    def test_short_conversation_below_threshold_returns_none(self) -> None:
        # total 59 - window 20 = end 39 pending < threshold 40.
        self.assertIsNone(archive_range(59, boundary=0, window=20, threshold=40))

    def test_exact_crossing_triggers_first_batch(self) -> None:
        assert archive_range(60, boundary=0, window=20, threshold=40) == (1, 40)

    def test_one_below_the_boundary_stays_silent(self) -> None:
        self.assertIsNone(archive_range(60, boundary=1, window=20, threshold=40))

    def test_repeat_after_compaction_is_a_no_op(self) -> None:
        # Boundary already covers everything up to end -> pending count 0.
        self.assertIsNone(archive_range(60, boundary=40, window=20, threshold=40))

    def test_next_batch_fires_after_another_full_batch_of_growth(self) -> None:
        assert archive_range(100, boundary=40, window=20, threshold=40) == (41, 80)

    def test_roadmap_example_cadence_end_to_end(self) -> None:
        # ROADMAP section 5: summary 1-40 / recent 41-60 compacts to
        # summary 1-60 / recent 61-80 — one batch per threshold crossing.
        first = archive_range(60, boundary=0, window=20, threshold=40)
        second = archive_range(100, boundary=first[1], window=20, threshold=40)
        assert first == (1, 40)
        assert second == (41, 80)

    def test_total_at_or_below_window_never_triggers(self) -> None:
        self.assertIsNone(archive_range(20, boundary=0, window=20, threshold=40))
        self.assertIsNone(archive_range(5, boundary=0, window=20, threshold=40))

    def test_boundary_equal_to_total_never_retriggers(self) -> None:
        self.assertIsNone(archive_range(500, boundary=500, window=20, threshold=40))

    def test_explicit_window_and_threshold_win_over_defaults(self) -> None:
        assert archive_range(3, boundary=0, window=1, threshold=1) == (1, 2)

    def test_invalid_explicit_window_matrix(self) -> None:
        for bad in (0, -1, "5", 1.5, True, [5]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    archive_range(100, boundary=0, window=bad, threshold=40)

    def test_invalid_explicit_threshold_matrix(self) -> None:
        for bad in (0, -1, "5", 1.5, True, [5]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    archive_range(100, boundary=0, window=20, threshold=bad)

    def test_invalid_total_and_boundary_matrices(self) -> None:
        for bad in (-1, "9", 1.5, True, None):
            with self.subTest(total=bad):
                with self.assertRaises(ValueError):
                    archive_range(bad, boundary=0, window=20, threshold=40)
            with self.subTest(boundary=bad):
                with self.assertRaises(ValueError):
                    archive_range(100, boundary=bad, window=20, threshold=40)

    def test_boundary_beyond_total_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            archive_range(10, boundary=11, window=20, threshold=40)

    def test_plan_is_deterministic(self) -> None:
        assert archive_range(80, boundary=7, window=6, threshold=9) == archive_range(
            80, boundary=7, window=6, threshold=9
        )


# ---------------------------------------------------------------------------
# Session application against the real database.
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestSessionSummaryTrigger:
    @pytest.fixture
    def user(self, db):
        return get_user_model().objects.create_user(
            username="bob", email="bob@example.com", password="pw-123456"
        )

    @pytest.fixture
    def session(self, user):
        return Session.objects.create(user=user, title="Chat", topic="Traveling")

    def fill(self, session, count, *, offset=0):
        """Append an alternating assistant-first transcript of complete turns."""
        for i in range(offset + 1, offset + count + 1):
            role = Message.Role.ASSISTANT if i % 2 == 1 else Message.Role.USER
            Message.append(session, role=role, content=f"turn {i}", status=Message.Status.COMPLETE)

    @staticmethod
    def make_trigger(*outcomes):
        provider = ScriptedProvider(*outcomes)
        return SessionSummaryTrigger(provider), provider

    def test_short_conversation_is_a_no_op_without_provider_call(self, session):
        self.fill(session, WINDOW + THRESHOLD - 1)
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        assert trigger.update(session) is False

        assert provider.requests == []
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_exact_crossing_persists_summary_and_boundary(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        assert trigger.update(session) is True

        session.refresh_from_db()
        assert session.summary == SUMMARY_ONE
        assert session.summary_message_boundary == THRESHOLD
        assert len(provider.requests) == 1
        expected = [f"{'assistant' if i % 2 == 1 else 'user'}: turn {i}" for i in range(1, 41)]
        assert archived_lines(provider.requests[0]) == expected

    def test_first_compaction_omits_previous_summary_header(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        trigger.update(session)

        assert PREVIOUS_SUMMARY_HEADER not in provider.requests[0].messages[-1].content

    def test_recent_window_turns_are_never_summarized(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        trigger.update(session)

        prompt = provider.requests[0].messages[-1].content
        for recent in range(WINDOW + THRESHOLD + 1, WINDOW + THRESHOLD + WINDOW + 1):
            assert f"turn {recent}" not in prompt

    def test_immediate_repeat_does_not_resummarize(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        assert trigger.update(session) is True
        assert trigger.update(session) is False

        assert len(provider.requests) == 1
        session.refresh_from_db()
        assert session.summary_message_boundary == THRESHOLD
        assert session.summary == SUMMARY_ONE

    def test_second_batch_rolls_previous_summary_forward(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, _ = self.make_trigger(response(SUMMARY_ONE))
        assert trigger.update(session) is True

        self.fill(session, THRESHOLD, offset=WINDOW + THRESHOLD)
        trigger2, provider2 = self.make_trigger(response(SUMMARY_TWO))
        assert trigger2.update(session) is True

        session.refresh_from_db()
        assert session.summary == SUMMARY_TWO
        assert session.summary_message_boundary == 2 * THRESHOLD
        request = provider2.requests[0]
        prompt = request.messages[-1].content
        assert PREVIOUS_SUMMARY_HEADER in prompt
        assert SUMMARY_ONE in prompt
        expected = [
            f"{'assistant' if i % 2 == 1 else 'user'}: turn {i}"
            for i in range(THRESHOLD + 1, 2 * THRESHOLD + 1)
        ]
        assert archived_lines(request) == expected

    def test_incomplete_rows_are_skipped_but_boundary_covers_them(self, session):
        self.fill(session, 30)
        failed = Message.append(
            session,
            role=Message.Role.ASSISTANT,
            content="",
            status=Message.Status.FAILED,
        )
        self.fill(session, 30)
        total = failed.sequence + 30
        trigger, provider = self.make_trigger(response(SUMMARY_ONE))

        with override_settings(CONTEXT_SUMMARY_TRIGGER_THRESHOLD=25):
            assert trigger.update(session) is True

        session.refresh_from_db()
        assert session.summary_message_boundary == total - WINDOW
        lines = archived_lines(provider.requests[0])
        # The blank failed row contributed nothing; every summarized line has text.
        assert len(lines) == total - WINDOW - 1
        assert all(line.split(": ", 1)[1].strip() for line in lines)

    def test_provider_failure_leaves_session_untouched_and_range_retryable(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, provider = self.make_trigger(
            LLMAvailabilityError("upstream down"),
            response(SUMMARY_ONE),
        )

        with pytest.raises(LLMAvailabilityError):
            trigger.update(session)

        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

        assert trigger.update(session) is True
        session.refresh_from_db()
        assert session.summary == SUMMARY_ONE
        assert session.summary_message_boundary == THRESHOLD
        # Both attempts targeted exactly the same range.
        assert archived_lines(provider.requests[0]) == archived_lines(provider.requests[1])

    def test_unusable_summary_output_propagates_without_persisting(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, _ = self.make_trigger(LLMResponseError("blank"))

        with pytest.raises(LLMResponseError):
            trigger.update(session)

        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == 0

    def test_empty_filtered_batch_advances_boundary_without_provider_call(self, session):
        # Pathological range: only blank failed assistant rows inside it.
        for _ in range(WINDOW + THRESHOLD):
            Message.append(
                session,
                role=Message.Role.ASSISTANT,
                content="",
                status=Message.Status.FAILED,
            )
        trigger, provider = self.make_trigger()

        assert trigger.update(session) is True

        assert provider.requests == []
        session.refresh_from_db()
        assert session.summary == ""
        assert session.summary_message_boundary == THRESHOLD

    def test_database_row_is_refetched_not_the_passed_instance(self, session):
        self.fill(session, WINDOW + THRESHOLD)
        stale = Session.objects.get(pk=session.pk)
        Session.objects.filter(pk=session.pk).update(summary="pre-existing")
        trigger, provider = self.make_trigger(response(SUMMARY_TWO))

        assert trigger.update(stale) is True

        session.refresh_from_db()
        # previous_summary came from the DATABASE row, not the stale instance.
        assert "pre-existing" in provider.requests[0].messages[-1].content
        assert session.summary_message_boundary == THRESHOLD

    def test_success_logging_carries_no_payloads(self, session, caplog):
        self.fill(session, WINDOW + THRESHOLD)
        trigger, _ = self.make_trigger(response(SUMMARY_ONE))

        with caplog.at_level(logging.DEBUG, logger="conversations.trigger"):
            trigger.update(session)

        joined = "\n".join(record.getMessage() for record in caplog.records)
        assert "session=" in joined
        assert "turn 1" not in joined
        assert SUMMARY_ONE not in joined
