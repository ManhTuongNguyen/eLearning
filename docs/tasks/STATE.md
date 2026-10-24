# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-10-24
- **Current Phase**: Word bank feature complete (WORD_BANK_V1, TASK-WB-001 … TASK-WB-016)

## Completed Feature
- **Word bank** (serverless-only, `docs/tasks/WORD_BANK_V1.md`): all 16 tasks are
  `Status: [x]`. A learner can create topics with a learner-context description
  and optional additional prompt, generate 1–30 AI-chosen words per batch
  (AI chooses words only; the Free Dictionary API fills all senses and IPA),
  add words manually (comma-separated), keep/curate candidates in the review
  modal, fetch missing dictionary data and enrich words from Word detail
  (change-review modal; phonetics and FSRS state untouched), search and delete
  words, and practice with the FSRS schedule shared with the sentence bank —
  dictation for new/learning/relearning, masked-context recall for review —
  capped at 20 due cards per session, unlocked at 5 words. Everything persists
  in local SQLite (schema v7) and clears with "Clear local data".

## Current Active Task
  - **Task ID**:
  - **Sub-steps**:
  - [ ]
  - **Status**: Empty

## Unhandled Errors
  - None blocking. Note: `backend/` has no diff (`git status --porcelain backend/`
    is empty). With Docker unavailable, `DB_ENGINE=sqlite3 uv run pytest` (the
    documented fallback) gives 1147 passed / 3 skipped and exactly one
    pre-existing failure (`test_secret_handling.py::
    test_health_endpoint_never_exposes_secrets`) that is an artifact of the
    fallback config itself — it asserts an empty DB password is not "in" the
    health body, which is trivially false when no password is set. The full
    Postgres suite could not run in this environment (no Docker).

## Known Limitations (explicit, accepted for v1)
  - Irregular inflections (`ran` for `run`) are not masked on recall cards.
  - The dictionary client has no retry loop (a transient error keeps the word
    dataless until a manual fetch).
  - A word containing a comma cannot be entered manually (it splits).
  - The generation review modal operates on candidates the pipeline has
    already persisted: keep-all confirms, keep-selected removes the unticked
    rows, discard closes without writing.
