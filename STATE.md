# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-10-22
- **Current Phase**: TASK-SENT-015 complete (FSRS/Anki scheduling); Real-life sentences feature delivered — next task: none

## Current Active Task
  - **Task ID**:
  - **Sub-steps**:
  - [ ]
  - **Status**: Empty

## Known Limitations
  - Practice sessions contain only due cards, capped at 20; there is deliberately no
    "practice ahead" mode.
  - The `suspended` flag is excluded from practice sessions, but no UI action suspends a
    sentence yet.
  - FSRS parameter optimization runs offline: the app stores the optimized weight vector
    and exports Anki-shaped revlog history (`listReviewHistoryForOptimization`), but the
    training tool (`@open-spaced-repetition/binding`) is not bundled in the app.
  - Interval fuzz is enabled (Anki default) and seeded per card, so a button preview and
    the saved interval agree for that card.
  - Real-life sentences are available in serverless mode only; server mode shows an
    explicit mode notice and performs no sentence-bank reads.
  - The backend SQLite fallback (`DB_ENGINE=sqlite3 uv run pytest`) has one pre-existing,
    unrelated test failure when `POSTGRES_PASSWORD` is empty; the full backend suite
    passes against Postgres (`1151 passed`).

## Unhandled Errors
  - (Only record errors or context BLOCKING the current Task. Leave blank if none)
