"""Tests for the Anki CSV export service (vocabulary.csv_export, TASK-073).

Covers column mapping, RFC 4180 escaping of commas/quotes/newlines, Unicode
preservation, empty-field and empty-collection handling and input-order
preservation. The builder is pure, so no database is required.
"""

import csv
import io

from django.test import SimpleTestCase

from vocabulary.csv_export import CSV_COLUMNS, build_anki_csv
from vocabulary.models import VocabularyItem

HEADER = "Front,Back,Example,Pronunciation"


def make_item(**overrides):
    fields = {
        "expression": "set off",
        "definition": "to start a journey",
        "example": "We set off at dawn.",
        "pronunciation": "/set ɒf/",
    }
    fields.update(overrides)
    return VocabularyItem(**fields)


def parse_rows(csv_text):
    """Round-trip ``csv_text`` through the stdlib reader."""
    return list(csv.reader(io.StringIO(csv_text, newline="")))


class ColumnContract(SimpleTestCase):
    def test_header_row_matches_anki_columns(self) -> None:
        output = build_anki_csv([])

        assert output == f"{HEADER}\r\n"
        assert parse_rows(output)[0] == list(CSV_COLUMNS)

    def test_item_maps_to_front_back_example_pronunciation(self) -> None:
        item = make_item()

        rows = parse_rows(build_anki_csv([item]))

        assert rows == [
            ["Front", "Back", "Example", "Pronunciation"],
            ["set off", "to start a journey", "We set off at dawn.", "/set ɒf/"],
        ]

    def test_rows_preserve_input_order(self) -> None:
        items = [
            make_item(expression="zebra"),
            make_item(expression="apple"),
            make_item(expression="mango"),
        ]

        rows = parse_rows(build_anki_csv(items))

        assert [row[0] for row in rows[1:]] == ["zebra", "apple", "mango"]


class Escaping(SimpleTestCase):
    def test_commas_are_quoted_not_treated_as_separators(self) -> None:
        item = make_item(
            expression="set off",
            definition="to begin a trip, especially by vehicle",
        )

        rows = parse_rows(build_anki_csv([item]))

        assert rows[1][0] == "set off"
        assert rows[1][1] == "to begin a trip, especially by vehicle"
        assert len(rows[1]) == 4

    def test_double_quotes_are_doubled_inside_quoted_field(self) -> None:
        item = make_item(
            definition='He said "hello" loudly',
        )

        rows = parse_rows(build_anki_csv([item]))

        assert rows[1][1] == 'He said "hello" loudly'

    def test_newlines_stay_inside_one_field_and_one_row(self) -> None:
        item = make_item(
            definition="first sense\nsecond sense",
            example="Line one.\r\nLine two.",
        )

        output = build_anki_csv([item])
        rows = parse_rows(output)

        assert len(rows) == 2  # header + exactly one data row
        assert rows[1][1] == "first sense\nsecond sense"
        assert rows[1][2] == "Line one.\r\nLine two."

    def test_raw_output_quotes_special_fields_per_rfc_4180(self) -> None:
        item = make_item(
            expression='set, "off"',
            definition="line one\nline two",
        )

        output = build_anki_csv([item])

        data_line = output.split("\r\n")[1]
        assert data_line == '"set, ""off""","line one\nline two",We set off at dawn.,/set ɒf/'


class UnicodeAndEmptyFields(SimpleTestCase):
    def test_unicode_is_preserved_verbatim(self) -> None:
        item = make_item(
            expression="café — serendipité",
            definition="счастливая случайность · 縁",
            pronunciation="/ˌserənˈdɪpɪti/",
            example="Finding this book was pure serendipity. 🎉",
        )

        rows = parse_rows(build_anki_csv([item]))

        assert rows[1] == [
            "café — serendipité",
            "счастливая случайность · 縁",
            "Finding this book was pure serendipity. 🎉",
            "/ˌserənˈdɪpɪti/",
        ]

    def test_pending_item_with_empty_fields_exports_empty_cells(self) -> None:
        pending = VocabularyItem(
            expression="gobsmacked",
            normalized_expression="gobsmacked",
        )

        output = build_anki_csv([pending])
        rows = parse_rows(output)

        assert rows[1] == ["gobsmacked", "", "", ""]

    def test_partially_enriched_item_keeps_only_filled_cells(self) -> None:
        item = make_item(
            definition="utterly astonished",
            pronunciation="",
        )

        rows = parse_rows(build_anki_csv([item]))

        assert rows[1] == ["set off", "utterly astonished", "We set off at dawn.", ""]

    def test_multiple_mixed_items_each_render_one_row(self) -> None:
        complete = make_item()
        pending = VocabularyItem(
            expression="wanderlust",
            normalized_expression="wanderlust",
        )

        rows = parse_rows(build_anki_csv([complete, pending]))

        assert len(rows) == 3  # header + two data rows
        assert rows[2] == ["wanderlust", "", "", ""]
