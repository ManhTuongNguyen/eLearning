# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-28
- **Current Phase**: TASK-AUDIT-009 complete; next task TASK-AUDIT-010 — Remove hard-coded backend server configuration

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
- TASK-AUDIT-007 (done): the vocabulary save flow no longer shows the
  redundant second confirmation. Pressing `Save word` in the selection sheet
  closes it and fires the save immediately (saveVocabularySelection now
  performs the whole round-trip that the removed confirmVocabularySave
  owned): POST /api/v1/vocabulary/ through the central authed requester,
  source-message attribution for real rows only, same stale-response guard
  (vocabSaveRequestRef + session-change invalidation). Success flashes the
  existing self-dismissing 'Saved to vocabulary' toast; failure now surfaces
  the normalized toErrorMessage as an alert toast (role="alert",
  errorText-colored toast variant) instead of the popup's inline error —
  still useful feedback, still async with respect to enrichment. ChatScreen
  state trimmed to toast only (VocabToast {text, kind}); VocabularySaveSheet
  component and its test file deleted.
- Regression coverage: ChatScreen.test.tsx 'vocabulary save flow
  (TASK-070, TASK-AUDIT-007)' — Save word calls the API immediately with
  expression+source (no popup ever), selection-sheet Cancel never calls the
  API, success toast auto-dismisses (fake timers), failure → alert toast
  with the friendly unreachable-server copy and re-save succeeds from a
  fresh selection; selection describe asserts immediate save on confirm.
  vocabularyJourney.test.tsx both journeys updated (no chat-vocab-modal,
  success toast dismissal, failure toast + empty list). serverlessJourney
  gate test asserts the typed ServerApiBlockedError message via the toast.
  Full suites: mobile pnpm test 629 passed; pnpm lint and pnpm typecheck
  clean.
- TASK-AUDIT-008 (done): the post-login "No conversation yet" bug is fixed
  at both of its sources. (1) ChatScreen's param-less landing route (the
  post-login/post-restore destination) now derives its state from the
  authoritative history instead of claiming the empty state: a page-1
  listSessions lookup (server) or local listSessions read (serverless)
  opens the most recent conversation by REPLACING the param-less route in
  place (replace, not push — the empty landing has no back story), shows a
  distinct loading spinner while checking, renders "No conversation yet"
  only for a confirmed-empty history, and surfaces a failed lookup as the
  error state + chat-retry (never a false empty claim). A stale closure
  pitfall was caught by the tests: navigation.isFocused() from the effect
  closure answers with the MOUNT-time focus state, so focus/blur listeners
  keep restoreFocusedRef in sync and the async lookup reads the current
  visibility; a focus event re-runs the check (restoreKey + in-flight/run
  refs) so a lookup that settled while the user was elsewhere never leaves
  a stale state, and conversations created while the landing sat in the
  stack are picked up on return. Loading initial state is now always true
  (no one-frame empty flash), and the empty hint was trimmed to
  "Start a new conversation to practice English." since the state is only
  reachable when history is genuinely empty. (2) HistoryScreen now
  re-derives its state from the authoritative source whenever it REGAINS
  focus (silent refreshOnFocus): the fresh page replaces the visible rows
  in place — never a spinner wipe — so returning to a mounted History picks
  up conversations created/renamed/deleted elsewhere and never shows a
  stale list; a failed silent refresh keeps visible rows and only escalates
  an empty screen to the error banner; all list reads (mount load, reload,
  focus refresh, pagination) are arbitrated by one monotonic
  listRequestRef so a slow stale response can never overwrite fresh data.
- Regression coverage: ChatScreen.test.tsx — no-conversation state only
  after the lookup confirms empty (pending lookup shows chat-loading),
  most-recent conversation opened in place after login (TASK-AUDIT-008),
  lookup failure shows form-error + retry and the retry lands in the
  recovered conversation, deferred-resolve + refocus re-check opens the
  most recent conversation (history-stub-back harness); HistoryScreen.test
  .tsx — returning to a mounted History silently refreshes (rows stay
  visible, no history-loading, authoritative page replaces in place) and a
  failed returning refresh keeps rows without a false empty state
  (chat-stub-back harness); authJourney.test.tsx end-to-end — login with
  existing server conversations lands in the most recent conversation
  (composer + listMessages(9)), chat-no-session never shown. Supporting
  updates: sessions API mocked with empty-history defaults in
  navigation/App/serverlessJourney/NewConversation/VocabularyScreen/auth
  Journey suites (real fetch attempts previously absent would now occur),
  vocabularyJourney capture flow uses the topmost Chat instance (the
  auto-restored landing is a second mounted instance), theme.test AuthContext
  mock completed with toErrorMessage. Full suites: mobile pnpm test 635
  passed; pnpm lint and pnpm typecheck clean.
- TASK-AUDIT-009 (done): chat bubbles no longer collapse to ~55% width.
  Root cause: the bubble's `maxWidth: '82%'` sat on the Pressable inside the
  previously UNSTYLED inner View wrapper — an auto-width flex item of the row —
  so the percentage resolved against a content-driven width instead of the
  screen: bubbles rendered far narrower than intended and short words
  ("Hello") wrapped mid-word. Fix in MessageRow.tsx: the width cap moved to a
  new `bubbleWrapper` style applied to the wrapper flex item (whose parent
  row has a definite width) — `maxWidth: '85%'` + `flexShrink: 1` so long
  content shrinks to the cap while short content keeps a hug-fit bubble;
  `bubble` lost its maxWidth and fills the capped wrapper (cross-axis
  stretch). User rows keep `justifyContent: 'flex-end'` (right edge,
  16px listContent inset); assistant rows stay flex-start. Text wrapping
  untouched (no numberOfLines anywhere) — Android TextView force-breaks
  over-long words/URLs at the wrapper cap, so nothing overflows the screen.
  Regression coverage: new mobile/__tests__/messageRowLayout.test.tsx (5
  tests, RNTL instance-tree style flattening): cap lives on the wrapper not
  the bubble, user rows right-aligned, assistant rows left-aligned, text
  wrapping enabled (numberOfLines undefined, no width/maxWidth on the Text),
  long content renders inside the capped wrapper. Full suites: mobile pnpm
  test 640 passed; pnpm lint and pnpm typecheck clean.
