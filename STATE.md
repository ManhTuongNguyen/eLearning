# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-28
- **Current Phase**: TASK-AUDIT-006 complete; next task TASK-AUDIT-007 — Simplify vocabulary save flow

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
- TASK-AUDIT-005 (done): the one-time access-token refresh wrapper is now a
  real central layer. auth/authedRequest.ts exports `createAuthedRequester`
  (framework-free): execute request → detect 401 → single-flight refresh →
  retry exactly once (original path+options retained, only the token is
  swapped) → refresh failure rethrows the original 401; the retry result is
  returned/thrown directly so no loop is possible, and the serverless gate
  (assertServerApiAllowed) fires before any auth/transport work so
  ServerApiBlockedError still surfaces in serverless even when signed out.
  AuthProvider supplies the hooks (restore-gate whenReady, getTokens,
  refreshAccess with its clearTokens/require-login side effects) — behavior
  identical to the previous inline implementation (all 16 AuthContext tests
  unchanged and green). Adoption: sessions.ts (8 bindings), profile.ts (2),
  vocabulary.ts save/list now take `AuthedRequester` instead of
  `token: string`, and every screen JSON call (Chat, History, Vocabulary,
  Level, NewConversation) routes through it — previously screens resolved a
  raw token and bypassed re-auth entirely, so a mid-session expiry surfaced
  as an error. Raw token remains only where the wrapper cannot apply: SSE
  streamChatTurn/streamRetryTurn and the raw-CSV exportVocabulary.
  Screen signed-out guards were dropped (the wrapper's signed-out
  ApiError(401) 'You are signed out. Please log in again.' replaces the
  per-screen 'You need to sign in again...' throws); LevelScreen additionally
  gained the explicit modeStatus gate (its old token-fetch suspension
  implicitly masked server-branch fetches before mode restore — the tests
  caught it).
- Regression coverage: authedRequest.test.ts (7 unit tests on the wrapper:
  normal request, 401→refresh→retry success with preserved method/body,
  refresh failure clears session + rethrows, retried 401 propagates without
  looping, non-401 untouched, signed-out rejection, 3 concurrent 401s share
  exactly one refresh); API binding tests use a fixed-token requester;
  screen/journey tests assert the requester arg. Full suites: mobile pnpm
  test 632 passed; pnpm lint and pnpm typecheck clean.
- TASK-AUDIT-006 (done): SettingsScreen now carries the same header back
  affordance as every other pushed screen (Level/OpenRouterSettings
  pattern): a `‹ Back` Pressable calling navigation.goBack() with testID
  `settings-back` and accessibilityLabel "Go back"; the "Settings" title
  moved into the header row (title style keeps fontSize 26, dropped its
  now-unneeded alignSelf). Android system back needs no BackHandler — the
  native stack pops by default, identical to goBack(); no duplicate stack
  entries are possible since goBack pops rather than navigates.
- Regression coverage: SettingsScreen.test.tsx back affordance renders and
  pops in both modes (goBack called once, navigate untouched); navigation
  test asserts via stack state that Chat -> Settings is exactly
  [Chat, Settings] and settings-back collapses it to [Chat] with the
  settings-screen gone. Full suites: mobile pnpm test 635 passed; pnpm
  lint and pnpm typecheck clean.
