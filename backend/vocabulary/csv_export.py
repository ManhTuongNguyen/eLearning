"""Application-service layer for Anki-compatible CSV export (TASK-073).

Turns saved vocabulary items into a generic four-column CSV that Anki can
import directly as flashcards (ROADMAP "Vocabulary Data":

    Front         -> expression exactly as the learner selected it
    Back          -> definition produced by enrichment
    Example       -> enrichment example sentence
    Pronunciation -> enrichment IPA transcription

The builder is a pure function over any iterable of
:class:`~vocabulary.models.VocabularyItem`: it performs no database, LLM or
HTTP work, so the export endpoint (TASK-074) stays free to order, encode and
attach the result however it needs.

Escaping and line endings follow RFC 4180 via the standard-library ``csv``
module (CRLF terminators, minimal double-quote quoting): commas, double
quotes and newlines inside a field never break a row, Unicode is preserved
verbatim, and empty enrichment fields become empty cells so pending or
failed items still export as importable cards.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable

from vocabulary.models import VocabularyItem

CSV_COLUMNS = ("Front", "Back", "Example", "Pronunciation")


def build_anki_csv(items: Iterable[VocabularyItem]) -> str:
    """Render ``items`` as one Anki-importable CSV string.

    Rows appear in the order the iterable yields them — ordering (e.g. newest
    first) is the caller's concern. An empty iterable produces the bare header
    row, which Anki imports as zero cards instead of failing.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)  # RFC 4180: CRLF lines, minimal quoting
    writer.writerow(CSV_COLUMNS)
    for item in items:
        writer.writerow(
            [
                item.expression,
                item.definition,
                item.example,
                item.pronunciation,
            ]
        )
    return buffer.getvalue()


__all__ = ["CSV_COLUMNS", "build_anki_csv"]
