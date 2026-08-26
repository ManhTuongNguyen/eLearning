"""Tests for the vocabulary CSV export API (vocabulary.VocabularyExportView, TASK-074).

Covers authenticated-only access, per-user scoping (the export contains only
the caller's saved expressions), download response contract (``text/csv``
content type and attachment filename), newest-first row order matching the
list endpoint, RFC 4180 escaping and Unicode surviving the full HTTP
round-trip, and an empty-vocabulary export that yields just the header row.
"""

import csv
import io

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from vocabulary.models import VocabularyItem

pytestmark = pytest.mark.django_db

EXPORT_URL = "/api/v1/vocabulary/export/"

USERNAME = "alice"
EMAIL = "alice@example.com"
PASSWORD = "pw-123456"

CSV_HEADER = "Front,Back,Example,Pronunciation"


def make_item(user, expression="set off", **overrides):
    fields = {
        "user": user,
        "expression": expression,
        "normalized_expression": VocabularyItem.normalize_expression(expression),
    }
    fields.update(overrides)
    return VocabularyItem.objects.create(**fields)


def export_rows(api):
    """Fetch the export and round-trip it through the stdlib CSV reader."""
    text = api.get(EXPORT_URL).content.decode("utf-8")
    return list(csv.reader(io.StringIO(text, newline="")))


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def user():
    return get_user_model().objects.create_user(
        username=USERNAME,
        email=EMAIL,
        password=PASSWORD,
    )


@pytest.fixture
def authed_api(api, user):
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def stranger():
    return get_user_model().objects.create_user(
        username="stranger",
        email="stranger@example.com",
        password="pw-123456",
    )


class TestAuthentication:
    def test_anonymous_export_is_rejected(self, api, user):
        make_item(user)

        response = api.get(EXPORT_URL)

        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestDownloadContract:
    def test_returns_200_with_csv_content_type(self, authed_api):
        response = authed_api.get(EXPORT_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response["Content-Type"] == "text/csv"

    def test_served_as_attachment_with_filename(self, authed_api):
        response = authed_api.get(EXPORT_URL)

        disposition = response["Content-Disposition"]
        assert disposition.startswith("attachment")
        assert 'filename="anki-vocabulary.csv"' in disposition


class TestExportContent:
    def test_empty_vocabulary_exports_header_only(self, authed_api):
        response = authed_api.get(EXPORT_URL)

        assert response.status_code == status.HTTP_200_OK
        assert response.content.decode("utf-8") == f"{CSV_HEADER}\r\n"

    def test_rows_follow_newest_first_ordering(self, authed_api, user):
        make_item(user, expression="first saved")
        make_item(user, expression="second saved")

        rows = export_rows(authed_api)

        expressions = [row[0] for row in rows[1:]]
        assert expressions == ["second saved", "first saved"]

    def test_enriched_fields_map_to_anki_columns(self, authed_api, user):
        make_item(
            user,
            expression="serendipity",
            definition="a happy accident",
            example="Finding this book was pure serendipity.",
            pronunciation="/ˌserənˈdɪpɪti/",
            translation="счастливая случайность",
            part_of_speech="noun",
            status=VocabularyItem.Status.COMPLETE,
        )

        rows = export_rows(authed_api)

        assert rows == [
            ["Front", "Back", "Example", "Pronunciation"],
            [
                "serendipity",
                "a happy accident",
                "Finding this book was pure serendipity.",
                "/ˌserənˈdɪpɪti/",
            ],
        ]

    def test_pending_items_export_with_empty_cells(self, authed_api, user):
        make_item(user, expression="gobsmacked")

        rows = export_rows(authed_api)

        assert rows[1] == ["gobsmacked", "", "", ""]

    def test_commas_quotes_and_newlines_survive_the_round_trip(self, authed_api, user):
        make_item(
            user,
            expression='set, "off"',
            definition="sense one\nsense two, with a comma",
        )

        rows = export_rows(authed_api)

        assert rows[1][0] == 'set, "off"'
        assert rows[1][1] == "sense one\nsense two, with a comma"
        assert len(rows[1]) == 4

    def test_unicode_is_preserved_verbatim(self, authed_api, user):
        make_item(
            user,
            expression="café — serendipité",
            definition="счастливая случайность · 縁",
        )

        rows = export_rows(authed_api)

        assert rows[1][0] == "café — serendipité"
        assert rows[1][1] == "счастливая случайность · 縁"


class TestUserScoping:
    def test_export_contains_only_the_caller_vocabulary(self, authed_api, stranger, user):
        make_item(stranger, expression="not mine")
        mine = make_item(user, expression="mine only")

        rows = export_rows(authed_api)

        assert [row[0] for row in rows[1:]] == [mine.expression]


class TestRouting:
    def test_export_is_mounted_on_the_documented_path(self):
        assert reverse("vocabulary:vocabulary-export") == EXPORT_URL
