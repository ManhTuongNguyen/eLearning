# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-28
- **Current Phase**: TASK-AUDIT-002 complete; next task TASK-AUDIT-003 — Correct serverless mode entry and persistence

## Current Active Task
  - **Task ID**:
  - **Sub-steps**:
  - [ ]
  - **Status**: Empty

## Working Notes / Unhandled Errors
- TASK-AUDIT-001 (done): DRF 3.18 negotiates in `APIView.initial()` before auth;
  `Accept: text/event-stream` matched no renderer -> 406. Fix: per-view
  `content_negotiation_class = ServerSentEventNegotiation` (api/negotiation.py) on
  `MessageStreamView`, `MessageRetryView`, `LLMStreamView`. It accepts SSE requests
  and selects the JSON renderer so pre-stream errors (401/400/404/409) stay plain
  DRF JSON per the mobile client contract (mobile/src/api/chatStream.ts:248-252);
  unrelated invalid media types (e.g. application/xml) still return 406.
- TASK-AUDIT-002 (done): same failure mode for the vocabulary CSV export —
  `VocabularyExportView` had no negotiation override, so the mobile client's
  `Accept: text/csv` (mobile/src/api/vocabulary.ts:78) got 406 before the handler
  ran. Fix: extracted `JsonFallbackNegotiation` base in api/negotiation.py
  (shared `select_renderer` fallback logic) and added `CsvNegotiation`
  (`extra_media_type = text/csv`); `ServerSentEventNegotiation` now subclasses the
  base unchanged in behavior. Applied per-view on `VocabularyExportView`; success
  responses remain the raw `text/csv` HttpResponse, errors stay DRF JSON.
- Regression coverage: backend/tests/test_vocabulary_export_api.py::TestNegotiation
  (6 tests; verified 4/6 fail with the fix reverted — q-params, `text/*`, and the
  406-guard cases pass by default negotiation). Full suites: backend pytest 1057
  passed, mobile pnpm test 614 passed; ruff check/format clean; manage.py check clean.
