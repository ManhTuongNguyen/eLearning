# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-10-19
- **Current Phase**: TASK-SENT-016 complete; Real-life sentences feature delivered — next task: none

## Current Active Task
  - **Task ID**:
  - **Sub-steps**:
  - [ ]
  - **Status**: Empty

## Known Limitations
  - Practice sessions contain only due cards, capped at 20; there is deliberately no
    "practice ahead" mode.
  - The `suspended` sentence status exists in the schema and is excluded from practice,
    but no UI action suspends a sentence yet.
  - Real-life sentences are available in serverless mode only; server mode shows an
    explicit mode notice and performs no sentence-bank reads.
  - The backend SQLite fallback (`DB_ENGINE=sqlite3 uv run pytest`) has one pre-existing,
    unrelated test failure when `POSTGRES_PASSWORD` is empty; the full backend suite
    passes against Postgres (`1151 passed`).

## Unhandled Errors
  - (Only record errors or context BLOCKING the current Task. Leave blank if none)
