# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-28
- **Current Phase**: TASK-AUDIT-004 complete; next task TASK-AUDIT-005 — Implement one-time access-token refresh wrapper

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
- TASK-AUDIT-003 (done): serverless entry/persistence. RootNavigator is now
  mode-aware: once the persisted mode is restored, `serverless` mounts the main
  stack directly (never the auth stack) regardless of auth status; server mode
  keeps the auth-gated switch. AuthProvider consumes an optional mode context
  (`useOptionalApplicationMode`, new export in mode/ModeContext.tsx): restore
  waits for the mode to settle and is skipped entirely while serverless — no
  keychain reads, no getMe/refresh requests; stored credentials stay untouched
  for a later switch back to server. LoginScreen gained a serverless entry
  (`login-serverless`, "Continue without an account") explaining on-device data
  + direct provider requests; pressing it flips the mode and the root navigator
  re-renders into the main stack. SettingsScreen now renders the account card
  and logout only in server mode. Supporting fixes: LevelScreen moved to the
  getAccessTokenRef pattern (TASK-048 convention) so auth-status settling no
  longer re-triggers local profile loads; ChatScreen's vocabulary save now goes
  through the runtime gate in serverless so the typed ServerApiBlockedError is
  surfaced instead of a silent no-op when no token exists.
- Regression coverage: navigation.test.tsx serverless root-switch (cold start
  bypasses login, no loadTokens/getMe), LoginScreen.test.tsx serverless entry
  (mode flip + persistence), SettingsScreen.test.tsx account/logout hidden in
  serverless, serverlessJourney.test.tsx cold-start test (no auth keychain, no
  fetch/XHR, account UI absent, restart keeps serverless). Full suites: mobile
  pnpm test 620 passed; pnpm lint and pnpm typecheck clean.
- TASK-AUDIT-004 (done): OpenRouter model discovery is now fully separated
  from token validation. openrouterClient.ts `requestModelCatalog` sends no
  Authorization header at all — the public GET /models endpoint is called
  keylessly — so `listOpenRouterModels()` needs no apiKey option and
  `OpenRouterClient.listModels()` is keyless too; `createOpenRouterClient`
  still enforces the key for actual LLM calls. OpenRouterSettingsScreen
  refreshes the catalog with no key gate ("Tap Refresh" copy instead of the
  key prompt). ModelInfo (types.ts) gained normalized canonicalSlug,
  architecture (modality/input/output modalities/tokenizer), pricing
  (prompt/completion/inputCacheRead) and topProvider (contextLength/
  maxCompletionTokens) + supportedParameters, all coerced safely with
  null/[] defaults: `normalizeModelEntry` parses the wire payload,
  `normalizeModelInfo` re-coerces cached snapshots so pre-extension entries
  read back complete (modelCatalog.parseCachedCatalog now backfills instead
  of trusting stale shapes; unusable entries still void the cache).
- Regression coverage: openrouterClient.test.ts keyless GET (no headers) with
  the documented hy4-preview payload, partial/malformed optional fields,
  error-hierarchy + option validation; modelCatalog.test.ts legacy-snapshot
  backfill; OpenRouterSettingsScreen.test.tsx refresh with no key stored or
  typed. Full suites: mobile pnpm test 625 passed; pnpm lint and pnpm
  typecheck clean.
