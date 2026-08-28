"""Tests for the user-message creation service (conversations.chat, TASK-040)."""

import dataclasses
import logging

import pytest
from django.contrib.auth import get_user_model
from django.db import connection

import conversations.chat as chat_module
from conversations.chat import PreparedTurn, UserMessageService
from conversations.context import SUMMARY_HEADER, ContextBuilder
from conversations.models import Message, Session
from conversations.topics import GeneratedTopic
from llm.types import CompletionRequest

pytestmark = pytest.mark.django_db

SECRET_TEXT = "SECRET-TURN-TEXT-MARKER"


def drain_on_commit_callbacks():
    """Run and clear pending transaction.on_commit callbacks.

    Django 6 removed captureOnCommitCallbacks; tests drain
    ``connection.run_on_commit`` manually (entries are ``(sids, func,
    robust)`` tuples).
    """
    callbacks, connection.run_on_commit = connection.run_on_commit, []
    return [func for _sids, func, _robust in callbacks]


class RecordingBuilder:
    """ContextBuilder stand-in that records build() kwargs."""

    def __init__(self, *, error=None) -> None:
        self.request = CompletionRequest.from_texts([("system", "sys"), ("user", "cur")])
        self.error = error
        self.calls: list[dict] = []

    def build(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.request


class ScheduleRecorder:
    def __init__(self) -> None:
        self.calls: list[int] = []

    def __call__(self, session_id: int) -> None:
        self.calls.append(session_id)


def seed_history(session, count: int) -> None:
    """Append ``count`` alternating complete turns labeled "turn 1".."turn N"."""
    for index in range(count):
        content = f"turn {index + 1}"
        if index % 2 == 0:
            Message.append(session, role=Message.Role.USER, content=content)
        else:
            Message.append(
                session,
                role=Message.Role.ASSISTANT,
                content=content,
                status=Message.Status.COMPLETE,
            )


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user(
        username="alice", email="alice@example.com", password="pw-123456"
    )


@pytest.fixture
def stranger(db):
    return get_user_model().objects.create_user(
        username="bob", email="bob@example.com", password="pw-123456"
    )


@pytest.fixture
def session(user):
    return Session.objects.create(
        user=user, title="Traveling", topic="Planning a trip to Lisbon", learning_level="B2"
    )


@pytest.fixture
def service():
    return UserMessageService()


@pytest.fixture
def schedule_recorder(monkeypatch):
    recorder = ScheduleRecorder()
    monkeypatch.setattr(chat_module, "schedule_session_summary_update", recorder)
    return recorder


# ---------------------------------------------------------------------------
# Value object.
# ---------------------------------------------------------------------------


class TestPreparedTurn:
    def test_is_frozen_with_expected_fields(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert isinstance(prepared, PreparedTurn)
        assert dataclasses.is_dataclass(prepared)
        with pytest.raises(dataclasses.FrozenInstanceError):
            prepared.request = None
        assert prepared.user_message.role == Message.Role.USER
        assert prepared.assistant_message.role == Message.Role.ASSISTANT
        assert prepared.request is not None


# ---------------------------------------------------------------------------
# Input validation (nothing written on rejection).
# ---------------------------------------------------------------------------


class TestTextValidation:
    @pytest.mark.parametrize("bad", [None, 5, b"hello", ["hello"], {"t": 1}])
    def test_non_string_text_rejected_without_writes(self, service, session, user, bad):
        with pytest.raises(ValueError, match="text must be a string"):
            service.create_turn(session_id=session.pk, user=user, text=bad)
        assert Message.objects.count() == 0

    @pytest.mark.parametrize("bad", ["", "   ", "\n\t ", " \r\n"])
    def test_blank_text_rejected_without_writes(self, service, session, user, bad):
        with pytest.raises(ValueError, match="text must not be empty"):
            service.create_turn(session_id=session.pk, user=user, text=bad)
        assert Message.objects.count() == 0

    def test_stored_and_sent_text_is_stripped(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="  Hello there \n")

        assert prepared.user_message.content == "Hello there"
        assert prepared.request.messages[-1].content == "Hello there"


# ---------------------------------------------------------------------------
# Ownership.
# ---------------------------------------------------------------------------


class TestOwnership:
    def test_strangers_session_is_does_not_exist(self, service, session, stranger):
        with pytest.raises(Session.DoesNotExist):
            service.create_turn(session_id=session.pk, user=stranger, text="Hi")
        assert Message.objects.count() == 0

    def test_missing_session_is_does_not_exist(self, service, session, user):
        missing = Session.objects.order_by("pk").last().pk + 1
        with pytest.raises(Session.DoesNotExist):
            service.create_turn(session_id=missing, user=user, text="Hi")
        assert Message.objects.count() == 0


# ---------------------------------------------------------------------------
# Persisted rows and generation state.
# ---------------------------------------------------------------------------


class TestCreatedRows:
    def test_fresh_session_gets_sequences_one_and_two(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert prepared.user_message.sequence == 1
        assert prepared.assistant_message.sequence == 2

    def test_rows_persisted_with_expected_states(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        user_row = Message.objects.get(pk=prepared.user_message.pk)
        assistant_row = Message.objects.get(pk=prepared.assistant_message.pk)
        assert user_row.session == session
        assert user_row.role == Message.Role.USER
        assert user_row.status == Message.Status.COMPLETE
        assert user_row.content == "Hi"
        assert assistant_row.session == session
        assert assistant_row.role == Message.Role.ASSISTANT
        assert assistant_row.status == Message.Status.PENDING
        assert assistant_row.content == ""
        assert assistant_row.is_retryable is False

    def test_second_turn_continues_sequence(self, service, session, user):
        service.create_turn(session_id=session.pk, user=user, text="First")
        prepared = service.create_turn(session_id=session.pk, user=user, text="Second")

        assert (prepared.user_message.sequence, prepared.assistant_message.sequence) == (3, 4)
        assert session.messages.count() == 4


# ---------------------------------------------------------------------------
# Request assembly.
# ---------------------------------------------------------------------------


class TestRequestAssembly:
    def test_fresh_session_request_shape(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        messages = prepared.request.messages
        assert [m.role for m in messages] == ["system", "user"]
        assert messages[-1].content == "Hi"
        assert prepared.request.model is None
        assert prepared.request.temperature is None

    def test_history_included_verbatim_chronological(self, service, session, user):
        seeded = []
        for index in range(4):
            if index % 2 == 0:
                message = Message.append(
                    session, role=Message.Role.USER, content=f"turn {index + 1}"
                )
            else:
                message = Message.append(
                    session,
                    role=Message.Role.ASSISTANT,
                    content=f"turn {index + 1}",
                    status=Message.Status.COMPLETE,
                )
            seeded.append((message.role, message.content))

        prepared = service.create_turn(session_id=session.pk, user=user, text="new turn")
        middle = prepared.request.messages[1:-1]

        assert [(m.role, m.content) for m in middle] == seeded

    def test_window_limits_history_to_configured_tail(self, service, settings, session, user):
        settings.CONTEXT_RECENT_MESSAGE_WINDOW = 5
        seed_history(session, 9)

        prepared = service.create_turn(session_id=session.pk, user=user, text="new turn")

        contents = [m.content for m in prepared.request.messages]
        assert len(contents) == 7  # system + 5 windowed + current
        for index in range(1, 5):  # turns 1-4 left the window
            assert f"turn {index}" not in contents
        assert contents[1:-1] == [f"turn {i}" for i in range(5, 10)]
        assert contents[-1] == "new turn"

    def test_archived_head_excluded_once_boundary_advanced(self, service, session, user):
        seed_history(session, 12)
        Session.objects.filter(pk=session.pk).update(summary_message_boundary=8)

        prepared = service.create_turn(session_id=session.pk, user=user, text="new turn")

        contents = [m.content for m in prepared.request.messages]
        for index in range(1, 9):  # covered by the rolling summary
            assert f"turn {index}" not in contents
        assert contents[1:-1] == [f"turn {i}" for i in range(9, 13)]

    def test_context_size_bounded_with_summary_and_advanced_boundary(
        self, service, settings, session, user
    ):
        settings.CONTEXT_RECENT_MESSAGE_WINDOW = 5
        seed_history(session, 14)
        Session.objects.filter(pk=session.pk).update(
            summary="Rolling summary of turns 1-9.", summary_message_boundary=9
        )

        prepared = service.create_turn(session_id=session.pk, user=user, text="new turn")

        messages = prepared.request.messages
        # Context size boundary: system + window + current, no matter how much
        # history exists — the summarized head never re-enters the request.
        assert len(messages) == 1 + 5 + 1
        contents = [m.content for m in messages]
        for index in range(1, 10):  # turns 1-9 covered by the rolling summary
            assert f"turn {index}" not in contents
        assert contents[1:-1] == [f"turn {i}" for i in range(10, 15)]
        assert contents[-1] == "new turn"
        # The stored rolling summary is reused verbatim for this turn.
        assert SUMMARY_HEADER in messages[0].content
        assert "Rolling summary of turns 1-9." in messages[0].content

    def test_failed_and_pending_assistant_rows_excluded_from_history(self, service, session, user):
        Message.append(session, role=Message.Role.USER, content="before failure")
        Message.append(
            session,
            role=Message.Role.ASSISTANT,
            content=SECRET_TEXT,
            status=Message.Status.FAILED,
        )
        Message.append(session, role=Message.Role.ASSISTANT, status=Message.Status.PENDING)

        prepared = service.create_turn(session_id=session.pk, user=user, text="after failure")

        assert all(m.content != SECRET_TEXT for m in prepared.request.messages)
        assert [m.content for m in prepared.request.messages[1:-1]] == ["before failure"]

    def test_summary_section_present_when_set(self, service, session, user):
        Session.objects.filter(pk=session.pk).update(summary="Learner prefers past tense.")

        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        system_text = prepared.request.messages[0].content
        assert SUMMARY_HEADER in system_text
        assert "Learner prefers past tense." in system_text

    def test_no_summary_section_when_blank(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert SUMMARY_HEADER not in prepared.request.messages[0].content

    def test_topic_reconstructed_from_session_fields(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        system_text = prepared.request.messages[0].content
        assert 'Conversation topic: "Traveling".' in system_text
        assert "Topic scenario: Planning a trip to Lisbon" in system_text

    def test_concrete_level_line_from_session(self, service, session, user):
        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert "The learner's English level is B2" in prepared.request.messages[0].content

    def test_auto_level_line_from_session(self, service, user):
        auto_session = Session.objects.create(user=user, title="T", topic="D")

        prepared = service.create_turn(session_id=auto_session.pk, user=user, text="Hi")

        assert "The learner's English level is unknown" in prepared.request.messages[0].content


# ---------------------------------------------------------------------------
# Transactional persistence and scheduling.
# ---------------------------------------------------------------------------


class TestTransactionalPersistence:
    def test_builder_failure_rolls_back_both_rows(self, session, user):
        service = UserMessageService(context_builder=RecordingBuilder(error=RuntimeError("boom")))

        with pytest.raises(RuntimeError, match="boom"):
            service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert Message.objects.count() == 0
        assert Session.objects.filter(pk=session.pk).exists()

    def test_rollback_schedules_nothing(self, session, user, schedule_recorder):
        service = UserMessageService(context_builder=RecordingBuilder(error=RuntimeError("boom")))

        with pytest.raises(RuntimeError):
            service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert schedule_recorder.calls == []
        drain_on_commit_callbacks()
        assert schedule_recorder.calls == []

    def test_success_enqueues_summary_update_once_after_commit(
        self, service, session, user, schedule_recorder
    ):
        service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert schedule_recorder.calls == []  # nothing before commit
        callbacks = drain_on_commit_callbacks()
        assert len(callbacks) == 1
        callbacks[0]()
        assert schedule_recorder.calls == [session.pk]

    def test_every_turn_schedules_its_own_update(self, service, session, user, schedule_recorder):
        service.create_turn(session_id=session.pk, user=user, text="one")
        service.create_turn(session_id=session.pk, user=user, text="two")

        callbacks = drain_on_commit_callbacks()
        assert len(callbacks) == 2
        for callback in callbacks:
            callback()
        assert schedule_recorder.calls == [session.pk, session.pk]

    def test_real_builder_used_by_default(self, service):
        assert isinstance(service._context_builder, ContextBuilder)


class TestBuilderInjection:
    def test_injected_builder_receives_assembly_inputs(self, session, user):
        builder = RecordingBuilder()
        service = UserMessageService(context_builder=builder)
        Message.append(session, role=Message.Role.USER, content="history turn")

        prepared = service.create_turn(session_id=session.pk, user=user, text="  current  ")

        assert len(builder.calls) == 1
        kwargs = builder.calls[0]
        assert kwargs["level"] == "B2"
        assert isinstance(kwargs["topic"], GeneratedTopic)
        assert kwargs["topic"] == GeneratedTopic(
            title="Traveling", description="Planning a trip to Lisbon"
        )
        assert kwargs["summary"] == ""
        assert tuple(kwargs["recent_messages"]) == (("user", "history turn"),)
        assert kwargs["current_message"] == "current"
        assert prepared.request == builder.request

    def test_injected_builder_request_returned_verbatim(self, session, user):
        builder = RecordingBuilder()
        service = UserMessageService(context_builder=builder)

        prepared = service.create_turn(session_id=session.pk, user=user, text="Hi")

        assert prepared.request is builder.request


# ---------------------------------------------------------------------------
# Logging hygiene.
# ---------------------------------------------------------------------------


class TestLogging:
    def test_success_log_carries_ids_but_never_text(self, service, session, user, caplog):
        with caplog.at_level(logging.INFO, logger="conversations.chat"):
            service.create_turn(session_id=session.pk, user=user, text=f"hello {SECRET_TEXT} world")

        lines = [record.getMessage() for record in caplog.records]
        assert any("chat turn created" in line for line in lines), lines
        assert any(str(session.pk) in line for line in lines)
        assert all(SECRET_TEXT not in line for line in lines)
