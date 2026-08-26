# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 10 TASK-065 complete (next: TASK-066 — vocabulary save API)

## Current Active Task

(none — TASK-065 completed; next: TASK-066 — Implement vocabulary save API.)

## Archived Tasks

### TASK-065 — Create vocabulary model (COMPLETED 2026-08-26)
- `backend/vocabulary/models.py` — `VocabularyItem` following the
  Session/Message conventions (docstring citing ROADMAP "Vocabulary", nested
  TextChoices, FKs to settings.AUTH_USER_MODEL):
  - `user` FK CASCADE related_name="vocabulary_items" (ownership enforced);
    `expression` TextField verbatim selection — words AND phrases with no
    arbitrary length cap; `normalized_expression` TextField as the trimmed/
    lowercase dedupe key.
  - DESIGN DECISION: NO hard unique constraint on (user,
    normalized_expression) yet — duplicate policy is TASK-066's "duplicate
    behavior is deterministic" call; the model ships a composite
    `(user, normalized_expression)` index instead so lookups are cheap and
    TASK-066 can choose upsert vs 409 without a migration rewrite.
  - Enrichment payload (`definition`, `translation`, `pronunciation`
    CharField(255), `part_of_speech` CharField(64), `example`) all blank/
    default "" — filled asynchronously by TASK-068; `status`
    pending/complete/failed defaulting to pending ("must support enrichment
    states"); `is_pending`/`is_enriched` convenience properties.
  - `source_message`/`source_session` nullable FKs on_delete=SET_NULL —
    deleting a conversation or message NEVER deletes saved vocabulary; only
    the source pointer is nulled. created_at auto_now_add / updated_at
    auto_now; Meta ordering newest-first (`-created_at`, matching the
    planned vocabulary screen).
- `backend/vocabulary/migrations/0001_initial.py` generated.
- `backend/tests/test_vocabulary_model.py` (34 tests): creation defaults +
  enrichment round-trip incl. unicode pronunciation; single-word and
  multi-word-phrase verbatim expressions; is_pending/is_enriched matrix;
  str/timestamps; ownership (related name, cascade, per-user isolation);
  source links + session-delete/message-delete survival with SET_NULL;
  newest-first ordering + composite-index presence; full_clean rejection of
  blank expression / blank normalized / missing user / invalid status;
  field-shape assertions for every column.
- Gates: uv run ruff check clean; ruff format --check clean (101 files);
  manage.py check clean; full pytest DB_ENGINE=sqlite3 → 832 passed /
  3 skipped / 293 subtests (+34 new; bare pytest still hits the
  PRE-EXISTING local Postgres auth issue; README sqlite3 fallback used).
- Acceptance: user ownership is enforced ✓ (FK cascade + isolation tests);
  expression can represent words and phrases ✓ (TextField + verbatim word/
  phrase round-trips); tests exist ✓ (34).

#### Sub-step record (all complete)
1. [x] backend/vocabulary/models.py — VocabularyItem + Status choices +
       Meta ordering/index
2. [x] Migration generated (vocabulary/migrations/0001_initial.py)
3. [x] backend/tests/test_vocabulary_model.py (34 tests)
4. [x] Gates green (ruff check/format; manage.py check; sqlite3 pytest 832)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-065

## Archived Tasks

### TASK-064 — Implement improvement result UI (COMPLETED 2026-08-26)
- `mobile/src/api/sessions.ts`:
  - `MessageImprovement {original, improved, explanation}` typed binding of
    the TASK-063 backend contract.
  - `improveMessage(token, sessionId, messageId)` — POST
    `/api/v1/sessions/{sid}/messages/{mid}/improve/` with empty body;
    failures normalize through apiRequest (409 invalid target, 404 foreign/
    missing, 503 retryable / 502 permanent provider).
- `mobile/src/screens/ImprovementSheet.tsx` (new):
  - Bottom-sheet card over dismissible backdrop mirroring
    MessageActionsMenu (slide-in, Close button + backdrop tap + Android
    back, accessibilityViewIsModal content, labeled controls).
  - Three mutually exclusive round-trip states inside one sheet:
    `chat-improvement-loading` spinner ("Checking your English…"),
    `role="alert"` `chat-improvement-error` banner, or the result body —
    "Your message" (original echoed verbatim), "Suggested improvement"
    highlighted card, "What changed" explanation.
  - Copy control (`chat-improvement-copy`) runs the improved text through
    the clipboard seam; copying never dismisses the sheet.
  - Result testIDs live on wrapper Views (project convention) so
    `within(...).getByText(...)` matches inner Text nodes.
- `mobile/src/screens/ChatScreen.tsx`:
  - `improvement` / `improvementLoading` / `improvementError` state plus an
    OWN monotonic request counter — same stale-guard shape as suggestions
    (session switched / newer request supersede late responses).
  - `startImprovement()` mirrors `startSuggestions`; wired as the
    `improve-english` branch in `handleMenuAction`.
  - `closeImprovement()` bumps the request counter before clearing state,
    so dismissing the sheet while a request is in flight can never let the
    late response reopen it.
  - Session-change effect resets all improvement state alongside
    suggestion state; the sheet is visible exactly while one of the three
    round-trip states is active. No send-path coupling needed (the modal
    blocks the composer while open).
  - Doc comments updated: improvement is no longer a seam; speech
    (TASK-078) is the remaining menu seam. MessageActionsMenu doc comment
    aligned too.
- Tests:
  - `__tests__/sessionsApi.test.ts` (+2): exact URL/method/body/headers for
    improveMessage and ApiError normalization of its 409 detail.
  - `__tests__/ChatScreen.test.tsx` (+7, describe "improvement UI
    (TASK-064)"): nothing rendered until requested; loading-first then
    full result; original bubble untouched (same rows, verbatim text);
    Copy emits exactly the improved text without closing; failure shows
    the friendly unreachable-server banner and recovers on a second
    attempt; Close during loading keeps the sheet closed when the response
    lands afterwards; improving another message replaces the shown result.
  - Recorded gotcha: assertions must await a RESULT-ONLY element
    (`findByTestId('chat-improvement-original')`) — the sheet root testID
    exists in every round-trip state, unlike the suggestions strip whose
    success testID differs from its loading/error ones.
- Gates green: `pnpm typecheck`, jest 18 suites / 221 tests passed,
  `pnpm lint` clean.
- SPEC.md marked [x]; STATE.md archived; commit `feat: complete TASK-064`.

### TASK-063 — Implement improvement API (COMPLETED 2026-08-26)
- `conversations/views.py`:
  - `get_improvement_service()` seam (`_settings_improvement_service`
    lru_cache) wrapping `ImprovementService(provider=FallbackProvider
    .from_settings())` — same settings-driven pattern as topic/suggestion
    services.
  - `MessageImprovementView` — POST
    `/api/v1/sessions/{pk}/messages/{message_pk}/improve/`, no body:
    user-scoped `Session.objects.get(pk, user)` then
    `session.messages.get(pk)` → foreign/missing session AND foreign/
    missing message are indistinguishable 404s (no existence leak);
    ONLY user messages are improvable — assistant rows in ANY generation
    state (complete/pending/failed) and any blank-content row → 409
    Conflict with ZERO provider calls; inputs from persisted state only
    (`level=session.learning_level`, stored content verbatim); LLMError →
    503 retryable / 502 permanent (SessionCollectionView mapping); success
    body `asdict(improvement)` = `{original, improved, explanation}` where
    original is the STRIPPED STORED text — a misbehaving completion's own
    "original" key can never override the learner's words. READ-ONLY:
    nothing persisted, no on_commit scheduling, stored row untouched.
- `conversations/urls.py` — `session-message-improve` route beside suggestions.
- `backend/tests/test_improvement_api.py` (27 tests): auth (401 zero-call,
  405 matrix); ownership/routing 404s (stranger session, missing session,
  foreign message in own session, missing message, non-int pks — each with
  zero provider calls); only-user-message matrix (complete/pending/failed
  assistant + blank user targets → 409 verbatim detail, data untouched);
  success (three-field JSON contract with stripped fields, [system,user]
  request shape, model echo + extra "original" key never replace stored
  text, prompt pins: B2 CEFR echo + quoted message vs AUTO infer-level
  wording, distinct prompts per distinct messages, repeated calls
  independent); failures (availability → 503 detail verbatim, auth → 502,
  LLMResponseError → 502); purity (row snapshot unchanged, on_commit
  callbacks untouched); wiring seam cached under OPENROUTER_API_KEY
  override_settings; log hygiene (no message/improved/explanation text at
  DEBUG).
- Test gotchas hit:
  - First draft of the echo-guard test double-encoded the payload
    (correction_payload already returns a JSON string wrapped again in
    json.dumps) which would 502 instead of proving the guard — replaced
    with an explicit extra-"original"-key fixture that exercises BOTH
    extra-key tolerance and stored-text precedence in one response.
- Gates: uv run ruff check clean; ruff format --check clean (100 files);
  manage.py check clean; full pytest DB_ENGINE=sqlite3 → 798 passed /
  3 skipped / 293 subtests (bare pytest still hits the PRE-EXISTING local
  Postgres auth issue; README sqlite3 fallback used).
- Acceptance: only user messages can use this action ✓ (assistant matrix
  pinned at every status); ownership is enforced ✓ (user-scoped lookups,
  indistinguishable 404s); existing message is not modified ✓ (snapshot +
  on_commit purity test, original composed from stored row); API tests
  exist ✓ (27).

#### Sub-step record (all complete)
1. [x] conversations/views.py — MessageImprovementView + service seam
2. [x] conversations/urls.py — improve route
3. [x] backend/tests/test_improvement_api.py (27 tests)
4. [x] Gates green (ruff check/format; manage.py check; sqlite3 pytest 798)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-063

## Archived Tasks

### TASK-062 — Implement improvement service (COMPLETED 2026-08-26)
- `backend/conversations/improvement.py` (new) — `ImprovementService` +
  frozen `Improvement` value object (`original`, `improved`,
  `explanation`) following the established topics.py/suggestions.py
  conventions (provider-injected `improve()`, never streams).
  - DESIGN DECISION: the LLM is asked ONLY for
    `{"improved", "explanation"}`; the service composes `original` from
    the VERBATIM stripped input. TASK-063/064 require the original message
    remain unchanged — trusting a model echo could let a paraphrase
    masquerade as the learner's words. The VO still carries all three
    fields per SPEC.
  - Input validation before ANY provider call (ValueError, zero requests):
    level ∈ Level.values, non-blank string original_message.
  - User prompt: improve-instruction header + level line (AUTO → infer
    appropriate level for the explanation; concrete CEFR echoed verbatim +
    "write the explanation so a learner at that level understands it") +
    quoted message. System prompt demands ONLY one JSON object with the
    exact two-key shape, fixes grammar/spelling/word choice/phrasing while
    preserving meaning and tone, explicitly allows improved == original for
    already-correct messages ("return it unchanged and say so briefly"),
    and pins explanation brevity (one or two short sentences).
  - Output validation: both fields non-empty strings stripped on ingest;
    wrong key names/blanks/non-strings → LLMResponseError(
    provider="improvement", model=served); extra keys ignored;
    fence/prose-tolerant `_extract_json_object`. Improved == original is
    LEGAL (already-correct path). Purity: nothing persisted, no DB access.
  - Logging hygiene: INFO logs model/duration only; WARNING logs the
    normalized error only; payload text never logged.
- `backend/tests/test_improvement_service.py` (25 tests + 43 subtests,
  all SimpleTestCase/mock-provider): frozen/comparing value object +
  non-blank field invariants; zero-call input-validation matrix (bad
  levels incl. lowercase/auto, blank/non-string message); happy paths
  (verbatim stripped fields + trimmed original, model echo NEVER used for
  original even when present, all levels accepted incl. AUTO,
  already-correct keeps improved == original, [system,user] request shape,
  prompt composition pins — JSON/two-key system prompt, message quote,
  concrete-level echo vs AUTO, distinct prompts per distinct messages,
  fenced + prose-wrapped + extra-keys tolerance); invalid-output matrix
  (23 shapes: prose/list/scalars/truncated/{}/wrong key names/missing/
  blank/non-string fields/python-fence/garbage → retryable=False,
  provider="improvement", served model attached); provider-failure
  passthrough (availability identical instance + retryable, auth error,
  non-LLM unmasked); logging hygiene (success log names model but no
  payload text; failure warning carries neither completion nor input).
- Gates: uv run ruff check clean; ruff format --check clean (99 files);
  manage.py check clean; full pytest DB_ENGINE=sqlite3 → 771 passed /
  3 skipped / 293 subtests (bare pytest still hits the PRE-EXISTING local
  Postgres auth issue; README sqlite3 fallback used).
- Acceptance: grammar/wording issues can be corrected ✓ (correction task
  pinned by system-prompt contract + parsed improved field); explanation
  is concise ✓ (brevity demanded in system prompt, level-appropriate via
  level line); valid structured output enforced ✓ (exhaustive invalid-
  output matrix); tests mock LLM behavior ✓ (FakeProvider seam, zero
  network).

#### Sub-step record (all complete)
1. [x] backend/conversations/improvement.py — ImprovementService +
       Improvement value object
2. [x] backend/tests/test_improvement_service.py (25 tests + 43 subtests)
3. [x] Gates green (ruff check/format; manage.py check; sqlite3 pytest 771)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-062

## Archived Tasks

### TASK-061 — Implement suggestion UI (COMPLETED 2026-08-26)
- `src/api/sessions.ts`: `MessageSuggestions {replies: string[]}` +
  `getMessageSuggestions(token, sessionId, messageId)` POST binding to
  `/api/v1/sessions/{sid}/messages/{mid}/suggestions/` with body {} and
  Bearer header (TASK-059 contract); apiRequest normalizes 404/409/503/
  502 into ApiError verbatim.
- `ChatScreen.tsx`:
  - State triple: `suggestions` ({messageId} + replies, null = hidden),
    `suggestionsLoading`, `suggestionsError`; plus
    `suggestionsRequestRef` monotonic request counter.
  - `startSuggestions(sid, messageId)` async-IIFE seam (onPress-safe void
    return): latest-ref token → fetchSuggestions → chips. Stale-response
    guards check BOTH sessionIdRef AND the request counter, so switching
    sessions or firing a newer selection never lets an older response
    land; the counter also arbitrates the loading flag in finally.
  - handleMenuAction 'suggest-replies' → startSuggestions (menu closes
    first); copy/improve/speak behavior unchanged.
  - Chip strip above the composer (below stream-error banner):
    loading spinner (`chat-suggestions-loading`) → error text role=alert
    (`chat-suggestions-error`) → three Pressable chips
    (`chat-suggestion-{0|1|2}`, role button, label "Insert suggested
    reply n+1"). Tapping sets the composer draft to the reply VERBATIM and
    dismisses the strip — insertion never sends (ROADMAP §8).
  - Clearing semantics: handleSend drops chips + error ("stale chips would
    offer replies to a conversation that has moved on"); load effect
    resets all triple state on session/reload change AND bumps the
    request counter to orphan any in-flight generation.
- Tests (+8 → 18 suites 212/212):
  - __tests__/sessionsApi.test.ts (+2): URL/method/body {}/Bearer +
    replies passthrough; 409 detail → ApiError(status/message).
  - __tests__/ChatScreen.test.tsx (+6 describe block): default-closed
    (no strip/loading/error, zero calls); select → exact args ('token-a',
    5, msgId) + deferred loading state → menu gone, no stream call,
    exactly three ordered verbatim chips; tap inserts into composer
    WITHOUT sending (mockedStream never called, turns empty), dismisses
    strip, Send re-enables; failure banner (/unreachable/ via 5xx
    mapping) then second selection succeeds and clears it; new selection
    replaces displayed chips (LastCalledWith the other message id);
    sending clears the strip while the turn renders.
  - beforeEach now defaults getMessageSuggestions to a resolved triple
    (the TASK-060 "dismisses without copying" test presses the action and
    must not hit an undefined mock).
- Test gotchas hit:
  - First draft of two tests relied on the beforeEach DEFAULT replies but
    asserted REPLIES — chips rendered 'Default reply one…' and getByText
    failed. Pin mockResolvedValueOnce({replies: REPLIES}) per test that
    asserts chip content; defaults are for tests that don't look at chips.
- Acceptance: suggestions can be tapped ✓ (role-button chips pinned);
  tapping inserts text into the composer ✓ (draft value verbatim);
  suggestions do not automatically send ✓ (zero stream calls pinned);
  loading/error states exist ✓ (deferred-promise spinner, 5xx banner +
  recovery path).
- Gates: pnpm typecheck clean; eslint clean; jest 18 suites 212/212.

#### Sub-step record (all complete)
1. [x] src/api/sessions.ts — MessageSuggestions + getMessageSuggestions
2. [x] ChatScreen.tsx — suggestion state triple + startSuggestions +
       chip strip + tap-to-insert + clear/reset semantics
3. [x] __tests__/sessionsApi.test.ts — binding tests (+2)
4. [x] __tests__/ChatScreen.test.tsx — suggestion UI block (+6)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 212/212 across 18 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-061

## Archived Tasks

### TASK-060 — Implement message long-press menu (COMPLETED 2026-08-26)
- `src/screens/MessageActionsMenu.tsx` (new) — presentational bottom-sheet
  action menu over a transparent RN Modal (fade): backdrop Pressable
  (`chat-menu-backdrop`) dismisses, sheet (`chat-menu`) does not, Close
  control (`chat-menu-close`, role button), Android back via onRequestClose,
  content container `chat-menu-content` with accessibilityViewIsModal.
  Role-driven action matrix exported as MessageAction union: user →
  [Suggest replies, Improve my English, Copy, Read aloud]
  (`chat-menu-{suggest-replies|improve-english|copy|speak}`); assistant drops
  improve-english. Every item role=button + label; `onSelect(action)` is a
  callback seam and the PARENT closes the menu.
- Behavior staging (same pattern as TASK-048 composer send preceding
  TASK-049's wire call): selection seams for suggestions (TASK-061),
  improvement (TASK-064) and speech (TASK-078). Copy has no later task, so
  it works NOW: new `src/utils/clipboard.ts` seam wrapping react-native's
  built-in Clipboard export (deprecated but functional in 0.81 — zero new
  native dependencies); tests auto-mock the seam module.
- `ChatScreen.tsx`: bubbles are now Pressables carrying onLongPress ONLY
  when the row is eligible (`status === 'complete'` + non-blank trimmed
  content) — pending spinners and failed rows carry no actionable text and
  are rejected suggestion targets server-side anyway. New `menuMessage`
  state (null = closed) reset by the load effect alongside the other
  overlays; `handleMenuAction` closes first then copies content for
  'copy'; menu mounted beside SampleConversationModal with
  role={menuMessage?.role ?? 'assistant'} so a closed menu renders nothing.
- Tests (+15 → 18 suites 204/204):
  - __tests__/MessageActionsMenu.test.tsx (8): closed renders nothing;
    assistant/user action matrices (exact order, improvement only for
    user); per-item role+label + viewIsModal container + close role;
    onSelect payload ('copy', 'improve-english'); backdrop+Close dismissal
    (sheet inert, exactly two onClose calls); Android back via
    onRequestClose; all actions inside the sheet.
  - __tests__/ChatScreen.test.tsx (+7 describe block): default-closed;
    long-press assistant row → exact assistant testID matrix; user row →
    includes chat-menu-improve-english; Copy copies verbatim content and
    closes; non-copy selection closes WITHOUT clipboard call; Close
    control closes; failed AND blank-complete rows never open the menu.
- Test gotchas hit:
  - RNTL v14 has NO fireEvent.longPress helper (typings reject it) — use
    the generic form fireEvent(el, 'longPress').
  - v14 TestInstance lacks findByProps — assert flags via props on a
    dedicated testID'd element instead of searching the tree.
  - A careless perl one-liner ate getByTestId's closing paren when
    rewriting longPress calls; verify rewrites with grep before typecheck.
  - The suite-wide "not configured to support act(...)" console noise is
    PRE-EXISTING (AuthContext startup restore in other suites): 91
    occurrences identically with and without this change; touched suites
    log nothing.
- Acceptance: correct actions appear by message type ✓ (both matrices
  pinned exactly, component-level and integration-level); menu dismisses
  correctly ✓ (Close, backdrop, action selection, Android back);
  accessibility behavior exists ✓ (role buttons + labels,
  accessibilityViewIsModal, dismissible controls).
- Gates: pnpm typecheck clean; eslint clean; jest 18 suites 204/204.

#### Sub-step record (all complete)
1. [x] src/screens/MessageActionsMenu.tsx — role-driven action menu modal
2. [x] src/utils/clipboard.ts — copyText seam; ChatScreen long-press wiring
       + handleMenuAction (copy now; suggest/improve/speak documented seams)
3. [x] __tests__/MessageActionsMenu.test.tsx (8 tests)
4. [x] __tests__/ChatScreen.test.tsx — long-press integration (+7)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 204/204 across 18 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-060

## Archived Tasks

### TASK-059 — Implement suggestion API (COMPLETED 2026-08-26)
- `conversations/views.py`:
  - `get_suggestion_service()` seam (`_settings_suggestion_service`
    lru_cache) wrapping `SuggestionService(provider=FallbackProvider
    .from_settings())` — same settings-driven pattern as topic service.
  - `MessageSuggestionsView` — POST
    `/api/v1/sessions/{pk}/messages/{message_pk}/suggestions/`, no body:
    user-scoped `Session.objects.get(pk, user)` then
    `session.messages.get(pk)` → foreign/missing session AND foreign/
    missing message are indistinguishable 404s (no existence leak);
    non-COMPLETE targets (pending/failed assistant rows, any blank-content
    row incl. the zero-delta empty-complete edge) → 409 Conflict with
    ZERO provider calls; inputs from persisted state only
    (`level=session.learning_level`, `GeneratedTopic(title=session.title,
    description=session.topic)`, selected content verbatim, prior COMPLETE
    history bounded by `select_recent_messages` window); LLMError → 503
    retryable / 502 permanent (SessionCollectionView mapping); success body
    `{"replies": [str×3]}` as a JSON list. READ-ONLY: nothing persisted,
    no on_commit scheduling.
- `conversations/urls.py` — `session-message-suggestions` route beside retry.
- `backend/tests/test_suggestions_api.py` (25 tests): auth (401 zero-call,
  405 matrix); ownership/routing 404s (stranger session, missing session,
  foreign message in own session, missing message, non-int pks — each with
  zero provider calls); invalid combinations (pending/failed/blank → 409,
  data untouched); success (exactly-three list contract + stripped replies +
  [system,user] request shape; prompt composition pins: level echo B2,
  topic title/scenario, prior-complete transcript only, selection marked
  not transcribed, later messages excluded, opening message → empty
  transcript; window=2 override bounds transcript to its tail; repeated
  calls independent); failures (availability → 503 detail verbatim, auth →
  502, LLMResponseError → 502); purity (row snapshot unchanged, on_commit
  callbacks untouched); wiring seam cached under OPENROUTER_API_KEY
  override_settings; log hygiene (no reply/selected text at DEBUG).
- Test gotchas hit:
  - `asdict()` keeps the frozen VO's tuple → DRF response.data compared
    unequal to a list; view serializes `list(suggestions.replies)` instead.
  - `@override_settings` DECORATOR silently did not activate on a pytest
    class method here (worked standalone via python -c) — context-manager
    form around api.post works and matches test_window.py convention.
  - Window-tail arithmetic: prior context includes ALL earlier messages
    including the learner's own pre-selection turn — with window=2 the tail
    is [SECRET-user-turn, old-a-2], not [old-q-2, old-a-2].
- Gates: uv run ruff check clean; ruff format --check clean; manage.py check
  clean; full pytest DB_ENGINE=sqlite3 → 746 passed / 3 skipped / 250
  subtests (bare pytest errors remain the PRE-EXISTING local Postgres auth
  issue; README sqlite3 fallback used).
- Acceptance: authentication and ownership enforced ✓ (401 anonymous;
  user-scoped lookups make foreign/missing indistinguishable 404s);
  invalid message/session combinations rejected ✓ (pending/failed/blank
  targets 409 with zero provider calls); API tests exist ✓ (25).

#### Sub-step record (all complete)
1. [x] conversations/views.py — MessageSuggestionsView + service seam
2. [x] conversations/urls.py — suggestions route
3. [x] backend/tests/test_suggestions_api.py (25 tests)
4. [x] Gates green (ruff check/format; manage.py check; sqlite3 pytest 746)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-059

### TASK-058 — Implement suggestion service (COMPLETED 2026-08-26)
- `backend/conversations/suggestions.py` (new) — `SuggestionService` +
  frozen `Suggestions` value object following the established
  topics.py/summarizer.py conventions (provider-injected `complete()`
  only — suggestions never stream; strict-JSON system prompt demanding
  exactly three replies; `_extract_json_object` fence/prose tolerance;
  malformed completions → `LLMResponseError(provider="suggestions",
  model=served)`; payload text never logged — INFO logs model/count/
  duration, WARNING logs normalized error only).
  - Inputs validated before ANY provider call (ValueError, zero requests):
    level ∈ Level.values, topic is GeneratedTopic, non-blank string
    selected_message, history pairs with roles in HISTORY_ROLES (reused
    from conversations.context) and non-blank content. Empty history is
    legal (selected message may open the conversation).
  - User prompt composition: suggestion instruction + level line
    (AUTO → "keep broadly accessible"; concrete CEFR echoed verbatim) +
    topic title/scenario + "Learner:/Tutor:" transcript of the supplied
    window + explicit long-pressed-message marker ("write exactly three
    replies that the learner could send next" — suggestions are USER-side
    candidate messages per ROADMAP §8 composer-fill semantics).
  - Output validation: `replies` list of EXACTLY 3 entries, each a
    non-empty string stripped on ingest; near-duplicates rejected at
    parse time case-insensitively (ROADMAP "meaningfully different");
    wrong-count/blanks/non-strings all LLMResponseError. Extra JSON keys
    ignored. Purity: nothing persisted, no DB access.
- `backend/tests/test_suggestion_service.py` (28 tests + subtests, all
  SimpleTestCase/mock-provider): frozen/comparing value object + count &
  blank invariants; input-validation matrix asserting ZERO provider calls
  (bad level/topic/selected/history incl. system role & malformed pairs);
  happy paths (verbatim stripped replies, [system,user] request shape,
  prompt composition pins — topic fields, concrete-level echo vs AUTO,
  Learner/Tutor transcript, selected-message marking, distinct prompts
  per distinct histories, fenced + prose-wrapped + extra-keys tolerance);
  invalid-output matrix (23 shapes: prose/list/scalars/truncated/missing
  key/wrong counts/blanks/nulls/numeric/exact dups/case-only dups/garbage
  → retryable=False provider="suggestions", served model attached);
  provider-failure passthrough (availability identical instance +
  retryable, auth error, non-LLM unmasked); logging hygiene (success log
  names model but no reply text; failure warning carries no payload).
- Gates: uv run ruff check clean; ruff format --check clean; full pytest
  DB_ENGINE=sqlite3 → 721 passed / 3 skipped / 250 subtests (bare `uv run
  pytest` errors are the PRE-EXISTING local Postgres auth issue — README's
  documented sqlite3 fallback used).
- Acceptance: exactly three suggestions returned ✓ (count pinned at parse
  + value-object layers); suggestions relevant ✓ (selected message +
  context-up-to-it + topic + profile all compose the prompt, test-pinned);
  LLM output validated ✓ (exhaustive invalid-output matrix); tests mock
  the LLM ✓ (FakeProvider seam, zero network).

#### Sub-step record (all complete)
1. [x] STATE.md breakdown written
2. [x] backend/conversations/suggestions.py — SuggestionService +
       Suggestions value object
3. [x] backend/tests/test_suggestion_service.py (28 tests)
4. [x] Gates green (ruff check/format; sqlite3 pytest 721 passed)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-058

## Archived Tasks

### TASK-057 — Implement session deletion UI (COMPLETED 2026-08-26)
- `HistoryScreen.tsx` inline deletion (Phase 8 scope; reused the existing
  TASK-045 `deleteSession` binding — no new API surface):
  - Per-row Delete entry control (`history-delete-{id}`, role button, label
    "Delete conversation {title}") beside Rename in a rowActions flex row;
    pressing clears any banner, CLOSES any open rename editor, and swaps
    THAT row to an inline confirm variant (`history-confirm-{id}`): warning
    text ("Delete “{title}”? This cannot be undone.") + destructive Confirm
    (`history-delete-confirm`, danger background) + Cancel
    (`history-delete-cancel`), all role buttons with labels and
    accessibilityState.disabled.
  - handleDeleteConfirm: guarded on deletingId/deleting → token via
    latest-ref seam (sign-out → friendly error) → deleteSession(token, id)
    → local filter removal. ZERO refetch: row disappears immediately
    (pinned by listSessions call-count test); deleting the last session
    flips the screen back to history-empty.
  - Failure: banner via shared form-error + toErrorMessage mapping; confirm
    STAYS OPEN for another attempt (the failed conversation keeps rendering
    as its confirm variant). Retry success clears the banner.
  - Guards: deleting disables Confirm AND Cancel (double-fire + cancel-race,
    mirroring rename); Cancel discards with zero API calls; reload effect
    resets delete state; startRename/startDelete are mutually exclusive;
    extraData gained [deletingId, deleting] so FlatList rows re-render into/
    out of the confirm variant.
- __tests__/HistoryScreen.test.tsx (+5 → new describe block, suite now 19):
  happy path (confirm shown → DELETE asserted with exact args 'token-a'/id →
  row gone immediately, sibling survives, no refetch); cancel discards
  (row + title restored, no deleteSession call); failure keeps confirm +
  banner then second Confirm succeeds and banner clears (failed conversation
  stays listed as its confirm variant until deletion succeeds);
  deferred-promise double-fire guard (Deleting… + both controls disabled
  mid-flight, second press fires nothing, resolve removes the card);
  last-session deletion returns to history-empty.
- Test gotchas hit:
  - The confirmed row renders AS `history-confirm-{id}` — asserting
    `history-item-{id}` still present after a FAILED delete is wrong (the
    item variant is gone while the session is not). First draft aborted on
    this and its mid-test abort POISONED later tests in the file (same
    un-awaited-async-corruption family as prior RNTL gotchas).
  - Post-resolution waits must target the CONFIRM CARD disappearing:
    waiting for `history-item-{id}` to vanish is vacuous — it left when the
    confirm step OPENED, so waitFor passed before the request completed and
    the follow-up assertion raced mid-flight state.
- Acceptance: confirmation is shown ✓ (inline confirm step pinned by
  tests); session disappears after successful deletion ✓ (local filter
  removal, zero-refetch pinned); errors are handled ✓ (banner + editable
  retry + cleanup).
- Gates: pnpm typecheck clean; eslint clean; jest 17 suites 189/189 passed.

#### Sub-step record (all complete)
1. [x] HistoryScreen.tsx — per-row Delete entry, inline confirm step,
       guarded handleDeleteConfirm through deleteSession, immediate local
       removal, error banner reuse, rename/delete mutual exclusion
2. [x] __tests__/HistoryScreen.test.tsx — delete tests (+5)
3. [x] Gates green (pnpm typecheck, pnpm lint, jest 189/189 across 17 suites)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-057

## Archived Tasks

### TASK-056 — Implement session rename UI (COMPLETED 2026-08-26)
- `HistoryScreen.tsx` inline rename (Phase 8 scope; reused the existing
  TASK-045 `renameSession` PATCH binding — no new API surface):
  - Per-row Rename entry control (`history-rename-{id}`, role button, label
    "Rename conversation {title}") nested in the row; pressing clears any
    banner and swaps THAT row to an editor variant
    (`history-editor-{id}`): TextInput (`history-rename-input`, prefilled,
    label "Conversation name") + Save (`history-rename-save`) / Cancel
    (`history-rename-cancel`), both role buttons with labels and
    accessibilityState.disabled.
  - handleRenameSave: guarded on renamingId/savingRename/blank-trim → token
    via latest-ref seam (sign-out → friendly error) → renameSession(token,
    id, trimmed) → authoritative Session response swapped into local state
    via map ({...session, ...updated}) → editor closes. ZERO refetch: UI
    updates immediately (pinned by listSessions call-count test).
  - Failure: banner via shared form-error + toErrorMessage mapping; editor
    STAYS OPEN with draft intact for another attempt. Stale-banner bug found
    by the first test run: a successful retry left the previous failure
    message visible — fixed by clearing error at attempt start (ChatScreen
    "banner cleared on next send" convention).
  - Guards: saving disables Save AND Cancel (double-fire + cancel-race);
    blank/whitespace draft disables Save (accessibilityState); Cancel
    discards with zero API calls; reload effect resets all rename state;
    FlatList gained extraData=[renamingId, draftTitle, savingRename] —
    without it rows never re-render into/out of the editor (classic FlatList
    memoization trap).
- __tests__/HistoryScreen.test.tsx (+5 → new describe block, suite now 14):
  happy path (prefilled input → PATCH args verbatim 'token-a'/id/'Trips in
  Europe' → row shows response title immediately, editor gone, no refetch);
  cancel discards (original title, no renameSession call); failure keeps
  editor + banner then second Save succeeds and banner clears; blank-draft
  disabled matrix (non-blank enabled ⇄ whitespace disabled ⇄ typed enabled,
  no call fired while disabled); deferred-promise double-fire guard (Save
  shows Saving… + disabled mid-flight, Cancel disabled too, second press
  fires nothing, resolve closes editor and swaps title).
- Test gotchas hit:
  - The retry-success assertion caught the stale-banner component bug before
    any harness issue — write the post-success queryByTestId('form-error')
    even when you think nothing sets error on that path.

- Acceptance: rename is persisted ✓ (PATCH asserted with exact args); UI
  updates immediately after success ✓ (authoritative swap, zero-refetch
  pinned); failure is handled ✓ (banner + editable retry + cleanup).
- Gates: pnpm typecheck clean; eslint clean; jest 17 suites 184/184 passed.

#### Sub-step record (all complete)
1. [x] HistoryScreen.tsx — per-row rename entry, inline editor, guarded
       handleRenameSave through renameSession, immediate setSessions update,
       error banner reuse, reload-effect resets rename state
2. [x] __tests__/HistoryScreen.test.tsx — rename tests (+5)
3. [x] Gates green (pnpm typecheck, pnpm lint, jest 184/184 across 17 suites)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-056

## Archived Tasks

### TASK-055 — Create history screen (COMPLETED 2026-08-26)
- `src/screens/HistoryScreen.tsx` rewritten from the TASK-043 placeholder to
  the real session list:
  - Load effect keyed on reloadKey only; token read through a
    getAccessToken LATEST-REF seam (AuthContext's value object is recreated
    per auth-state change — same TASK-048 infinite-loop avoidance as
    ChatScreen). First page via listSessions(token, 1); backend already
    orders most-recently-updated first, so delivery order IS display order.
  - States: history-loading spinner; form-error (role=alert) + history-retry
    "Try again" button on first-page failure (toErrorMessage mapping, so
    ApiError(0)/5xx → friendly unreachable copy); history-empty when count 0;
    FlatList (history-list) of Pressable rows history-item-{id} with title +
    one-line topic snippet, accessibilityRole button + label.
  - Pagination: hasMore = page.next !== null; loadedPages counter;
    history-load-more footer requests loadedPages + 1 and APPENDS results.
    Guarded against concurrent runs (loading/loadingMore/hasMore check),
    disabled (+ accessibilityState.disabled) while loading more with label
    swap Load more ⇄ Loading…. Page failures keep every rendered row and
    surface the banner above the list; control re-enables for another try.
  - Row tap → navigation.navigate('Chat', {sessionId}) (pushes, so Android-
    back returns to History). Pinned placeholder testIDs preserved:
    history-screen root + history-back Close control (navigation.test).
- __tests__/HistoryScreen.test.tsx (9): deferred-first-page loading state
  then ordered render [302,301,300]; empty state; reject-then-resolve retry
  round-trip (listSessions twice, banner clears); no-token → sign-in-again
  banner with zero API calls; tap opens chat-screen and loads that session
  (listMessages token+id); page append order [12,11,10] + control hidden
  when next null; double-fire guard (deferred page 2, press ×2, call count
  stays 2, disabled mid-flight, re-enabled after settle); load-more failure
  keeps rows + re-enables; back pops to underlying chat-no-session.
- Test gotchas hit:
  - Final assertion of the double-fire test initially expected the control
    still enabled after resolving page 2 with next:null — but hiding the
    exhausted control is CORRECT behavior; fixed the fixture (page 2 now
    carries a ?page=3 next) so re-enablement is actually observable.
- navigation.test/App.test unaffected: they mount the real HistoryScreen
  without mocking sessions; the resulting unmocked-fetch failure lands in
  the error state inside history-screen while the pinned testIDs stay
  mounted (same pattern ChatScreen already exercised there).
- Acceptance: sessions paginated (page-1 load + Load-more append) ✓; most
  recent first (delivery order preserved, pinned by ordered-render test)
  ✓; tapping opens chat ✓; loading/empty/error states exist (incl. retry
  and pagination failure paths) ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 17 suites 179/179 passed.

#### Sub-step record (all complete)
1. [x] HistoryScreen.tsx rewrite — load/states/pagination/tap-through UI
2. [x] __tests__/HistoryScreen.test.tsx written (9 tests)
3. [x] navigation.test + App.test verified green against the real screen
4. [x] Gates green (pnpm typecheck, pnpm lint, jest 179/179 across 17 suites)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-055

## Archived Tasks

### TASK-054 — Implement failed-response retry UI (COMPLETED 2026-08-26)
- `src/api/chatStream.ts`: XHR/SSE consumption loop extracted verbatim into
  private `consumeSseStream({url, body|null, token, onEvent, onError})`;
  `streamChatTurn` unchanged behaviorally. New `streamRetryTurn(token,
  sessionId, messageId, onEvent, onError)` POSTs to
  `/api/v1/sessions/{id}/messages/{message_pk}/retry/` with NO body and no
  Content-Type header (TASK-042 contract); same frame protocol, same abort
  semantics.
- `ChatScreen.tsx`:
  - Shared `handleTurnEvent` pipeline (start ignored / delta buffered /
    completed → completeTurn / error → failTurn) now feeds BOTH send and
    retry; `startRetry(sid, messageId)` mirrors startTurn's token+stale-
    session guards.
  - Failed assistant rows render a muted "The response failed to generate."
    note plus an inline Retry pressable (testID chat-retry-{id},
    accessibilityRole button, label Retry failed response,
    accessibilityState.disabled while any stream runs).
  - `handleRetry(message)`: guarded by sessionId + streaming; clears the
    banner; re-arms that row LOCALLY exactly like RetryService.prepare_retry
    does server-side ({status:'pending', content:''}) so it renders as the
    spinner bubble; points streamingAssistantIdRef at the REAL row id —
    DeltaBuffer flushes land in-place via the existing id map.
  - Reused unchanged: completeTurn flips the same row to complete with
    authoritative text then silently reloads canonical rows;
    failTurn's optimistic-row drop is a no-op for persisted ids and its
    resync restores the still-failed row after error frames/transport
    failures (control returns for another attempt); endTurn cleanup aborts
    retry streams on unmount/session change too; `streaming` blocks Send
    AND other retries concurrently.
- __tests__/chatStream.test.ts (+4 → 21): retry request shape (URL, Bearer,
  Accept, body undefined, no Content-Type); incremental start/deltas/
  completed over the retry endpoint; 409 {"detail"} normalized to
  ApiError(409) with verbatim detail; mid-attempt network drop →
  ApiError(0).
- __tests__/ChatScreen.test.tsx (+6 → 27): control only on failed assistant
  rows (none for user/complete rows); press invokes streamRetryTurn with
  {token-a, sessionId, messageId} and re-arms the row (spinner, control
  hidden, send blocked even with a pending draft); deltas grow the SAME
  persisted row in place and completion removes the failure state + silent
  canonical swap + composer re-enabled; error frame keeps failure state
  usable (banner, resynced failed row, second attempt fires again);
  transport failure shows friendly unreachable banner; concurrency guard —
  retried row's control vanishes, other failed rows' controls visible but
  inert (press fires nothing), everything re-enables after completion.
- Test gotchas hit:
  - The retried row's own control disappears the moment handleRetry flips
    it to pending — a "press it twice" assertion must target ANOTHER
    failed row's control instead (first draft failed on missing
    chat-retry-701).
  - canSend requires a non-blank draft: asserting send disabled/enabled
    around a retry is only meaningful after typing into the composer
    (empty-draft assertions are vacuous/incorrect).
- Acceptance: retry invokes backend retry (streamRetryTurn → retry endpoint)
  ✓; user sees useful error state (inline note + banner + resynced failed
  row) ✓; successful responses remove failure state (completed frame flips
  row, control gone) ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 16 suites 170/170 passed.

#### Sub-step record (all complete)
1. [x] chatStream.ts — shared consume core + streamRetryTurn binding
2. [x] ChatScreen.tsx — failed-row Retry control + handleRetry/startRetry
       wiring through the existing turn pipeline
3. [x] __tests__/chatStream.test.ts — retry binding tests (+4)
4. [x] __tests__/ChatScreen.test.tsx — retry UI tests (+6)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 170/170 across 16 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-054

## Archived Tasks

### TASK-053 — Implement sample conversation UI (COMPLETED 2026-08-26)
- `src/api/sessions.ts`: new `SampleTurn {role: MessageRole; content: string}`
  + `SampleConversation {turns}` mirroring the backend asdict() envelope;
  `CreatedSession extends Session {sample_conversation?}` — the sample exists
  ONLY in the POST /api/v1/sessions/ response (no GET endpoint), so
  `createSession` now returns `Promise<CreatedSession>`.
- `src/navigation/types.ts`: Chat route params gain optional `sampleTurns:
  SampleTurn[]`; sessions opened any other way have none → entry hidden.
- `src/tts/textToSpeech.ts` (new): minimal `TextToSpeechEngine` seam
  ({speak(text): Promise<void>, stop()}) + `stubSpeechEngine` no-op. Real
  Android-native engine is Phase 12 (TASK-076/077) and swaps in behind the
  seam without touching this UI; playback-state tracking lives with the
  caller by contract.
- `src/screens/SampleConversationModal.tsx` (new, first Modal in the app):
  - Full-screen RN `<Modal animationType="slide">`, gated to render nothing
    when closed; container carries accessibilityViewIsModal.
  - Header "Example conversation" + Close (sample-close, role=button,
    label Close example conversation); note line states the example "never
    becomes part of your chat history" (testID sample-note).
  - Turns rendered chat-style (assistant surface-left / user primary-right)
    with uppercase AI/You captions, per-turn testIDs sample-turn-{n}.
  - Per-line TTS control sample-tts-{n}: Play ⇄ Stop toggle driven by
    speakingIndex state; accessibilityRole button, dynamic label Play/Stop
    example line n+1, accessibilityState.busy. Starting another line stops
    the active one first (guarded so a first press issues NO stop call);
    explicit stop ignores late natural completion via functional setState.
    Closing (visible→false effect) AND unmount both halt the engine.
  - Engine injectable for tests (`speech` prop, defaults to the stub).
- `ChatScreen.tsx`: `hasSample = route.params?.sampleTurns non-empty`;
  accent strip under the topic bar (chat-show-example, role=button, label
  "Show me an example") opens `exampleVisible`; modal mounted at the end of
  the in-conversation branch with onClose resetting it. Load effect closes a
  stale overlay on session/reload change like topicExpanded.
- `NewConversationScreen.tsx`: handleCreate passes
  `sampleTurns: created.sample_conversation?.turns` into replace('Chat', …)
  since the sample cannot be refetched later.
- Tests (+15 → 16 suites 160/160):
  - __tests__/SampleConversationModal.test.tsx (9): ordered turns + role
    captions + separation note; closed renders nothing; Close-button and
    Android-back (props.onRequestClose invoked) dismissal; play speaks the
    exact line through the injected engine and flips busy/label until the
    deferred promise resolves; repress stops immediately and a late release
    does not resurrect state; switching lines stops the previous one (stop
    called exactly once, correct two speak texts); closing mid-speech halts
    engine and unmounts content; unmount cleanup silences too.
  - __tests__/ChatScreen.test.tsx (+3): entry hidden without params / with
    empty turns; open → overlay shows both lines while messageTestIds stay
    untouched and example text absent from tree before opening → Close
    removes it fully.
  - __tests__/NewConversationScreen.test.tsx (+2): creation response WITH
    sample_conversation → chat shows chat-show-example and the overlay
    presents those turns; WITHOUT it → chat opens, entry absent.
  - __tests__/sessionsApi.test.ts (+1): sample_conversation envelope
    survives the typed createSession binding.
- Test gotchas hit:
  - First draft asserted stopMock not called after a FIRST play press, but
    the component stopped the engine unconditionally before speaking —
    fixed the component instead (stop only when something is active): more
    precise seam behavior, tests then passed unchanged.
  - A weak "close halts engine" test (parent never flipped visible) was
    replaced with an act-wrapped rerender visible=false — the real path.
- Acceptance: example separate from actual chat history (modal-only, pinned)
  ✓; supports TTS controls (per-line Play/Stop through the speech seam) ✓;
  modal accessible and dismissible (roles/labels/busy states, Close +
  Android-back) ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 16 suites 160/160 passed.

#### Sub-step record (all complete)
1. [x] sessions.ts — SampleTurn/SampleConversation/CreatedSession types;
       createSession returns CreatedSession
2. [x] navigation/types.ts — Chat route params gain optional sampleTurns
3. [x] src/tts/textToSpeech.ts — TextToSpeechEngine seam + stub engine
       (real engine is TASK-076/077)
4. [x] SampleConversationModal.tsx — accessible/dismissible RN Modal,
       per-turn Play/Stop via injected engine, role-labeled bubbles
5. [x] ChatScreen.tsx — chat-show-example entry (only when turns present) +
       modal mount; NewConversationScreen carries sampleTurns into replace()
6. [x] Tests: SampleConversationModal.test.tsx (9), ChatScreen.test.tsx (+3),
       NewConversationScreen.test.tsx (+2), sessionsApi.test.ts (+1)
7. [x] Gates green (pnpm typecheck, pnpm lint, jest 160/160 across 16 suites)
8. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-053

## Archived Tasks

### TASK-052 — Implement topic header (COMPLETED 2026-08-26)
- `ChatScreen.tsx`:
  - Load effect now fetches the session detail through the existing
    `getSession` binding alongside `listMessages` via Promise.all — but
    NON-FATALLY: `.catch(() => null)` on the detail promise, so a failed
    metadata fetch only hides the topic bar while messages/composer keep the
    conversation fully usable (messages remain the primary load; a
    listMessages failure still shows the error+retry state).
  - New state: `session: Session | null` + `topicExpanded` (default false).
    Both reset at effect start on session/reload change.
  - Compact collapsible topic bar rendered ONLY in the in-conversation
    branch between the app header and the list area: collapsed shows one
    line of session.title (`numberOfLines={1}`); pressing toggles expansion,
    revealing the full session.topic description. testIDs chat-topic
    (root Pressable), chat-topic-title, chat-topic-text, chat-topic-toggle
    (▾/▴ glyph); accessibilityRole button + accessibilityState.expanded +
    dynamic label Show/Hide topic details. Surface background with border —
    visually subordinate to the chat, satisfying "visible without
    dominating".
- __tests__/ChatScreen.test.tsx extended (+4): compact collapsed render once
  detail loads (getSession called with token+id, description absent,
  expanded=false); toggle round-trip (description appears verbatim +
  expanded=true, collapses back leaving title); no-session state renders no
  bar and never calls getSession; detail-fetch failure keeps composer +
  zero error banner with bar simply absent.
- Harness parity: ChatScreen.test beforeEach gained a getSession default;
  NewConversationScreen.test beforeEach too (it mounts the real ChatScreen
  after replace('Chat', {sessionId}) — without it the auto-mock returns
  undefined and Promise.all would reject into the error state).
- Acceptance: topic visible without dominating (one-line title strip) ✓;
  collapsible/compacted (toggle to full description) ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 15 suites 145/145 passed.

#### Sub-step record (all complete)
1. [x] ChatScreen.tsx — getSession fetch (Promise.all, detail failure → null)
       + collapsible topic bar UI/styles
2. [x] __tests__/ChatScreen.test.tsx — makeSession helper, beforeEach
       getSession default, +4 topic tests
3. [x] __tests__/NewConversationScreen.test.tsx — getSession default mock
4. [x] Gates green (pnpm typecheck, pnpm lint, jest 145/145 across 15 suites)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-052

## Archived Tasks

### TASK-051 — Implement new conversation UI (COMPLETED 2026-08-26)
- `src/navigation/types.ts` + `MainNavigator.tsx`: `NewConversation: undefined`
  route registered between Chat and History; `NewConversationScreenProps`
  alias added.
- `src/screens/NewConversationScreen.tsx` (new):
  - ROADMAP §6 shape: "What would you like to talk about?" hint input
    (new-conversation-hint) + primary Start (new-conversation-start) +
    secondary "Let AI choose a topic" (new-conversation-auto) + Cancel/back
    link (new-conversation-back → goBack).
  - Both actions funnel through one handleCreate(rawHint): guard on creating
    → trim hint → getAccessToken() at press time (sign-out → friendly error)
    → createSession(token, trimmedHint) → navigation.REPLACE('Chat',
    {sessionId}) so Android-back never returns to a submitted form. Blank
    Start behaves exactly like the auto action, so empty input works on BOTH
    controls.
  - Creating state: spinner row (new-conversation-loading), both buttons
    disabled (+ accessibilityState), input non-editable, double-press
    guarded. Failure: role=alert form-error banner with toErrorMessage,
    screen stays and buttons re-enable for retry.
  - Theme tokens via createStyles(colors); KeyboardAvoidingView shell like
    Login/Chat.
- `ChatScreen.tsx` entry points: header "New" link (chat-open-new) beside
  History/Settings; no-session empty state gained a "Start a new conversation"
  CTA (chat-start-new) so the cold-start path is reachable end-to-end.
- __tests__/NewConversationScreen.test.tsx (7): render matrix; typed hint →
  createSession('token-a','Traveling') + stack swaps to real Chat loading
  session 42 (listMessages asserted with the created id); untouched Start →
  createSession(token,'') → chat for id 7; auto ignores typed hint (''); ApiError(400)
  → verbatim message in form-error, still on form, both buttons re-enabled;
  deferred creation → loading row + disabled buttons + second press does not
  double-fire (count stays 1) → resolve swaps to chat for id 42; cancel pops
  back to the underlying no-session chat (initialState stack).
- __tests__/ChatScreen.test.tsx extended (+2): chat-open-new pushes the flow;
  chat-no-session CTA pushes it too (stub NewConversation route added to the
  renderChat harness).
- Test gotchas hit (IMPORTANT for future suites):
  - **An onPress that RETURNS a pending promise hangs awaited
    fireEvent.press forever** (RNTL captures the handler's return into the
    act scope; React 19's recursive async-act flush never resolves on a
    foreign pending promise). Fix/convention: brace-wrap async handlers
    (`onPress={() => { handleCreate(x); }}`) so onPress returns void — same
    style LoginScreen already used. Symptom is a bare test timeout with no
    assertion failure; minimal-repro bisect isolated it in minutes.
  - Bare non-awaited render() leaves `screen.*` unbound ("render function has
    not been called") — await render even in throwaway harnesses.
  - After successful replace('Chat'), the form is UNMOUNTED — post-settle
    assertions must target the chat tree, not the gone form (queryByTestId
    null-checks are safe; getByTestId re-fetches are not).
- Acceptance: empty input works (both Start and Let-AI-choose send '') ✓;
  topic hint works (verbatim to POST /api/v1/sessions/) ✓; session creation
  navigates to chat (replace carries {sessionId}, Chat loads its messages) ✓;
  loading/error states exist ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 15 suites 141/141 passed.

#### Sub-step record (all complete)
1. [x] types.ts NewConversation route + MainNavigator registration
2. [x] NewConversationScreen.tsx — hint input, Start/Let-AI-choose, creating
       + error states, replace-to-chat
3. [x] ChatScreen entry points (chat-open-new + chat-start-new)
4. [x] NewConversationScreen.test.tsx (7 tests) + ChatScreen entry-point
       tests (+2)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 141/141 across 15 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-051

## Archived Tasks

### TASK-050 — Implement smooth streaming UX (COMPLETED 2026-08-26)
- `src/screens/streamingUx.ts` (new, pure units so transitions are testable
  without rendering):
  - `DeltaBuffer(onFlush, intervalMs)` — coalesces SSE delta bursts into at
    most ONE state commit per flush tick (50 ms): first push schedules the
    single timer, later pushes in the window join the pending chunk
    (jest.getTimerCount pinned to 1); flushNow() applies immediately and
    cancels the tick without double delivery; discard() drops text and kills
    the tick; empty pushes never schedule. Render frequency is now bounded
    by the tick regardless of token arrival frequency.
  - `isNearBottom({offsetY, contentHeight, viewportHeight}, thresholdPx)` —
    stick decision: content shorter than viewport is always "at bottom";
    threshold comparison inclusive at exactly the boundary.
  - Constants STREAM_FLUSH_INTERVAL_MS=50, STICK_TO_BOTTOM_THRESHOLD_PX=120.
- `ChatScreen.tsx` wiring:
  - appendDelta no longer setMessages per event — it guards on the live
    assistant id then buffer.push(); the flush closure reads the target id
    from the ref, so a tick landing after cleanup finds nothing to update.
  - completeTurn discards the buffer BEFORE applying the authoritative
    completed-frame text (buffered tail deltas are superseded, never
    duplicated/appended); failTurn and endTurn discard too — unflushed
    deltas can never land after their row is gone.
  - Scroll follow: listRef + onScroll (scrollEventThrottle 16) feeds
    isNearBottom → nearBottomRef (read inside callbacks, no re-render) +
    detachedFromBottom state (flips only at the boundary); 
    onContentSizeChange calls scrollToEnd({animated:false}) ONLY while
    stuck, so an intentional scroll up stops the follow instead of being
    yanked back; detached state renders a jump-to-latest pill
    (chat-jump-latest, accessibilityRole button) whose press re-sticks and
    scrolls animated. Load effect resets stick/detach on session change.
- __tests__/streamingUx.test.ts (13): isNearBottom matrix (short-content,
  exact-bottom, within-threshold, inclusive-boundary, just-beyond, far-up);
  DeltaBuffer burst→single concatenated chunk per tick, single-timer proof,
  flushNow immediate + cancelled tick, empty flushNow no-op, discard
  suppresses both paths, empty-push ignored, consecutive cycles ordered.
- __tests__/ChatScreen.test.tsx extended (+3, existing delta assertions
  moved onto waitFor flush ticks since commits are now deferred):
  - burst of 7 deltas inside one act renders nothing yet → one tick shows
    the full concatenated text exactly once → completed frame supersedes a
    post-tick buffered delta with zero duplication and swaps persisted ids.
  - scroll far above bottom → chat-jump-latest appears; streamed growth
    while detached still lands in the bubble WITHOUT forcing scroll;
    scrolling back into the threshold hides the pill; detach again → press
    pill → hidden again.
  - error frame right after an unflushed delta → banner + ghost text never
    renders (checked both before and after server-truth resync).
- Test gotchas hit:
  - FlatList test env mounts only ~10 items (initialNumToRender): a fixture
    of 10 loaded rows pushed optimistic rows to index 10/11 which exist in
    state but never mount — looked like "send appended nothing" until
    DIAG proved draft cleared + turn started. Fixture reduced to 6 rows.
  - new Promise(resolve => setTimeout(...)) needs BOTH the <void> type arg
    AND an arrow-wrapped resolve (RN @types reject passing resolve directly).
  - Deferred flush means getByText immediately after a delta act is racy by
    design — assertions must wait for the tick (flushStreamTick helper or
    waitFor), never assert synchronously.
- Acceptance: streaming feels continuous (commits coalesced at 50 ms, one
  map() over rows per tick) ✓; long messages do not visibly stutter (render
  frequency decoupled from delta frequency, unit-pinned) ✓; auto-scroll near
  bottom only + never force-scroll after intentional scroll-up (isNearBottom
  gate on onContentSizeChange + detach pill) ✓; tests cover core state
  transitions ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 14 suites 132/132 passed.

#### Sub-step record (all complete)
1. [x] src/screens/streamingUx.ts — DeltaBuffer + isNearBottom + constants
2. [x] ChatScreen.tsx — buffered appendDelta, guarded auto-scroll, jump
       pill, drain-on-terminal semantics
3. [x] __tests__/streamingUx.test.ts written (13 tests)
4. [x] __tests__/ChatScreen.test.tsx extended (+3 streaming UX tests)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 132/132 across 14 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-050

## Archived Tasks

### TASK-049 — Implement SSE mobile client (COMPLETED 2026-08-26)
- `src/api/chatStream.ts` — typed SSE consumption speaking the backend
  llm/sse.py protocol verbatim (start {model} / delta {text} / completed
  {text,model,delta_count} / error {error,retryable} frames, each
  `event:` line + single-line JSON `data:` + blank separator).
  - Pure parsing exported for exhaustive unit testing: parseSseFrame
    (event/data field extraction, multi-data-line join, comment-only →
    null, missing event → 'message') and decodeChatStreamFrame (strict
    typed union mapping; junk JSON/malformed fields/unknown event names →
    null; delta_count fallback 0; retryable only when === true).
  - Transport: XMLHttpRequest, NOT fetch — RN's fetch buffers whole bodies,
    XHR progress events expose accumulating responseText as bytes arrive.
    POST {text} JSON to /api/v1/sessions/{id}/messages/stream/ with Accept:
    text/event-stream + Bearer header.
  - Incremental framing: cursor over responseText + pending tail buffer;
    frames split on \n\n survive arbitrary chunk boundaries; CRLF
    tolerated. After a terminal frame further frames are ignored.
  - Terminal contract: exactly one outcome per stream — completed/error
    application event, or onError transport failure (HTTP non-2xx →
    normalizeApiError from client.ts on the DRF JSON body; network drop →
    ApiError(0); clean close without terminal frame → explicit early-close
    error). abort() suppresses every callback permanently (unmount-safe).
- `client.ts`: module-local normalizeError exported as normalizeApiError
  (reused by chatStream for non-SSE rejections; no duplication).
- `ChatScreen.tsx` send path replaces the TASK-048 optimistic seam:
  - Send appends optimistic user echo + pending assistant placeholder
    (stable synthetic ids echoId=-Date.now(), replyId=echoId-1; sequences
    continue chronologically) then starts the turn with the latest-ref
    token. Placeholder renders an ActivityIndicator until first delta;
    deltas append into the growing bubble via targeted id map.
  - completed finalizes content authoritatively then silently reloads the
    first page (refreshMessages: never flips the loading spinner, guarded
    against stale-session races via sessionIdRef) swapping synthetic rows
    for persisted ones.
  - Error frames AND transport failures share failTurn: drop optimistic
    rows, show chat-stream-error banner (role=alert above composer), best-
    effort server resync (committed user row / failed assistant row
    reappears; retry control is TASK-054). Banner cleared on next send and
    session/reload changes.
  - Streaming disables send (double-send guard in handleSend + disabled
    state); load-effect cleanup aborts the in-flight stream on unmount and
    session switches so no turn outlives its UI.
- __tests__/chatStream.test.ts (17): FakeXHR double with scripted
  emit/respond/networkFail driving accumulating responseText; request shape
  (POST URL/body/Accept/Bearer); incremental delivery order; multi-frame
  chunks; split-boundary reassembly incl. straddled completed frame; error
  frame typing; 400 DRF field errors + 401 detail → normalized ApiError;
  network failure ApiError(0); clean-close-without-terminal; abort
  suppression + idempotent second abort; stray post-terminal frames
  ignored.
- __tests__/ChatScreen.test.tsx extended (+6): optimistic pair + exact
  stream call args (token/sessionId/text); incremental delta growth then
  completion swap to persisted ids (listMessages twice); empty pending
  bubble before first delta (no text children); error frame banner +
  server-truth resync (failed row visible, send re-enabled); transport
  failure friendly message; unmount aborts stream exactly once; send
  blocked during streaming (accessibilityState + call count stays 1).
- Test gotchas hit:
  - First draft of streamChatTurn forgot xhr.send() entirely — the
    request-shape test caught it immediately (body undefined).
  - A "clean" 200 close that delivered only non-terminal frames MUST
    surface an error (protocol violation): initial test expected [] and
    was wrong, not the implementation.
  - jest.stubGlobal lacks type declarations in this tsconfig — stubbed via
    globalThis.XMLHttpRequest assignment + restore instead.
  - no-void lint rule rejects `void promise()` fire-and-forget — plain
    call expressions pass (calls are not unused expressions).
- Acceptance: chunks append incrementally ✓; assistant message appears
  while streaming (placeholder + deltas) ✓; completion handled
  (finalize + canonical swap) ✓; error events displayed (SSE frames and
  transport failures) ✓; connection cleanup on leaving screen (abort +
  callback suppression) ✓.
- Gates: pnpm typecheck clean; eslint clean; jest 13 suites 116/116 passed.

#### Sub-step record (all complete)
1. [x] src/api/chatStream.ts — parser + decoder + XHR stream client
2. [x] ChatScreen.tsx — streaming send path, banner, abort cleanup
3. [x] __tests__/chatStream.test.ts written (17 tests)
4. [x] __tests__/ChatScreen.test.tsx extended (+6 streaming tests)
5. [x] Gates green (pnpm typecheck, pnpm lint, jest 116/116 across 13 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-049

## Archived Tasks

### TASK-048 — Create chat screen (COMPLETED 2026-08-26)
- `src/navigation/types.ts`: MainStackParamList.Chat now
  `{sessionId?: number} | undefined` (TASK-051 navigates here after session
  creation); ChatScreenProps alias added.
- `src/screens/ChatScreen.tsx` rewritten from placeholder to the real
  conversation shell:
  - Header keeps the pinned testIDs chat-open-history/chat-open-settings
    (App.test + navigation.test depend on them) as accent links beside the
    title; chat-screen root testID preserved for theme probe.
  - Load effect keyed on (sessionId, reloadKey) via getAccessToken LATEST-REF
    seam — auth-state transitions never refetch behind the user's back;
    first page of listMessages sorted by sequence ascending (chronological
    guarantee independent of delivery order).
  - States: loading spinner (chat-loading), load-error (form-error +
    chat-retry re-run), no-session empty state (chat-no-session, composer
    withheld until a conversation exists), in-conversation empty state
    (chat-empty ListEmptyComponent).
  - Message list FlatList: user bubbles primary/right, assistant surface/
    left, per-message testID chat-message-{id}.
  - Composer (chat-composer): multiline TextInput + Send Pressable; send
    disabled while trimmed draft is blank (accessibilityState.disabled);
    successful send appends optimistic local echo (synthetic negative id,
    next sequence) chronologically and clears the draft. Deliberate seam:
    NO wire call — the only send endpoint streams, consuming it IS TASK-049;
    KeyboardAvoidingView shell (android undefined behavior, iOS padding)
    mirrors LoginScreen.
- __tests__/ChatScreen.test.tsx (8): deferred-promise loading state;
  empty-session state with composer present; chronological order regardless
  of delivery order (queryAllByTestId tree order); send appends after all
  loaded messages + clears composer; disabled matrix blank→whitespace→text;
  error+retry round-trip (reject-then-resolve, listMessages called exactly
  twice); no-param no-fetch empty state; shell structure (header/list/
  composer inside chat-screen root).
- Test gotchas hit:
  - RNTL v14 un-awaited fireEvent CORRUPTS THE REST OF THE FILE (same
    family as the act() note in TASK-044): every changeText/press must be
    awaited or subsequent renders never mount (findBy timeouts).
  - RN Pressable does NOT keep raw .props.disabled — read
    accessibilityState.disabled instead.
  - Host elements expose .type as string ('View'), composite components are
    unreachable via screen UNSAFE_* APIs in v14 (removed) — assert structure
    by containment, not component identity.
  - Unconditional setMessages([]) inside an effect whose deps include an
    UNSTABLE getAccessToken (theme.test's old inline-arrow mock) = infinite
    effect loop → worker OOM. Fixed two ways: idempotent resets (return prev
    array when already empty) + hoisted stable mockGetAccessToken in
    theme.test; latest-ref removes getAccessToken from load-effect deps.
- Acceptance: user can enter and send a message (append + clear pinned);
  messages render chronologically (sorted by sequence, appended last);
  UI works with keyboard (KeyboardAvoidingView shell, LoginScreen parity).
- Gates: pnpm typecheck clean; eslint clean; jest 12 suites 89/89 passed.

#### Sub-step record (all complete)
1. [x] navigation/types.ts — Chat params {sessionId?: number} +
       ChatScreenProps alias
2. [x] src/screens/ChatScreen.tsx rewrite — header, FlatList message list
       (sequence-sorted), composer + send, loading/error/empty states,
       KeyboardAvoidingView, optimistic send seam
3. [x] __tests__/ChatScreen.test.tsx written (8 tests); theme.test wording
       updated (placeholder → screen)
4. [x] Gates green (pnpm typecheck, pnpm lint, jest 89/89 across 12 suites)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-048

## Archived Tasks

### TASK-047 — Implement authentication state (COMPLETED 2026-08-26)
- Audited TASK-015/046 implementation per prior note: startup restore +
  refresh fallback + logout existed and were tested; the GAP was mid-session
  behavior — an expired access token during app usage failed hard with
  ApiError(401) and dead refresh credentials never forced a return to login.
  EXTENDED rather than duplicated.
- `src/auth/AuthContext.tsx`:
  - Replaced tryRefreshSession with single-flight `refreshAccess()` shared by
    startup restore AND every 401 arrival (refreshPromiseRef): concurrent
    callers await ONE network refresh; success persists {new access, same
    refresh} via saveTokens; rejection clears tokens + user + flips status to
    unauthenticated exactly once and resolves null. RootNavigator's existing
    whole-navigator swap lands the user back on Login.
  - New context method `authedRequest<T>(path, options)` (AuthorizedRequestOptions =
    Omit<RequestOptions,'token'>; RequestOptions now exported from client.ts):
    awaits restore settle → requires tokens else ApiError(401 'signed out')
    without network → first attempt with current access token → ApiError 401
    triggers refreshAccess + exactly ONE retry with the new token; refresh
    death rethrows the ORIGINAL 401; non-401 errors and still-failing retries
    propagate untouched (no loops). busy/error form state untouched.
  - Startup restore refactored onto refreshAccess (deduplicated refresh logic;
    getMe-after-refresh failure still ends locally unauthenticated).
  - LevelScreen/screens deliberately NOT retrofitted: chat/history screens do
    not exist yet; retrofitting consumers is Phase 7+ work.
- __tests__/AuthContext.test.tsx extended (+7 authorized-request tests; probe
  gained request-result text + single/double-fire pressables): Bearer attach
  without refresh; 401→one refresh→retry succeeds with new token + saveTokens
  persisted + stays authenticated; invalid refresh credentials → clearTokens +
  user none + status unauthenticated (= back at Login) + original fail:401 +
  exactly one fetch and one refresh; non-401 (500) passthrough with no
  refresh/clear; retry-still-failing stops at one retry (2 fetches, 1 refresh);
  concurrent double-request holds refresh open and proves single-flight
  (count stays 1 across macrotask drains) then both succeed after release
  (4 fetches total); signed-out rejection with zero fetches.
- Test gotchas hit:
  - toHaveTextContent is substring matching — assertion string must match the
    probe's actual template (single ok: prefix), not an idealized one.
  - @types/react-native setTimeout callback signature rejects passing `resolve`
    directly — wrap in arrow.
  - Single-flight determinism: gate refreshAccessToken with a manually released
    promise, assert call count stays 1 after setTimeout(0) drains, then release.
- Acceptance: startup restores authentication (pre-existing, retested);
  expired access tokens refresh transparently mid-session (authedRequest);
  invalid refresh credentials return the user to login (forced local logout →
  AuthNavigator swap).
- Gates: pnpm typecheck clean; eslint clean; jest 11 suites 81/81 passed.

#### Sub-step record (all complete)
1. [x] AuthContext.tsx — single-flight refreshAccess + authedRequest on context
2. [x] __tests__/AuthContext.test.tsx — authorized-request block (+7)
3. [x] Gates green (pnpm typecheck, pnpm lint, jest 81/81 across 11 suites)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-047

## Archived Tasks

### TASK-046 — Create secure token storage (COMPLETED 2026-08-26)
- Audited the existing TASK-015 implementation and EXTENDED rather than
  duplicated: src/auth/secureStorage.ts already persists {access,refresh}
  JSON via react-native-keychain (service com.elearningmobile.auth,
  validated load, corrupted/partial payloads → null); AuthContext already
  restores on mount (loadTokens → getMe → single refresh fallback →
  clearTokens when refresh dies) and logout always clears locally.
  grep verified ZERO AsyncStorage usage/dependency in mobile/.
- jest.setup.js keychain mock hardened: backing Map hoisted OUTSIDE the
  mock factory as module-scope `mockKeychainStore` (babel-jest whitelists
  `mock`-prefixed out-of-scope refs), so jest.resetModules() recreates JS
  modules while the "device" store survives — true process-restart
  semantics for tests.
- __tests__/secureStorage.test.ts extended (+4): fresh require of
  secureStorage after jest.resetModules() reloads persisted tokens
  (restart survival); cleared credentials stay cleared across restart;
  corrupted payloads stay rejected across restart; writes go ONLY through
  Keychain.setGenericPassword with the exact JSON envelope.
- New __tests__/tokenLifecycle.test.tsx (2 end-to-end lifecycle tests):
  AuthProvider runs against REAL secureStorage + persistent keychain mock
  (only ../src/api/auth mocked). Restarts simulated by remounting
  AuthProvider via key changes on ONE RNTL render instance (rerender) —
  avoids multi-render `screen` binding ambiguity. Launch 1 login → tokens
  written to keychain; launch 2 restores authenticated via stored access
  token with login called exactly once total; logout clears;
  post-logout restart stays unauthenticated with getMe/refresh never
  called (no credential material reaches any API).
- Test gotchas hit:
  - jest.resetModules() ALSO resets jest.mock factories — a store declared
    inside the factory would be recreated empty; hence the hoisted
    module-scope holder.
  - RNTL v14 render()/rerender are async and return Promises — unawaited
    handles break .unmount()/.rerender() and querying.
  - Sequential RNTL renders in one test made `screen` resolve across
    trees (stale status text / "unable to find"); single-render + keyed
    rerender eliminated it. Mock call history must be cleared before a
    relaunch so assertions judge only the new launch.
- Acceptance: tokens not in plain AsyncStorage (keychain-only writes,
  pinned by tests); tokens survive restart (module-lifetime + provider-
  remount proof); logout removes credentials (store emptied, restart
  logged out).
- Gates: pnpm typecheck clean; eslint clean; jest 11 suites 74/74 passed.

#### Sub-step record (all complete)
1. [x] secureStorage.test.ts extended (+4 restart-boundary tests);
       jest.setup.js keychain store hoisted for resetModules survival
2. [x] tokenLifecycle.test.tsx written (2 three-launch lifecycle tests)
3. [x] Gates green (pnpm typecheck, pnpm lint, jest 74/74 across 11 suites)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-046

## Archived Tasks

### TASK-045 — Create mobile API client (COMPLETED 2026-08-26)
- Audit found a working partial client: `src/api/client.ts` (apiRequest<T>
  transport: JSON headers, optional Bearer token, ApiError{status,message,
  fields} normalization of DRF detail/field errors, network failures →
  status 0, non-JSON bodies → null payload), `src/api/auth.ts` +
  `src/api/profile.ts` typed bindings, 5 tests. grep confirmed zero `any`
  in src/. Extended rather than duplicated.
- New `src/api/sessions.ts` — models mirroring backend serializers exactly
  (Session: id/title/topic/topic_hint/learning_level/created_at;
  ChatMessage: id/role/status/content/sequence/created_at with
  MessageRole/MessageStatus unions; Paginated<T> DRF envelope) + bindings
  for every REST resource that exists server-side: listSessions(page?),
  createSession(topicHint=''), getSession, renameSession, deleteSession
  (→ void), listMessages(page?). SSE stream/retry deliberately NOT bound —
  streaming consumption is TASK-049, retry UI TASK-054.
- apiClient.test.ts extended (+4): default GET without Authorization header
  when token absent; non-object success payload passthrough; junk-typed
  error field values ignored → consistent generic ApiError; empty JSON
  error object → generic message.
- New sessionsApi.test.ts (7): pagination envelope + ?page= query; empty-body
  POST creation; topic_hint body; GET/PATCH/DELETE paths+methods+bodies+
  Bearer headers; message listing shape incl. failed assistant rows.
- Acceptance: no `any` for API models (types only, `unknown` internally);
  errors consistently ApiError{status,message,fields}; 16 unit tests for the
  client layer.
- Gates: pnpm typecheck clean; eslint clean; jest 10 suites 68/68 passed.

#### Sub-step record (all complete)
1. [x] src/api/sessions.ts — Session/ChatMessage/Paginated<T> models + six
       REST bindings
2. [x] apiClient.test.ts extended (+4 transport edge cases)
3. [x] __tests__/sessionsApi.test.ts written (7 binding contract tests)
4. [x] Gates green (pnpm typecheck, pnpm lint, jest 68/68 across 10 suites)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-045

### TASK-044 — Implement theme system (COMPLETED 2026-08-26)
- React Context token system (`src/theme/`), deliberately NOT NativeWind:
  no new dependency (SPEC rule), screens already StyleSheet-based, and all
  three acceptance criteria are met by context + palette swap. Revisit
  NativeWind only if a later phase demands utility-class styling.
- `src/theme/colors.ts` — ThemeColors interface + light/dark neutral palettes
  (Tailwind-derived slate/gray scale + blue primary). Tokens: background,
  surface, border, borderStrong, textPrimary/textSecondary/textMuted,
  primary, onPrimary, accent (+accentSoft wash for selected rows), danger,
  errorText, success. Colors exist ONLY here (grep-verified).
- `src/theme/system.ts` — useSystemColorScheme() seam over RN's
  useColorScheme so tests can simulate OS preference changes (mirrors the
  backend lru_cache seam conventions).
- `src/theme/ThemeContext.tsx` — ThemeMode = 'system'|'light'|'dark'
  (default 'system'); resolvedScheme falls back to 'light' when OS reports
  null; colors identity flips only when resolution flips (useMemo'd).
  useTheme() throws "useTheme must be used within a ThemeProvider".
- `src/theme/navigationTheme.ts` — maps palette onto NavigationContainer
  theme (primary/background/card/text/border/notification) so future stack
  chrome stays consistent.
- App.tsx: SafeAreaProvider > ThemeProvider > AuthProvider > ThemedChrome
  (StatusBar barStyle from resolved scheme + backgroundColor token;
  NavigationContainer themed) > RootNavigator.
- All 7 screens converted to `createStyles(colors)` + useMemo pattern; inputs
  gained placeholderTextColor=textMuted; SettingsScreen gained a Theme section
  (Light/Dark/System radio chips, accessibilityRole=radio +
  accessibilityState.checked, testIDs settings-theme-light/dark/system);
  root testIDs login-screen/register-screen/level-screen added alongside
  existing chat-screen/history-screen/settings-screen/splash.
- Mode persistence intentionally deferred: not an acceptance criterion and
  AsyncStorage is not a project dependency; revisit at local-storage /
  Phase 14 Settings work.
- Tests __tests__/theme.test.tsx (15): system default resolves via mocked OS
  scheme; dark OS while system; explicit light/dark override OS; return to
  system re-follows OS; live OS change tracked while in system mode and
  IGNORED while pinned; null OS → light fallback; palettes expose identical
  token sets with non-empty values; useTheme outside provider rejects with
  helpful message; Settings switcher shows all three modes with System
  checked by default, Dark/Light selection moves checked state AND re-themes
  a sibling probe; Login + Chat container backgrounds equal palette values
  and flip on set-dark (screens-consume-tokens proof).
- Existing harnesses updated to wrap trees in ThemeProvider (navigation,
  Login, Register, Level suites) mirroring App.tsx order; App.test unchanged
  (renders real App).
- Test gotchas hit:
  - babel-plugin-jest-hoist rejects ANY identifier inside the jest.mock
    factory — including type-annotation parameter names (`next` in
    Set<(next) => void>). Fix: declare mock state in module-scope vars
    prefixed `mock` (whitelisted escape hatch), keep factory annotations to
    literal unions only.
  - RNTL v14 exports an ASYNC act: calling act(() => ...) without await
    corrupts subsequent renders (empty trees, "did not throw") for the REST
    OF THE FILE — must be await act(async () => ...).
  - RNTL v14 render() rejects (does not throw synchronously) when the tree
    errors: assert via await expect(render(<Orphan/>)).rejects.toThrow(...).

#### Sub-step record (all complete)
1. [x] Theme module files created
2. [x] App.tsx wiring
3. [x] Screen conversions + Settings theme section
4. [x] theme.test.tsx written (15 tests)
5. [x] Gates green (typecheck, lint, 57 jest tests across 9 suites)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-044

## Archived Tasks

### TASK-043 — Create application navigation (COMPLETED 2026-08-26)
- New deps (pnpm): @react-navigation/native ^7.3.17,
  @react-navigation/native-stack ^7.18.9, react-native-screens ^4.27.0
  (safe-area-context already present).
- `src/navigation/types.ts` — AuthStackParamList {Login, Register} +
  MainStackParamList {Chat, History, Settings, Level} + typed screen-prop
  aliases via NativeStackScreenProps.
- `AuthNavigator` / `MainNavigator` — native stacks, headerShown:false
  (screens own their chrome); Main initial route Chat; Level is pushed from
  Settings (keeps TASK-018 level editor reachable).
- `RootNavigator` — auth-status switch: loading → SplashScreen;
  unauthenticated → AuthNavigator; authenticated → MainNavigator.
  Whole-navigator swap keeps flows isolated (logout lands Login, login lands
  Chat).
- `App.tsx` — SafeAreaProvider > AuthProvider > NavigationContainer >
  RootNavigator (manual useState screen switching removed).
- Screens: ChatScreen + HistoryScreen placeholders (unique root testIDs
  chat-screen/history-screen/settings-screen; cross-links for testability,
  replaced by real UIs in later phases); HomeScreen DELETED — its content
  (welcome/email/logout/level entry) became SettingsScreen (testIDs
  settings-open-level / settings-logout); LevelScreen/LoginScreen/
  RegisterScreen converted from callback props to typed React Navigation
  (navigation.navigate/replace/goBack), all existing testIDs preserved.
- Auth switching uses navigation.REPLACE (not navigate): prevents stacking a
  second auth screen and Android-back returning to the previous form.
- jest.setup.js: react-native-screens mock added (ScreenStack/ScreenStackItem/
  ScreenFooter/header views as pass-through Views; compatibilityFlags:{};
  screensEnabled()=>false) AND safe-area-context mock extended with
  SafeAreaInsetsContext/SafeAreaFrameContext (React contexts) —
  @react-navigation/elements SafeAreaProviderCompat consumes the former and
  crashed on undefined context without it. jest.config.js gained pnpm-aware
  transformIgnorePatterns exception for @react-navigation (ships untranspiled
  ESM; nanoid/non-secure resolves CJS via exports require condition).
- Tests __tests__/navigation.test.tsx (6): splash-only while restore pending;
  unauthenticated → login visible + no main app; authenticated → Chat entry +
  focused route 'Chat'; Chat→History→back via stack state assertions;
  Settings→Level→back focused-route roundtrip; logout from Settings →
  Login + server invalidation + clearTokens + focused 'Login'. State
  assertions via createNavigationContainerRef().getRootState() — routes/index
  checked directly (acceptance: "navigation state is testable").
- Updated harnesses: App.test.tsx (restore→chat-screen; logout via settings;
  levels via settings); Login/RegisterScreen tests render a REAL mini
  auth-stack in NavigationContainer (typed createNativeStackNavigator<
  AuthStackParamList>); LevelScreen.test renders stack with initialState
  {index:1, routes:[Chat,Level]} and asserts back-pop via ref state.
- Test gotchas hit:
  - RNTL v14 render() IS ASYNC — querying `screen.*` synchronously right
    after un-awaited render() throws "`render` function has not been called"
    (setRenderResult happens after awaited act). Harnesses now await render.
  - Pass-through screens mock means stacked screens stay MOUNTED: ambiguous
    text/testID matches across screens ("History" link vs title) — gave each
    placeholder a unique root testID instead of asserting titles.
  - navigate('Login') from Register PUSHED a duplicate login screen (two
    login-identifier elements) — switched to replace().
  - initialState PartialState routes must NOT carry explicit key fields
    (TS2353).
- Gates: typecheck clean; eslint clean; jest 8 suites 42/42 passed.

#### Sub-step record (all complete)
1. [x] Deps installed (@react-navigation/native, native-stack,
       react-native-screens) + jest mocks/patterns
2. [x] src/navigation types + Auth/Main/Root navigators
3. [x] Chat/History placeholders; SettingsScreen replaces HomeScreen
4. [x] Login/Register/Level converted; App.tsx NavigationContainer rewired
5. [x] navigation.test.tsx + updated App/Login/Register/Level suites; gates
       green (typecheck, lint, 42 jest tests)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-043

## Archived Tasks

### TASK-042 — Implement failed-generation retry (COMPLETED 2026-08-26)
- `conversations/chat.py`:
  - Context assembly extracted into module-level `_build_turn_request(
    builder, session, *, before_sequence, current_text)` — the exact rules
    create_turn always had (complete rows past summary boundary and before
    `before_sequence`, chronological, windowed tail; topic reconstructed as
    GeneratedTopic(title, description); current text last). Behavior of
    UserMessageService.create_turn unchanged.
  - `RetryService(context_builder=None)` — constructor injection mirroring
    UserMessageService. `prepare_retry(*, session_id, message_id, user) ->
    PreparedTurn` inside ONE transaction.atomic: Session row select_for_update
    (serializes concurrent turns/retries per session) → message re-fetched
    THROUGH session.messages with select_for_update so foreign/missing
    messages are an indistinguishable Message.DoesNotExist → `_validate_
    retryable` under the lock → IN-PLACE reset (same pk + sequence,
    status=pending, content="", save update_fields ["status","content"]) →
    request rebuilt from the ORIGINAL prompt (user row = last role=user with
    sequence < failed.sequence; history cutoff at that row's sequence) →
    on_commit(schedule_session_summary_update) exactly like create_turn.
    ValueError ("Only failed assistant messages can be retried." / "no user
    message to retry") for complete/pending/user targets and orphaned failed
    rows. Second concurrent caller re-reads post-commit state under the lock
    and finds the row no longer failed → 409.
- `conversations/views.py`: get_retry_service() lru_cache seam +
  `MessageRetryView(APIView, IsAuthenticated)` POST without body:
  Session.DoesNotExist / Message.DoesNotExist → Http404 (indistinguishable
  no-leak), ValueError → 409 {"detail"}, then finalize_turn(assistant_row,
  llm seam stream) → sse_streaming_response — SAME SSE protocol as TASK-041,
  one streaming consumption path for mobile.
- `conversations/urls.py` — sessions/<int:pk>/messages/<int:message_pk>/retry/,
  name "session-message-retry".
- Tests backend/tests/test_retry_api.py (29 tests): anonymous 401 + zero
  changes; method matrix get/put/patch/delete 405; stranger-session/
  missing-session/foreign-message-in-own-session/missing-message 404s with
  zero provider calls + rows untouched; non-int pk route mismatches ×2;
  MVP-rule matrix — complete target 409 exact detail + content intact,
  pending target 409, user-message target 409, orphaned failed row (no
  preceding user prompt) 409; success frame protocol identical shapes incl.
  forwarded request roles [system,user,assistant,user] with verbatim earlier
  turn + original prompt last + no model/temperature pins; in-place replace
  (count still 2, same pks/sequences, user row untouched — NO duplication);
  lazy incremental delivery tracked against provider.produced; persistence-
  before-terminal-frame ordering; zero-delta completion → empty complete
  row; SSE transport headers; mid-conversation retry keeps later turns
  untouched AND excludes them from the rebuilt context; pre-stream failure →
  single error frame retryable False + row failed again (blank, is_retryable)
  + user row intact; mid-stream failure → deltas then error frame retryable
  True; partial output never persisted (marker absent, exact (sequence,
  role, status)); fail→retry→success lifecycle (two requests, count stays 2);
  seam cached identity; log hygiene (user text AND streamed markers absent
  across success+failure runs); summary schedule drained exactly once AFTER
  commit carrying session pk.
- Test gotchas hit: a scripted provider must be REINSTALLED between two
  retries in one test (stale script replays the old outcome); after a
  successful retry the same row is complete → further attempts are 409 by
  design (log-hygiene test needed its own second failed row).
- Gates: ruff check/format clean (94 files); pytest 696 passed +202 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/chat.py — shared _build_turn_request + RetryService.
       prepare_retry (+ logging)
2. [x] conversations/views.py — get_retry_service seam + MessageRetryView
       (DoesNotExist→404, ValueError→409)
3. [x] conversations/urls.py — session-message-retry route
4. [x] backend/tests/test_retry_api.py written (29 tests)
5. [x] Gates green (ruff check/format, pytest 696+202 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-042

## Archived Tasks

### TASK-041 — Implement streaming chat endpoint (COMPLETED 2026-08-26)
- `conversations/chat.py` — `finalize_turn(assistant_message, events)`
  generator wrapping any StreamingEvent iterator: yields every upstream event
  verbatim (client sees chunks incrementally); on the terminal event it
  updates the pending row FIRST and only then yields downstream, so a client
  observing `completed` can rely on the message being committed.
  StreamCompleted → content=text + status=complete (save update_fields
  [content,status]); StreamFailed → status=failed with blank content (partial
  output NEVER persisted as complete; is_retryable True); abandoned streams
  stay pending. Logging "conversations.chat": info completion line (pk +
  char count), warning failure line (pk + normalized error str); message text
  never logged.
- `conversations/views.py`:
  - `ChatMessageSerializer` — body {"text"}: required CharField, stripped in
    validate_text, blank-after-strip → 400 BEFORE any write/provider call.
    Unknown payload keys ignored (role/status/model hijacks no-op); DRF
    numeric coercion applies ("42" rename precedent). No temperature/model
    pins — PreparedTurn.request decides what reaches the LLM.
  - `get_user_message_service()` lru_cache seam mirroring get_topic_service;
    default builds real UserMessageService (real ContextBuilder, no provider).
  - `MessageStreamView(APIView, IsAuthenticated)` POST flow:
    serializer → UserMessageService.create_turn (transactional user+pending
    rows + context) → Session.DoesNotExist → Http404("No Session matches the
    given query.") so foreign/missing sessions are an indistinguishable 404
    (DRF preserves args in detail; non-int pks never match <int:pk>) →
    finalize_turn(assistant_row, llm stream events via llm.views seam called
    through module attribute so tests patch llm.views.get_streaming_service
    exactly like TASK-025) → sse_streaming_response. Provider failures leave
    the committed user turn + history intact; failed row retryable (TASK-042).
- `conversations/urls.py` — sessions/<int:pk>/messages/stream/, name
  "session-message-stream".
- Tests backend/tests/test_chat_stream_api.py (25 tests): anonymous 401 +
  zero writes; method matrix get/put/patch/delete 405; stranger/missing/
  non-int pk 404s with zero writes + no provider call; invalid-text matrix
  ({}/blank/whitespace) 400 before writes; numeric coercion ("42"); unknown
  fields ignored; success frame protocol (start/deltas/completed shapes,
  forwarded request model=None temperature=None system-first current-last);
  both rows persisted sequences 1/2 with exact statuses/contents; lazy
  incremental delivery tracked against provider.produced; persistence-before-
  terminal-frame ordering (row complete at the moment completed frame is
  pulled); zero-delta completion → empty complete row; SSE transport headers;
  summary schedule drained exactly once AFTER commit carrying session pk;
  pre-stream auth failure → single error frame retryable False + failed
  retryable row + intact user row; mid-stream availability failure → deltas
  then error frame retryable True; partial output never persisted (marker
  absent from DB, exact (sequence, role, status) shape [complete, failed]);
  seam cached identity; log hygiene (user text AND streamed text markers
  absent across success+failure runs).
- Test gotchas hit:
  - pytest-django wraps tests in a transaction so create_turn's on_commit
    callback never auto-fires — drain connection.run_on_commit manually and
    invoke (same pattern as TASK-039/040).
  - summary_schedule monkeypatch MUST be active for every authenticated
    request path (create_turn schedules unconditionally) — folded into the
    chat_api fixture chain instead of per-test params.
- Gates: ruff check/format clean (93 files); pytest 667 passed +202 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/chat.py — finalize_turn wrapper generator
2. [x] conversations/views.py — ChatMessageSerializer + seam +
       MessageStreamView
3. [x] conversations/urls.py — session-message-stream route
4. [x] backend/tests/test_chat_stream_api.py written (25 tests)
5. [x] Gates green (ruff check/format, pytest 667+202 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-041

## Archived Tasks

### TASK-040 — Implement user-message creation service (COMPLETED 2026-08-26)
- `conversations/chat.py`:
  - `PreparedTurn(user_message, assistant_message, request)` frozen dataclass —
    everything TASK-041 needs: the committed rows plus the ready-to-stream
    CompletionRequest.
  - `UserMessageService(context_builder=None)` — constructor injection of the
    ContextBuilder (tests substitute a recording fake); default builds the real
    one. NO provider involvement: this service makes no LLM call.
  - `create_turn(*, session_id, user, text)`: strip-validate text first
    (non-str / blank-after-strip → ValueError BEFORE any write), then ONE
    transaction.atomic block: Session.objects.select_for_update().get(pk,
    user) → foreign and nonexistent sessions are the same DoesNotExist (no
    existence leak; upstream maps to 404; row lock also serializes concurrent
    sequence allocation per session) → Message.append user (role=user,
    status=complete, stored content stripped) → Message.append assistant
    (pending, blank) → context build → on_commit(schedule_session_summary_update).
  - `_build_request`: history = session.messages filtered status=complete AND
    boundary < sequence < current sequence (current message never duplicated;
    pending/failed assistant rows carry no context), chronological via
    .order_by("sequence").values_list("role", "content"), windowed through
    select_recent_messages; topic reconstructed as GeneratedTopic(title=
    session.title, description=session.topic); summary + learning_level from
    the session row. Delegates entirely to ContextBuilder.
  - Summary wiring (the deferred TASK-039 integration): every turn schedules
    exactly one post-commit summary check; rollback enqueues nothing.
  - Logging "conversations.chat": single info line with session/user-message/
    assistant-message ids + duration. Message text NEVER logged.
  - Failure semantics: builder failure inside the block rolls back BOTH rows
    (conversation untouched — acceptance criterion); later stream failure is
    TASK-041's pending→failed transition on the already-committed row.
- Tests backend/tests/test_chat_service.py (34 tests): frozen value object;
  non-str + blank matrices rejected with zero writes; stripping; stranger +
  missing session → DoesNotExist with zero writes; sequences 1/2 then 3/4;
  persisted row states incl. is_retryable False while pending; fresh-request
  shape (system+user only, no model/temperature pins); history verbatim
  chronological between system and current; window=5 tail-only over 9 seeded
  turns; archived head excluded after boundary update (turns ≤8 absent);
  failed/pending assistant rows excluded from history; summary section
  present/absent; topic reconstructed into title/scenario lines; B2 vs AUTO
  level lines; builder-failure rollback of both rows + no enqueue;
  success → exactly one drained on_commit callback carrying session pk
  (nothing before commit), two turns → two callbacks; injected builder
  receives exact assembly kwargs (level/topic-as-GeneratedTopic/summary/
  recent_messages/current_message) and its request is returned verbatim;
  default builder is a real ContextBuilder; log hygiene (ids present,
  SECRET marker absent).
- Test gotchas hit:
  - Message.append defaults ASSISTANT rows to status=pending — history seed
    fixtures MUST pass status=COMPLETE explicitly or the service's
    complete-only filter silently drops them (first run caught 3 tests).
  - Django 6 has no captureOnCommitCallbacks — drain connection.run_on_commit
    manually (entries are (sids, func, robust)); monkeypatched module symbol
    IS picked up because the on_commit lambda resolves the global at call time.
- Gates: ruff check/format clean (92 files); pytest 642 passed +202 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/chat.py — UserMessageService.create_turn + PreparedTurn +
       validation + transactional scheduling + logging
2. [x] backend/tests/test_chat_service.py written (34 tests)
3. [x] Gates green (ruff check/format, pytest 642+202 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-040

## Archived Tasks

### TASK-039 — Implement asynchronous summary update (COMPLETED 2026-08-26)
- `conversations/tasks.py` (first Celery task in the codebase; picked up by
  config/celery.py autodiscover_tasks → verified registered as
  "conversations.update_session_summary" via app.loader.import_default_modules()):
  - `summarize_session(session_id) -> bool` — worker-free body: fetches the
    Session row (DoesNotExist → info log + False: sessions deleted between
    enqueue and execution are a graceful no-op), then delegates to
    SessionSummaryTrigger(get_summary_provider()).update(session). ALL trigger
    guarantees carry over unchanged: select_for_update re-fetch, boundary
    idempotency (duplicate deliveries recompute pending count under the row
    lock and find nothing left), rollback of summary+boundary on provider
    failure.
  - `update_session_summary` shared_task(bind=True): retryable LLMError →
    self.retry(exc=exc); non-retryable LLMError (auth, unusable output) →
    warning + return False (conversation keeps working with its existing
    summary; same range retried on the next threshold crossing). Non-LLMError
    propagates unmasked. Options: max_retries=5 (SUMMARY_UPDATE_MAX_RETRIES),
    acks_late=True (at-least-once delivery survives worker crashes;
    duplicates harmless by construction), retry_backoff=5 exponential with
    retry_backoff_max=600 and jitter=True.
  - `get_summary_provider()` seam — lru_cache(maxsize=1)
    FallbackProvider.from_settings(), mirrors llm.views._settings_streaming_service;
    tests monkeypatch the module symbol.
  - `schedule_session_summary_update(session_id)` — request-side entry point:
    transaction.on_commit(lambda: update_session_summary.delay(session_id)).
    Nothing reaches the broker while the surrounding transaction may still
    roll back. Deliberately NOT wired into any view yet: chat flow
    integration is TASK-040/041.
  - Logging "conversations.tasks": warning lines carry session id +
    normalized error str only; payloads never logged.
- Tests backend/tests/test_summary_tasks.py (19 tests): task options pinned
  (name/max_retries/backoff/jitter/acks_late); provider seam builds cached
  FallbackProvider from settings; eager .apply() behavior matrix — happy path
  persists summary+boundary+True, threshold-not-crossed no-op without
  provider call, missing session graceful no-op, RETRYABLE failure retried
  inline until success (2 requests, persisted), budget exhaustion
  (max_retries monkeypatched 0) → FAILURE surfacing original LLMAvailabilityError
  + session untouched, non-retryable auth failure → SUCCESS/False no change,
  blank-output LLMResponseError → SUCCESS/False (request made once),
  double-run → exactly one summarization (no duplicate ranges, exact turns
  1-40 archived lines), second batch rolls previous summary forward (turns
  41-80 + PREVIOUS_SUMMARY_HEADER, boundary 80), failure logs carry ids/
  errors but never turn text or summary text, schedule helper enqueues
  exactly once AFTER commit / never after rollback (set_rollback).
- Test gotchas hit (environment):
  - Django 6 REMOVED django.test.utils.captureOnCommitCallbacks — drained
    connection.run_on_commit manually (flush_on_commit_callbacks helper);
    entries are (sids, func, robust) tuples.
  - Celery eager apply() RE-EXECUTES retried tasks inline
    (Task.apply follows retval.sig.apply(retries=retries+1)); a Retry never
    surfaces as EagerResult state "RETRY" — script failure→success outcomes
    on ONE provider instance and assert final SUCCESS instead; budget
    exhaustion tested by monkeypatching max_retries to 0 (original exc is
    raised at the retry call → FAILURE state).
- Gates: ruff check/format clean (90 files); pytest 608 passed +202 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/tasks.py — update_session_summary + summarize_session +
       get_summary_provider seam + schedule_session_summary_update (on_commit)
2. [x] backend/tests/test_summary_tasks.py written (19 tests)
3. [x] Gates green (ruff check/format, pytest 608+202 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-039

### TASK-038 — Implement summary trigger (COMPLETED 2026-08-26)
- `conversations/trigger.py`, two layers:
  - Pure planner `archive_range(total_messages, *, boundary, window=None,
    threshold=None) -> tuple[int,int] | None`: end = total - window; fires iff
    (end - boundary) >= threshold → inclusive (boundary+1, end). One rule gives
    both batching AND idempotency: short conversations (< window+threshold)
    never fire; after compaction the pending count resets to 0 so immediate
    repeats are a no-op. Explicit window/threshold misuse → ValueError;
    total/boundary validated non-negative ints (bool rejected), boundary >
    total rejected. ROADMAP §5 cadence reproduced exactly (B=0,N=60 → 1-40;
    B=40,N=100 → 41-80).
  - DB-facing `SessionSummaryTrigger(provider)` — `update(session) -> bool`
    wraps ConversationSummarizer (constructor injection). transaction.atomic +
    select_for_update re-fetch by pk: the plan is recomputed against the LOCKED
    row's boundary, so concurrent/repeat callers see fresh state and cannot
    double-summarize. Batch filtered to status=complete + non-blank content
    (pending/failed assistant rows carry no summarizable content and the
    summarizer rejects blanks); empty filtered batch still advances the
    boundary with NO provider call. Persists summary + summary_message_boundary
    together via save(update_fields=[...]); provider failure rolls back BOTH
    (session untouched, same range retried next time).
- Setting CONTEXT_SUMMARY_TRIGGER_THRESHOLD (default 40 — value already
  documented in .env.example from TASK-036 prep) via decouple cast=int;
  `summary_threshold()` resolves getattr-fallback + ImproperlyConfigured
  naming the variable (mirrors recent_message_window). Default ratio: compact
  one 40-message batch per crossing once the conversation exceeds 60 messages.
- Logging "conversations.trigger": info on success (session id/range/count/
  duration), debug no-op line; payloads never logged.
- Wiring deliberately NOT in views yet: chat flow integration is TASK-040/041,
  async Celery migration TASK-039.
- Tests backend/tests/test_summary_trigger.py (32 tests + 29 subtests):
  config default pinned 40 / read / attribute-absent fallback / boundary(1) /
  large accepted / invalid-configured matrix names variable; planner exact-
  crossing matrix (59→None, 60→(1,40)), repeat-no-op, next-batch, ROADMAP
  example walk, ≤window silent, boundary==total silent, explicit-kwargs win,
  invalid window/threshold/total/boundary matrices, determinism; DB tests:
  short-conversation no-op without provider call, exact-crossing persists
  summary+boundary with verbatim ordered labeled lines (turns 1-40 only,
  window turns absent), first-compaction header omitted, immediate repeat
  no-op (1 request total), second batch rolls SUMMARY_ONE forward as
  previous_summary with turns 41-80, failed-assistant row skipped from input
  but covered by boundary, provider failure leaves session untouched + retry
  hits identical range, unusable output propagates without persisting,
  all-blank range advances boundary sans call, DB-row refetch (stale instance
  + .update(summary="pre-existing") proves locked row is source),
  log hygiene (no turn text / summary text in any record).
- Test gotchas hit: fill fixture must offset content labels from sequence
  numbers when appending twice (seq 61 carries "turn 1" otherwise false-positive
  diffs); first batch needs WINDOW+THRESHOLD messages to cross the trigger
  point (THRESHOLD alone never fires at defaults).
- Gates: ruff check/format clean (88 files); pytest 589 passed +202 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/trigger.py — summary_threshold + archive_range +
       SessionSummaryTrigger.update
2. [x] config/settings.py CONTEXT_SUMMARY_TRIGGER_THRESHOLD (+ .env.example comment)
3. [x] backend/tests/test_summary_trigger.py written (32 tests)
4. [x] Gates green (ruff check/format, pytest 589+202 Postgres, manage.py check)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-038

## Archived Tasks

### TASK-037 — Implement conversation summarizer (COMPLETED 2026-08-26)
- `conversations/summarizer.py`: `ConversationSummarizer(provider)` wrapping
  ANY LLMProvider (constructor injection → mockable); `summarize(*,
  previous_summary="", archived_messages) -> str`. Input is EXACTLY the
  increment: previous rolling summary + only the `(role, content)` turns that
  just left the recent window, chronological. The whole conversation is never
  seen by (or sent to) this service.
- Request: one CompletionRequest.from_texts — system prompt demanding ONLY a
  plain-text updated summary (no headings/markdown/quoting/commentary;
  preserve names, preferences, corrections, open threads) + user turn with
  optional "Summary of the conversation so far:" block (blank or whitespace-
  only previous summary = first compaction, block omitted) + the archived
  batch verbatim as labeled `role: content` lines + write instruction. No
  model pin / temperature (provider default resolves).
- Validation (all ValueError pre-call): previous_summary must be str;
  archived_messages must be non-empty (summarization runs only when messages
  actually leave the window); entries unpack as (role, content), roles
  restricted to {user, assistant} via conversations.context.HISTORY_ROLES
  (reused, single source of truth; "system"/"tool"/case variants rejected),
  non-blank string content enforced. Mirrors ContextBuilder history rules.
- Parsing `_parse_summary`: strip + tolerate ONE surrounding ``` fence
  (optional language tag); blank/whitespace output → LLMResponseError(
  provider="summaries", model=served). Provider LLMError failures propagate
  UNCHANGED (identity preserved); non-LLMError unmasked.
- Logging "conversations.summaries": info success line (model/chars/duration),
  warning on unusable output (normalized error str + served model). Request/
  completion payload text never logged (asserted for both paths).
- Persistence deliberately out of scope: callers own the Session row
  (summary/summary_message_boundary) — trigger/persistence is TASK-038,
  async Celery update TASK-039.
- Tests backend/tests/test_summarizer.py (28 tests + 23 subtests,
  SimpleTestCase/FakeProvider): stripped result, fenced tolerance (incl.
  language-tagged), empty-batch rejection without provider call, invalid-role
  matrix ("system"/"tool"/""/"User"/"USER"/"assistant "/None/5), blank +
  non-string content, malformed entry shapes (("user",)/(a,b,c)/"user: hi"/
  None), non-str previous_summary — all no-provider-call; request shape
  exactly system+user, plain-text system contract, no model/temperature pins;
  first-compaction omits summary block, existing summary incorporated under
  header, distinct summaries → distinct prompts, whitespace-only ≡ empty
  (equal requests), archived lines verbatim/in-order/labeled, ONLY-the-batch
  boundary (outsider texts absent; exact line slice between headers equals
  the batch), generator input accepted, determinism, cross-call recording;
  blank-completion matrix → non-retryable "summaries" errors with served
  model; auth/availability/base-LLM error identity passthrough; RuntimeError
  unmasked; log hygiene success+failure (model/error present, SECRET marker
  from request AND completion absent).
- Test gotcha: a JSON-looking non-blank completion is ACCEPTED as summary
  text by design (free-text contract) — failure-log hygiene test had to mark
  the REQUEST payload instead and force the blank-output warning path.
- Gates: ruff check/format clean (86 files); pytest 557 passed +173 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/summarizer.py — ConversationSummarizer.summarize(
       *, previous_summary="", archived_messages) -> str
2. [x] backend/tests/test_summarizer.py written (28 tests)
3. [x] Gates green (ruff check/format, pytest 557+173 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-037

## Archived Tasks

### TASK-036 — Implement recent-message window (COMPLETED 2026-08-26)
- `conversations/window.py` (pure, no DB/provider): `DEFAULT_RECENT_MESSAGE_WINDOW
  = 20`; `recent_message_window()` resolves settings.CONTEXT_RECENT_MESSAGE_WINDOW
  (getattr falls back to the default when the attribute is absent); 
  `select_recent_messages(messages, *, limit=None)` → tuple of at most N tail
  turns in original chronological order, verbatim, any single-pass iterable.
- Configurability: explicit `limit=` kwarg wins; else Django setting (new:
  config/settings.py CONTEXT_RECENT_MESSAGE_WINDOW via decouple cast=int,
  default 20; .env.example comment expanded). Error split: explicit-limit
  misuse → ValueError (programmer error, mirrors ContextBuilder); invalid
  configured setting → ImproperlyConfigured naming CONTEXT_RECENT_MESSAGE_WINDOW
  (mirrors llm/config.py TASK-023). Validation rejects non-int/bool/<1 — the
  <1 guard also blocks Python's seq[-0:] == whole-sequence footgun.
- Current-user-message contract (acceptance): the window NEVER contains it;
  callers pass it separately to ContextBuilder as current_message so it stays
  last, stripped, unduplicated regardless of window size (composition tests).
- Tests backend/tests/test_window.py (24 tests + 13 subtests): default pinned
  to 20; setting read + attribute-absent fallback + boundary(1)/large accepted;
  invalid configured matrix (0/-3/"20"/"many"/None/2.5/True) names the
  variable; tail selection exact+ordered, archived head never leaks (exact
  membership — substring "turn 2" ⊂ "turn 21" gotcha hit and fixed), exactly-
  limit / under-limit / empty / generator inputs, verbatim passthrough, tuple
  result, invalid-explicit-limit matrix, limit=None resolves configuration,
  configured-0 rejected; composition with ContextBuilder on a 40-turn
  transcript @window 20: 22 messages (system + last 20 verbatim roles/contents
  + current last), head 1–20 absent, current stripped/unduplicated, window=1
  still keeps current message, short conversation fully included.
- Gotcha: assertNotIn("turn N", joined-text) false-positives on turn-number
  prefixes ("turn 2" inside "turn 21") — assert against content lists instead.
- Gates: ruff check/format clean (84 files); pytest 529 passed +150 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/window.py — recent_message_window + select_recent_messages
2. [x] config/settings.py CONTEXT_RECENT_MESSAGE_WINDOW (+ .env.example comment)
3. [x] backend/tests/test_window.py written (24 tests)
4. [x] Gates green (ruff check/format, pytest 529+150 Postgres, manage.py check)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-036

### Archived Tasks

### TASK-035 — Create context builder (COMPLETED 2026-08-26)
- `conversations/context.py`: `ContextBuilder.build(*, level, topic, summary="",
  recent_messages=(), current_message)` → one deterministic CompletionRequest:
  single system message (identity + level line + topic title/scenario +
  optional rolling-summary block, fixed section order) + given history turns
  verbatim in chronological order + stripped current user message LAST.
- Bounded by construction: the builder consumes ONLY the window it is handed —
  window selection is the caller's concern (TASK-036), compaction TASK-037/038 —
  so old messages can never silently re-enter the context. Pure assembly: no
  DB access, no provider call, no payload logging.
- Validation (all ValueError pre-assembly): unknown level vs Level.values;
  topic must be GeneratedTopic (isinstance, mirrors generate_sample); blank/
  whitespace current_message rejected; history roles restricted to
  {user, assistant} ("system"/"tool" injection rejected) with non-blank
  content enforced via llm.types.Message inside from_texts.
- No model pin / temperature on the request (provider default resolves).
- Tests backend/tests/test_context_builder.py (31 tests + 17 subtests):
  exact message skeleton + verbatim history order, current-message-last +
  stripping, no model/temperature pins, exactly-one-system-at-front, empty
  history → system+user only, list input accepted, history ending with user
  not merged with current message; system-prompt sections present and ordered
  identity→level→topic→summary, blank/whitespace summary omits block,
  summary/topic survive without history; all 7 levels accepted, AUTO infer
  line vs concrete lines, distinct prompts per level, Z9/""/"b2" rejected;
  non-topic/blank-current/system-history/tool-role/blank-content matrices →
  ValueError; determinism (equal requests) + different-window changes only
  that section; bounded-history test (40-turn transcript, last-4 window,
  turns 1/36 absent).
- Gates: ruff check/format clean (81 files); pytest 505 passed +137 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/context.py — ContextBuilder.build + validation
2. [x] backend/tests/test_context_builder.py written (31 tests)
3. [x] Gates green (ruff check/format, pytest 505+137 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-035

## Archived Tasks

### TASK-034 — Implement session deletion (COMPLETED 2026-08-26)
- `DELETE /api/v1/sessions/{id}/` — SessionDetailView base class changed
  generics.RetrieveAPIView → generics.RetrieveDestroyAPIView: delete() comes
  from DestroyModelMixin and reuses the SAME user-scoped get_queryset →
  get_object(), so a stranger's session and a nonexistent id remain
  indistinguishable 404s (no existence leak), consistent with GET/PATCH.
  Success = empty 204. POST/PUT still 405 via dispatch.
- Related messages are deleted by the Message.session FK cascade
  (on_delete=CASCADE, TASK-027) — ORM-level collector, no extra view code;
  sibling sessions and their messages survive untouched.
- test_session_detail_messages_api.py detail method matrix now post/put
  ("delete" removed); same replacement pattern as TASK-031/033.
- test_session_rename_api.py TestMethodMatrix also dropped "delete"
  (first pytest run caught it — DELETE on detail is legitimate since this task).
- Tests backend/tests/test_session_delete_api.py (13): anonymous 401 (+ row
  unchanged), owner 204 + empty body + row gone, session's messages cascaded
  to zero rows, sibling sessions/messages survive, deleted session vanishes
  from listing + GET-after-delete 404, stranger 404 + session AND message rows
  untouched, missing pk 404, non-int pk route mismatch 404, repeat DELETE →
  404 (row already gone), method matrix 405 ×2 (+ row intact), GET still 200.
- Gates: ruff check/format clean (80 files); pytest 474 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/views.py — SessionDetailView → RetrieveDestroyAPIView
2. [x] test_session_detail_messages_api.py detail matrix updated (no DELETE)
3. [x] backend/tests/test_session_delete_api.py written (13 tests)
4. [x] Gates green (ruff check/format, pytest 474+120 Postgres, manage.py check)
5. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-034

## Archived Tasks

### TASK-033 — Implement session rename (COMPLETED 2026-08-26)
- `PATCH /api/v1/sessions/{id}/` — SessionDetailView (generics.RetrieveAPIView)
  gained an explicit patch() handler: GET untouched, POST/PUT/DELETE still 405
  via dispatch. Ownership reuses get_object() over the user-scoped
  get_queryset → foreign/nonexistent sessions are an indistinguishable 404;
  <int:pk> keeps non-int ids off the route.
- New SessionRenameSerializer (ModelSerializer, fields=["title"]): the ONLY
  declared field, so topic/topic_hint/learning_level/summary/boundary/user/id/
  created_at can never change through this endpoint regardless of payload
  (unknown keys silently ignored by DRF). Title required + non-blank
  (CharField blank rejection), whitespace stripped → blank-after-strip → 400,
  max_length 255 enforced (256 → 400, 255 accepted). Numeric payloads coerced
  to str ("42" rename works) per DRF CharField behavior documented in TASK-030.
- Response 200 = full SessionSerializer repr (same contract as GET detail);
  internal summary/boundary/updated_at never leak. save() bumps updated_at via
  auto_now → renamed session moves to front of the -updated_at listing.
- test_session_detail_messages_api.py: "patch" removed from the detail method
  matrix (now post/put/delete) — same replacement pattern as TASK-031's GET-405.
- Tests backend/tests/test_session_rename_api.py (20): anonymous 401 (+ row
  unchanged), owner rename persisted + full repr field-set (+ internal-field
  non-leak), whitespace stripping, numeric coercion, rename bumps listing
  order (set_updated_at pinning convention from TASK-031), immutability
  hijack matrix (topic/hint/level/summary/boundary/user/id/created_at all
  ignored), title-only payload leaves rest alone, stranger 404 + row
  untouched, missing pk 404, non-int pk route mismatch 404, validation matrix
  ({}/blank/whitespace/256-char → 400 with title unchanged), 255-char
  accepted, method matrix 405 ×3, GET still 200.
- Gates: ruff check/format clean (79 files); pytest 463 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/serializers.py — SessionRenameSerializer
2. [x] conversations/views.py — patch() on SessionDetailView
3. [x] test_session_detail_messages_api.py detail matrix updated (no PATCH)
4. [x] backend/tests/test_session_rename_api.py written (20 tests)
5. [x] Gates green (ruff check/format, pytest 463+120 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-033

## Archived Tasks

### TASK-032 — Implement session detail/messages API (COMPLETED 2026-08-26)
- `GET /api/v1/sessions/{id}/` — SessionDetailView (generics.RetrieveAPIView):
  get_queryset scoped to Session.objects.filter(user=request.user), so a
  stranger's session and a nonexistent id are indistinguishable (both 404,
  no existence leak). Non-int pks never match the route (<int:pk> → Django
  404).
- `GET /api/v1/sessions/{id}/messages/` — MessageListView
  (generics.ListAPIView): get_object_or_404(Session, pk=kwargs["pk"],
  user=request.user) FIRST → foreign/missing sessions 404 before any message
  serialization; then session.messages.all() ordered by Message.Meta.ordering
  ("sequence") — single source of truth, not duplicated with order_by.
- Pagination: global DRF defaults apply to the messages list ({count,next,
  previous,results}); invalid pages → 404; page_size fixed at 20.
- New MessageSerializer: id/role/status/content/sequence/created_at only —
  session FK id never leaks. Detail view reuses SessionSerializer (summary/
  summary_message_boundary/updated_at stay internal).
- Unsupported methods on both endpoints (POST/PUT/PATCH/DELETE) → 405 via
  generics.
- Tests backend/tests/test_session_detail_messages_api.py (26): anonymous
  401 ×2, owner detail field-set + internal-field non-leak, stranger detail
  404 + missing pk 404 + non-int pk route mismatch 404, method matrix 405 ×2,
  empty messages envelope, exact message fields incl. role/status/sequence,
  out-of-order sequence insertion → sequence order returned, cross-session
  isolation within same user, stranger's messages 404 (row still exists),
  pagination matrix (25 msgs: page1 20+next, page2 remainder+previous,
  sequences 1..25 across pages, invalid pages 999/abc/0 → 404, stranger
  messages don't count toward my count).
- Test gotchas hit: Message.append requires keyword-only role (pass it in
  fixtures); DRF 404 detail is "No Session matches the given query." (assert
  "detail" in data, not a literal string); <int:pk> routes cannot reverse()
  with "abc" — hit the literal path instead.
- Gates: ruff check/format clean (78 files); pytest 444 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/serializers.py — MessageSerializer
2. [x] conversations/views.py — SessionDetailView + MessageListView
3. [x] conversations/urls.py wiring (names "session-detail"/"session-messages")
4. [x] backend/tests/test_session_detail_messages_api.py written (26 tests)
5. [x] Gates green (ruff check/format, pytest 444+120 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-032

## Archived Tasks

### TASK-031 — Create session listing API (COMPLETED 2026-08-26)
- `GET /api/v1/sessions/` added to the conversations collection view:
  SessionCreateView (APIView) refactored into SessionCollectionView
  (generics.ListAPIView) — GET lists via ListModelMixin, POST keeps the
  TASK-030 creation flow verbatim (custom post() override; generics' create
  machinery unused). URL name "sessions" unchanged.
- User-specific: get_queryset filters Session.objects.filter(user=request.user);
  no other user's rows can appear regardless of query params.
- Ordering: relies on Session.Meta.ordering ("-updated_at") — single source of
  truth for most-recently-updated-first (model ordering was designed for this
  in TASK-026); asserted by tests rather than duplicated with order_by.
- Pagination: global DRF defaults (PageNumberPagination, PAGE_SIZE=20) apply
  through GenericAPIView.pagination_class → {count,next,previous,results}
  envelope; invalid page → 404; page_size not client-tunable (default
  PageNumberPagination).
- Serializer unchanged (SessionSerializer: id/title/topic/topic_hint/
  learning_level/created_at) — internal summary/boundary/updated_at fields
  never leak through listing payloads (asserted).
- Tests backend/tests/test_session_list_api.py (14): anonymous 401, empty-list
  envelope, exact serializer field set (+ no summary/updated_at leakage),
  cross-user scoping incl. stranger's newest row excluded, most-recently-
  updated-first via pinned updated_at (.update() bypasses auto_now), update
  bumps session to front, 25-session pagination matrix (first page 20+next,
  second page remainder+previous, order preserved across pages, invalid pages
  999/abc/0 → 404, stranger sessions don't count toward my pages).
- test_session_api.py: obsolete "GET is 405" test replaced by parametrized
  PUT/PATCH/DELETE → 405 (GET now legitimately lists).
- Test gotcha hit: my first cross-page ordering expectation was inverted —
  offsets grow with index so Session 00 (now - smallest offset) is the MOST
  recent and comes first; the endpoint was right, the assertion wasn't.
- Gates: ruff check/format clean (77 files); pytest 418 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/views.py — SessionCollectionView (ListAPIView) + user-scoped get_queryset
2. [x] conversations/urls.py rewired to SessionCollectionView (name unchanged)
3. [x] backend/tests/test_session_list_api.py written (14 tests)
4. [x] test_session_api.py GET-405 test replaced (PUT/PATCH/DELETE 405)
5. [x] Gates green (ruff check/format, pytest 418+120 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-031

### TASK-030 — Create session API (COMPLETED 2026-08-26)
- `POST /api/v1/sessions/` in conversations app: SessionCreateView (APIView,
  IsAuthenticated) + SessionCreateSerializer (optional topic_hint; blank/
  whitespace → ""; DRF CharField coerces numbers to strings) +
  SessionSerializer (ModelSerializer: id/title/topic/topic_hint/
  learning_level/created_at).
- Atomicity by ordering: level read from learning Profile
  (get_or_create, lazy-provisioned like ProfileView) → topic generated →
  sample generated → SINGLE Session.objects.create at the end. Provider
  failures therefore cannot leave corrupt/empty sessions (nothing is written
  before both LLM calls succeed). Session.title = GeneratedTopic.title;
  Session.topic = GeneratedTopic.description.
- Response 201: session fields + sample_conversation {turns:[{role,content}]}
  via dataclasses.asdict (in-memory display data, not persisted as messages).
- Errors: LLMError.retryable → 503 else 502 with {"detail": normalized
  str(exc)} (secret-safe by construction); non-LLMError unmasked.
- Service seam get_topic_service() + lru_cache'd _settings_topic_service()
  mirroring llm.views.get_streaming_service; tests monkeypatch the seam.
- Wiring: conversations/urls.py (app_name "conversations", name "sessions") →
  included under /api/v1/ in config/urls.py. GET on sessions/ → 405 until
  TASK-031 adds listing.
- Tests backend/tests/test_session_api.py (16): anonymous 401 (+ nothing
  persisted), happy path (owner/title/topic/hint/payload incl. sample turns),
  generate/sample call shapes (level from profile AUTO default + B2 profile,
  sample receives the SAME GeneratedTopic instance), empty body → hint "",
  whitespace-only hint normalization, numeric-hint coercion ("42"), unknown
  payload fields ignored (title/user hijack no-op), distinct hints → distinct
  calls, failure atomicity matrix (retryable topic error → 503 + count 0 +
  no sample call; non-retryable → 502; sample failure AFTER successful topic
  → still zero sessions; base LLMError retryable=True → 503), GET → 405,
  get_topic_service cached identity (override_settings API key for real
  construction).
- Test gotchas hit: asdict turns come back as a TUPLE in response.data
  (compare via list(...)); DRF CharField casts int payloads to str rather
  than rejecting; the real settings seam requires OPENROUTER_API_KEY to be
  non-empty (provider constructor rejects "") — use override_settings in the
  caching test.
- Gates: ruff check/format clean (76 files); pytest 403 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/serializers.py — SessionCreateSerializer + SessionSerializer
2. [x] conversations/views.py — SessionCreateView + get_topic_service seam
3. [x] conversations/urls.py + config/urls.py wiring (name "sessions")
4. [x] backend/tests/test_session_api.py written (16 tests)
5. [x] Gates green (ruff check/format, pytest 403+120 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-030

## Archived Tasks

### TASK-029 — Generate sample conversation (COMPLETED 2026-08-26)
- `conversations/topics.py` extended (service class unchanged, new members):
  `SampleTurn(role, content)` + `SampleConversation(turns)` frozen value
  objects; roles reuse `Message.Role.USER/ASSISTANT` ("user"/"assistant") so
  the example renders/speaks like a normal exchange and TASK-030 can serialize
  it directly. `MIN_SAMPLE_TURNS = 2` enforced in both the parser
  (→ LLMResponseError) and the value type (backstop ValueError).
- `TopicGenerationService.generate_sample(*, topic, level)` — second
  structured-JSON call keyed to an already-generated GeneratedTopic ("sample
  belongs to the topic"): validates level against Level.values AND topic
  isinstance pre-call (ValueError before any provider request), builds
  system+user CompletionRequest via from_texts.
- Prompt contract: SAMPLE_SYSTEM_PROMPT demands ONLY one JSON object
  {"turns": [{role, content}]}, only assistant/user roles, 4–6 turns
  alternating starting with "assistant". User prompt mirrors topic-prompt
  level semantics (B2 echo vs AUTO infer) and injects topic title +
  description; distinct topics → distinct prompts.
- `_parse_sample`/`_parse_turn`: tolerant extraction via existing
  _extract_json_object (fenced/prose-wrapped OK); rejects non-dict payload,
  missing/non-list turns, <2 turns, non-dict turn entries, roles outside
  {assistant,user}, missing/non-str/blank content as retryable=False
  LLMResponseError(provider="topics", model=served). Extra keys ignored
  top-level and per-turn; values stripped. Provider LLMError failures
  propagate UNCHANGED; non-LLMError unmasked. Payload text never logged
  (info success line has model/turns/duration; warning carries normalized
  error str only).
- Not persisted anywhere — pure in-memory display data for the "Show me an
  example" flow (ROADMAP §7); dataclasses are API-returnable (asdict → JSON).
- Tests backend/tests/test_topic_sample.py (30 tests): turn/conversation
  frozen+tuple-normalization+role/content/count validation, invalid-level +
  non-topic matrices rejected pre-call, all 7 levels accepted, happy-path
  parse/stripping/extra-keys/fenced/prose-wrapped, request shape (system+user),
  prompt contracts (JSON shape, role names, B2 echo vs AUTO infer, topic
  injection, distinct prompts), 27-case invalid-output matrix (all →
  non-retryable "topics" errors), served-model attribution, provider-error
  identity passthrough, ValueError unmasked, JSON round-trip serializability,
  log hygiene on success AND failure. test_topic_service.py untouched (23
  still pass).
- Gates: ruff check/format clean (73 files); pytest 387 passed +120 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/topics.py — SampleTurn/SampleConversation +
       generate_sample + _parse_sample/_parse_turn + logging/__all__
2. [x] backend/tests/test_topic_sample.py written (30 tests)
3. [x] Gates green (ruff check/format, pytest 387+120 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-029

## Archived Tasks

### TASK-028 — Implement topic generation service (COMPLETED 2026-08-26)
- `conversations/topics.py`: frozen `GeneratedTopic(title, description)` —
  title doubles as session-title material, description carries enough
  scenario detail for the AI tutor (ROADMAP §6). `TopicGenerationService`
  wraps ANY LLMProvider; `generate(*, level, hint="")` validates level
  against learning.Level.values (ValueError before any provider call),
  builds a system+user CompletionRequest via from_texts.
- Prompt contract: system demands ONLY one JSON object {"title",
  "description"}; user turn echoes concrete CEFR level or asks the model to
  infer for AUTO; hint sentence injected when non-blank after strip,
  otherwise "gave no preference" fallback. Whitespace-only hint == empty.
- Structured-output parsing `_parse_topic`: tolerant extraction (direct
  json.loads → outermost brace span retry) handles fenced/prose-wrapped
  output; rejects non-dict payloads, missing/non-string/blank title or
  description as LLMResponseError(provider="topics", model=served model).
  Extra JSON keys ignored. Provider LLMError failures propagate UNCHANGED
  (retryable flags preserved); non-LLMError exceptions unmasked.
- Logging "conversations.topics": info success line (model/chars/duration),
  warning on unusable output with normalized error str — completion payload
  text never logged (asserted by tests).
- Tests backend/tests/test_topic_service.py (23 tests + 31 subtests) on a
  FakeProvider(LLMProvider) recording requests: GeneratedTopic frozen/value-
  equality, invalid-level matrix rejected pre-call + all 7 Level values
  accepted, whitespace-hint normalization, empty-hint topic generation,
  value stripping, extra-key tolerance, fenced + prose-wrapped JSON parsed,
  request shape (exactly system+user), system prompt JSON contract, B2 echo
  vs AUTO inference instruction, hint influence + distinct hints → distinct
  prompts, 20-case invalid-output matrix (all → retryable=False
  LLMResponseError attributed to "topics" with served model), provider
  error identity passthrough (availability/auth), ValueError unmasked, log
  hygiene (payload markers absent on success AND failure).
- Test gotchas hit: read provider.requests[-1] not [0] after multiple calls;
  "leaky payload" fixture must be MALFORMED JSON — valid JSON with an extra
  marker key parses fine by design and raises nothing.
- Gates: ruff check/format clean (72 files); pytest 357 passed +68 subtests
  (Postgres); manage.py check clean.

#### Sub-step record (all complete)
1. [x] conversations/topics.py — GeneratedTopic + TopicGenerationService
2. [x] backend/tests/test_topic_service.py written (23 tests)
3. [x] Gates green (ruff check/format, pytest 357+68 Postgres, manage.py check)
4. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-028

### TASK-027 — Create message model (COMPLETED 2026-08-26)
- `conversations.Message`: FK session (CASCADE, related_name="messages"),
  role CharField(16) TextChoices user/assistant, status CharField(16)
  TextChoices pending/complete/failed (default PENDING = assistant
  generation-in-progress state), content TextField(blank, default="" — blank
  valid only for pending assistant rows), sequence PositiveIntegerField,
  created_at auto_now_add. Meta ordering ("sequence",) → deterministic.
- Integrity: UniqueConstraint (session, sequence) named
  conversations_message_unique_session_sequence (per-session deterministic
  ordering, DB-enforced); CheckConstraint condition=NOT(role=user AND
  status!=complete) named conversations_message_user_role_complete as DB
  backstop + model.clean() ValidationError on "status" for form-level parity.
  Django 6 gotchas: Meta.constraints cannot reference sibling nested classes
  by bare name at class-body scope (used literals "user"/"complete");
  CheckConstraint kwarg is `condition=` (`check=` removed in Django 6).
- Domain helpers: `Message.append(session, *, role, content="", status=None)`
  classmethod allocates Max(sequence)+1 and defaults status COMPLETE for
  user / PENDING for assistant (TASK-040/041 will build on this);
  `is_retryable` property True only for assistant+failed (MVP retry rule).
- conversations/admin.py MessageAdmin: list_display/filter/search +
  created_at readonly.
- Migration conversations/0002_message generated AND applied to live
  Postgres (verified via \d: unique + check constraints present).
- Tests backend/tests/test_message.py (32): append defaults per role,
  all 3 statuses round-trip, __str__, created_at, session related-name +
  session/user cascade, same sequence across distinct sessions allowed,
  Meta ordering deterministic with out-of-order insertion, monotonic
  sequence allocation, duplicate (session, sequence) → IntegrityError,
  is_retryable matrix (unsaved instances), failed→pending→complete retry
  lifecycle, ORM insert of incomplete user message → IntegrityError,
  full_clean validation matrix (invalid role/status, missing session,
  non-complete user status error, blank content OK for pending assistant),
  field-shape assertions incl. ordering.
- Gates: ruff check/format clean; pytest 334 passed +37 subtests (Postgres);
  manage.py check clean. Pre-existing InsecureKeyLengthWarning noise from
  short JWT test secrets (test_auth/test_logout) — unrelated to this task.

#### Sub-step record (all complete)
1. [x] `conversations.Message` model + constraints + helpers
2. [x] Admin registration (MessageAdmin)
3. [x] Migration conversations/0002_message (+ applied to live PG, schema verified)
4. [x] backend/tests/test_message.py written (32 tests)
5. [x] Gates green (ruff check/format, pytest 334+37 Postgres, manage.py check)
6. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-027

### TASK-026 — Create conversation/session model (COMPLETED 2026-08-26)
- `conversations.Session`: FK user (AUTH_USER_MODEL, CASCADE,
  related_name="conversation_sessions"), title CharField(255), topic TextField,
  topic_hint TextField(blank, default=""), learning_level CharField(4) reusing
  learning.Level.choices default AUTO (single source of truth for CEFR levels),
  summary TextField(blank, default="") + summary_message_boundary
  PositiveIntegerField(default=0) for rolling-summary compaction (TASK-037/038),
  created_at auto_now_add / updated_at auto_now. Meta ordering ("-updated_at")
  matches session-listing requirement (TASK-031 most-recent-first).
- conversations/admin.py SessionAdmin: list_display/filter/search on level +
  timestamps; created_at/updated_at readonly.
- Migration conversations/0001_initial generated AND applied to live Postgres
  (verified via showmigrations + information_schema column dump — all 10
  expected columns present).
- Tests backend/tests/test_session.py (24): defaults (AUTO level, empty hint/
  summary, boundary 0), all 7 levels persist round-trip, __str__, timestamps
  set + updated_at advances on save, ownership via FK + related-name access,
  user-delete cascade, cross-user independence, default ordering desc,
  full_clean validation matrix (invalid/blank level, missing user, blank
  title/topic), field-shape assertions for every required SPEC field.
- Acceptance mapping: sessions belong to users (FK + cascade); users cannot
  access another user's session (per-user FK scoping enforced at ORM level —
  API-layer enforcement is TASK-030..034 which will filter by request.user);
  migrations + model tests exist.
- Gates: ruff check/format clean; pytest 302 passed +37 subtests (Postgres);
  manage.py check clean.
- Gotcha (environment, not code): running pytest from backend/ WITHOUT
  POSTGRES_PASSWORD=change-me fails at DB connect (compose owns credentials) —
  always export it for host-run gates.
- Note: run-loop.sh has unrelated uncommitted tooling edits (loop-exit counter);
  deliberately excluded from the task commit.
- Found partially implemented in working tree on resume (models/admin/migration/
  tests already written); remaining verification steps completed this run.

#### Sub-step record (all complete)
1. [x] `conversations.Session` model with required fields + ordering + __str__
2. [x] Admin registration (SessionAdmin)
3. [x] Migration conversations/0001_initial generated (+ applied to live PG)
4. [x] backend/tests/test_session.py written (creation, ownership/cascade,
       ordering, validation matrix, field-shape assertions)
5. [x] Apply migration to live Postgres from host (was already applied;
       verified table schema)
6. [x] Gates green (ruff check/format, pytest 302+37 Postgres, manage.py check)
7. [x] SPEC.md marked [x]; STATE archived; commit feat: complete TASK-026

### TASK-024 — Implement LLM streaming service (COMPLETED 2026-08-26)
- `llm/types.py`: service-level terminal events `StreamCompleted(text, model,
  delta_count)` and `StreamFailed(error: LLMError, text="")` + union
  `StreamingEvent = StreamStart | StreamDelta | StreamCompleted | StreamFailed`.
  Provider-level `StreamEvent` untouched. types.py now imports llm.exceptions
  (no cycle; both transport-agnostic).
- `llm/streaming.py`: `StreamingCompletionService(provider)` wrapping ANY
  LLMProvider. stream(request) yields exactly one StreamStart, zero+ deltas,
  then EXACTLY one terminal event per call: StreamCompleted only on natural
  provider exhaustion (full joined text, server-served model from start,
  delta count) or StreamFailed on any LLMError (error instance preserved;
  partial text == exactly what the consumer already received). Consumer
  contract: persist a complete assistant message ONLY on StreamCompleted —
  failed or abandoned streams never are.
- Normalization guards: empty stream (no events), delta-before-start,
  duplicate start, unknown event type → LLMResponseError ("streaming"
  provider attribution, model attached when known) surfaced as StreamFailed
  mid-sequence after already-yielded events. Non-LLMError exceptions
  propagate unchanged (programming bugs are not masked as stream failures).
- Lifecycle mirrors FallbackProvider: duck-typed close() delegation +
  context manager. Logging "llm.streaming": info completion line (model/
  chars/deltas/duration), warning failure line (normalized error str) —
  streamed payload text never logged.
- Tests backend/tests/test_streaming_service.py (21 tests + 6 subtests) on a
  ScriptedProvider recording produced events: frozen terminal events +
  StreamingEvent union membership, identity passthrough of provider events,
  completed.model is served (not requested/pinned) model, zero-delta success,
  request forwarded untouched, pre-stream failure (single Failed, empty
  partial, non-retryable auth error preserved), mid-stream failure (deltas +
  Failed with retryable availability error + "Partial" text), contract-
  violation matrix, incremental lazy pull (provider.produced grows one event
  per next(); abandoned stream emits no Completed), ValueError propagation
  with no terminal event, close/context-manager lifecycle, log hygiene
  (model + normalized error present, SECRET-PAYLOAD absent from all logs).
- Gates: ruff check/format clean; pytest 254 passed +37 subtests (Postgres);
  manage.py check clean.
- Gotcha (environment): this shell mangles multi-diagnostic ruff output into
  an aggregated "N matches in NF" format — redirect ruff stdout to a file and
  Read it (or use --output-format=json) to see real rule codes/positions.

#### Sub-step record (all complete)
1. [x] Terminal events in llm/types.py
2. [x] llm/streaming.py StreamingCompletionService
3. [x] backend/tests/test_streaming_service.py
4. [x] Gates green (ruff check/format, pytest Postgres, manage.py check)
5. [x] SPEC.md marked [x]; commit feat: complete TASK-024

### TASK-025 — Implement SSE endpoint foundation (COMPLETED 2026-08-26)
- `llm/sse.py`: `encode_sse_event()`, `iter_sse_frames()`, `sse_streaming_response()` —
  encodes `StreamStart`/`StreamDelta`/`StreamCompleted`/`StreamFailed` into SSE frames
  (`event:` + single-line JSON `data:` + blank separator) with `text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- `llm/views.py`: `LLMStreamView` (DRF `APIView`) handling authenticated POST
  `/api/v1/llm/stream/`. `StreamRequestSerializer` validates `{messages, temperature?}`
  with no client-side model pin; uses `get_streaming_service()` seam (lru_cache'd
  `StreamingCompletionService(FallbackProvider.from_settings())`) for testability.
- `llm/urls.py` + `config/urls.py`: route `POST /api/v1/llm/stream/` → `LLMStreamView`.
- `backend/tests/test_sse_endpoint.py` (24 tests): anonymous → 401, GET → 405,
  validation matrix (missing/empty/invalid messages, temperature bounds),
  transport headers on success+failure, success frame sequence (start→delta*→completed)
  with clean connection close, zero-delta completion, request forwarded without model pin,
  incremental lazy delivery (provider.produced grows per `next()`), pre-stream failure
  → single error frame, mid-stream failure → deltas + single error frame (no partial
  duplication in error payload), non-LLMError exceptions propagate unchanged.
- Gates: ruff check/format clean; pytest 278 passed +42 subtests (Postgres);
  manage.py check clean.

### TASK-023 — Create backend model configuration (COMPLETED 2026-08-26)
- `backend/llm/config.py`: frozen `ModelConfiguration(api_key, base_url,
  timeout_seconds, primary_model, fallback_models)` + `model_chain` property
  (primary first) and module-level `load_model_configuration()` — the single
  place Django settings are read for LLM concerns. Normalization: model names
  stripped; blank/duplicate fallback entries and fallbacks equal to the
  primary dropped (order preserved); base_url stripped + trailing "/" removed;
  timeout cast to float. Validation raises ImproperlyConfigured naming the
  offending variable: blank LLM_PRIMARY_MODEL, blank OPENROUTER_BASE_URL,
  non-numeric/non-positive/non-finite LLM_REQUEST_TIMEOUT_SECONDS, missing
  setting attributes; missing OPENROUTER_API_KEY passes through "" in dev
  (production requirement enforced by validate_production_configuration).
  Logging "llm.config": debug line with primary + fallback count only.
- Refactor: `OpenRouterProvider.from_settings()` and
  `FallbackProvider.from_settings()` now build from `load_model_configuration()`
  — `django.conf.settings` no longer imported by any llm business module;
  FallbackProvider constructs its inner OpenRouterProvider directly from one
  config load (no double read). No behavior change otherwise.
- Tests backend/tests/test_llm_config.py (18): value assembly from documented
  settings, strip/dedupe rules incl. all-blank fallbacks → primary-only,
  empty-key dev passthrough, per-variable ImproperlyConfigured matrix,
  missing-setting sentinel path, provider wiring (OpenRouter default_model/
  timeout/base_url; Fallback full chain), source-level guards asserting no
  model-name fragments ("gpt|claude|gemini|llama|mistral|deepseek|qwen|grok")
  and no direct `settings.LLM_*`/`settings.OPENROUTER_*` access in llm/
  business modules, api key absent from config logs.
- test_fallback_provider.py: from_settings wiring test updated to patch
  `llm.fallback.load_model_configuration` + OpenRouterProvider constructor;
  DEFAULT_BASE_URL constant added locally.
- Docs: `.env.example` LLM section explains chain semantics/retryable-only
  fallback/catalog id format; README gained "LLM model configuration" section.
- Gates: ruff check/format clean; pytest 233 passed +31 subtests (Postgres);
  manage.py check clean.

  Compose services up and healthy; backend restarted with token_blacklist
  migrations applied.

### TASK-022 — Implement OpenRouter model discovery (COMPLETED 2026-08-26)
- `llm/types.py`: frozen `ModelInfo(id, name="", description=None,
  context_length=None, created=None)` — normalized provider-agnostic catalog
  entry; blank id rejected; exported via `__all__`.
- `llm/openrouter.py`: `OpenRouterProvider.list_models() -> tuple[ModelInfo, ...]`
  — GET `/models` (MODELS_PATH) with the same Authorization header. Reuses
  `_http_failure`/timeout/transport normalization with model=None (helper
  annotations widened to `str | None`). 200 body must contain a `data` list or
  LLMResponseError ("no data list"; non-object JSON handled by shared parser).
  Entries parsed defensively via module-level `_parse_model_entry` +
  `_int_or_none` (bool rejected as int subclass): non-dict entries and
  blank/non-string ids are skipped, id stripped, missing name coerced to "".
  Catalog order preserved; malformed entries never fail the whole listing.
  Logging "llm.openrouter": info count/skipped/duration on success, warning
  status on failure — never payloads or secrets.
- Design decision: `list_models()` is an OpenRouterProvider capability method,
  NOT on the LLMProvider ABC — completion-interface fakes/mocks elsewhere stay
  trivial; consumers depend only on `llm.types.ModelInfo`.
- Tests: test_openrouter_client.py +13 tests +5 subtests (request shape GET/
  URL/auth, full+minimal normalization, order preservation, id stripping,
  malformed-entry skipping incl. boolean context_length, empty catalog,
  missing/non-list data, non-object JSON, status matrix for /models asserting
  model=None, timeout+transport retryable, key absent from results/errors/
  logs). test_llm_provider.py +3 ModelInfoTests (defaults, blank-id rejection,
  frozen).
- Gates: ruff check/format clean; pytest 215 passed +31 subtests (Postgres);
  manage.py check clean.

  Gates: ruff check/format clean; pytest 215 passed +31 subtests (Postgres);
  manage.py check clean.

### TASK-021 — Implement model fallback (COMPLETED 2026-08-26)
- `backend/llm/fallback.py`: FallbackProvider(LLMProvider) decorating ONE inner
  provider with an ordered model chain (primary first). complete() retries the
  next chain entry only on `LLMError.retryable` failures (transport/timeout/
  availability); auth/bad-request/response errors raise immediately (a
  different model cannot fix them). All-fail → aggregate LLMAvailabilityError
  "all N configured model(s) failed: <model>: <msg>; ..." chained from the
  last error, retryable=True so callers above may still retry.
- stream(): falls back ONLY while probing for the first event (`next()` opens
  the HTTP request + status check in OpenRouterProvider's lazy generator).
  Once any event is emitted the attempt is committed — mid-stream failures
  propagate unchanged (restarting would duplicate already-consumed text).
  StopIteration during probe → LLMResponseError (contract violation,
  non-retryable).
- Explicit `request.model` pin replaces the whole chain for a single attempt
  (pinned intent wins); a pinned retryable failure still normalizes into the
  aggregate availability error. Chain models are stripped/validated non-blank;
  request shape (messages/temperature) preserved per attempt via
  dataclasses.replace.
- Lifecycle: close() delegates to inner provider when it offers one (duck-
  typed; no-op otherwise), context-manager supported; from_settings() builds
  OpenRouterProvider.from_settings() with chain [LLM_PRIMARY_MODEL,
  *LLM_FALLBACK_MODELS]. Logging via "llm.fallback": warning per failed
  attempt/exhaustion, info on fallback success (never logs payloads).
- Tests backend/tests/test_fallback_provider.py (23 tests + 7 subtests) on
  scripted fakes (no HTTP): construction validation/stripping, primary
  passthrough, retryable-class matrix triggers fallback, non-retryable matrix
  aborts with identical exception instance, 3-model ordering, all-fail
  aggregate content + __cause__, single-model normalization, request-shape
  preservation, pin bypass (complete+stream), stream probe fallback /
  mid-stream no-fallback / non-retryable probe / aggregate, close delegation +
  context manager + close-less inner, from_settings wiring.
- Gotchas: test-side walrus-in-dict-literal SyntaxError fixed by hoisting
  RESPONSE_C; pinned single-attempt exhaustion raises the aggregate error too
  (consistent rule: any exhausted chain → normalized availability error).
- Gates: ruff check/format clean; pytest 200 passed (Postgres); manage.py
  check clean.

### TASK-020 — Implement OpenRouter client (COMPLETED 2026-08-26)
- `httpx` 0.28.1 added via uv (sync client, streaming, timeout support;
  MockTransport gives clean mocked-HTTP tests).
- `backend/llm/openrouter.py`: OpenRouterProvider(LLMProvider) — POST
  /chat/completions with {model, messages, stream, temperature?}. Constructor
  takes api_key/default_model/base_url/timeout (+ optional injected
  httpx.Client; provider only closes clients it owns; context-manager
  supported). `from_settings()` classmethod wires Django settings
  (OPENROUTER_API_KEY/BASE_URL, LLM_PRIMARY_MODEL, LLM_REQUEST_TIMEOUT_SECONDS)
  — factory/DI wiring for services stays with later tasks.
- complete(): parses text/model/finish_reason/request_id (x-request-id header
  preferred, body `id` fallback); malformed 200s (missing choices, non-str
  content, bad JSON) → LLMResponseError. stream(): SSE parser ignores blank
  lines + ": keep-alive" comments, stops at [DONE]; StreamStart emitted on
  first chunk with the server-served model (falls back to requested model if
  chunks lack one), empty deltas and usage-only chunks skipped; zero-chunk
  stream → LLMResponseError.
- Error normalization: 401/403→LLMAuthenticationError, 400/404/413/422→
  LLMBadRequestError, 408→LLMTimeoutError, 429+5xx→LLMAvailabilityError,
  other→LLMResponseError; httpx.TimeoutException→LLMTimeoutError,
  other httpx.HTTPError→LLMRequestError (both retryable). Server error
  messages extracted ({error:{message}} / {message} / raw snippet) and
  truncated to 300 chars.
- Secret hygiene: key lives only in the Authorization header — never in
  payloads, exception messages, or logs. Logging via "llm.openrouter":
  info on success (model/request_id/duration/counts), warning on failure
  (status/type names only).
- Tests backend/tests/test_openrouter_client.py (33 tests + 19 subtests):
  constructor validation + client ownership, payload/header shape, model
  override & temperature forwarding, request-id precedence, malformed-response
  matrix, full status-mapping matrix, error-body variants (OpenRouter JSON /
  plain text / truncation), transport failures, stream success (incremental
  Start→Deltas, keep-alive handling, empty-delta skipping, model fallback),
  stream failures (error status, malformed data line, unexpected SSE line,
  empty stream, mid-stream ReadError preserving partial deltas, mid-stream
  timeout), secret-hygiene (errors/payloads/logs never contain the key),
  from_settings wiring.
- Gotcha: test-injected httpx.Client MUST carry base_url when the provider
  posts relative paths — a bare Client(transport=...) makes "/chat/completions"
  an invalid URL inside cookie extraction.
- Gates: ruff check/format clean; pytest 177 passed (Postgres); manage.py
  check clean.

### TASK-019 — Create LLM provider interface (COMPLETED 2026-08-26)
- `backend/llm/types.py`: frozen dataclasses Message (role Literal
  system/user/assistant + non-blank content), CompletionRequest (tuple-
  normalized messages, optional model override, temperature validated to
  0.0–2.0, from_texts helper), CompletionResponse (text, model, finish_reason,
  request_id), StreamStart(model) + StreamDelta(non-empty text) with
  StreamEvent union. No vendor specifics.
- `backend/llm/exceptions.py`: normalized hierarchy under LLMError(message,
  provider, model, retryable) with __str__ "provider [model]: message";
  LLMRequestError→LLMTimeoutError + LLMAuthenticationError / LLMBadRequest /
  LLMAvailabilityError / LLMResponseError; retryable defaults: transport/
  timeout/availability True, auth/bad-request/response False.
- `backend/llm/provider.py`: LLMProvider ABC with complete() and stream()
  returning Iterator[StreamEvent]; docstring contract: first event
  StreamStart, exhaustion = success, failures raise LLMError subclasses.
  Zero HTTP/vendor imports (OpenRouter client is TASK-020; no factory yet —
  DI at service construction, wiring in TASK-020/023).
- Tests backend/tests/test_llm_provider.py (21): role/content validation,
  frozen types, request normalization (list→tuple, empty rejected, model/
  temperature bounds), response defaults, empty-delta rejection, ABC cannot
  instantiate (incl. partial impl), consumer function runs against Fake +
  Mock(spec=LLMProvider) proving mockability, incremental stream consumption
  with delta accumulation, mid-stream LLMError propagates after deltas,
  exception retryable-defaults matrix, and a source-level guard asserting the
  three abstraction modules import no httpx/requests/urllib/socket/openrouter.
- Gates: ruff check/format clean; pytest 144 passed (Postgres); manage.py
  check clean.
- Design note: errors are raised rather than yielded from stream(); SSE layer
  (TASK-025) will map exceptions to error events. StreamStart carries the
  resolved model so TASK-021 fallback attribution needs no interface change.

### TASK-018 — Create mobile learning-level screen (COMPLETED 2026-08-26)
- `src/api/profile.ts`: EnglishLevel union ('A1'..'C2'|'AUTO'), LEVELS metadata
  (label + short description per level), getProfile(token) → GET and
  updateProfile(token, level) → PATCH /api/v1/profile/.
- AuthContext: added async `getAccessToken()` that awaits initial session
  restore before reading tokensRef. Gotcha: child effects run BEFORE parent
  effects in React, so a screen mounted alongside a fresh provider would read
  null mid-restore; a deferred promise resolves at the end of restore() (also
  on unmount, so callers never hang).
- New LevelScreen: header with back button, all 7 levels as radio rows with
  CEFR descriptors; loads current level on mount (loading indicator), tap →
  PATCH with busy guard (rows disabled while saving, spinner on saving row),
  success shows "Saved." + server-confirmed selection, failure keeps last
  confirmed selection + role="alert" error (levels stay selectable so a failed
  GET doesn't block saving). accessibilityRole="radio" +
  accessibilityState.checked.
- Wiring: App.tsx authenticated branch toggles HomeScreen ↔ LevelScreen;
  HomeScreen gained optional onOpenLevels prop rendering a blue "Learning
  level" button (testID home-open-levels).
- Tests: __tests__/LevelScreen.test.tsx (6): all levels listed + GET called,
  server level preselected, PATCH persists new selection, save failure keeps
  confirmed selection + surfaces field error, GET failure still allows saving,
  back invokes callback. App.test.tsx (+1): home → level screen → back.
  Gotcha: jest automock strips module constants — profile API must be mocked
  with a factory spreading requireActual so LEVELS survives.
- Gates: pnpm lint / typecheck clean; jest 36 passed (7 suites).
- Live verification (existing emulator + Metro, no rebuild needed — JS-only):
  register smoke_t18 via curl → app login → Home → Learning level: all 7 rows,
  AUTO checked (server default) → tap B2 → checked + "Saved." → backend GET
  /profile/ confirms {"level":"B2"} → back returns to Home. Smoke user's child
  rows deleted first (see TASK-017 gotcha), then user; app uninstalled.

### TASK-017 — Create learning profile API (COMPLETED 2026-08-26)
- `GET/PATCH /api/v1/profile/` in learning app: ProfileView (APIView,
  IsAuthenticated) + ProfileSerializer (ModelSerializer, fields=["level"];
  choices-generated field rejects anything outside A1..C2/AUTO — wrong case
  and blank included → clean DRF 400).
- Lazy provisioning: both GET and PATCH run
  `Profile.objects.get_or_create(user=request.user)`, so a fresh user can
  read their profile immediately; model default AUTO applies until updated.
  PATCH on missing profile creates then validates.
- Unknown payload fields ignored (only "level" declared → "user" tampering
  is a no-op); POST/PUT/DELETE → 405.
- learning/urls.py (`app_name="learning"`, name "profile") included under
  `/api/v1/` in config/urls.py.
- New tests backend/tests/test_profile_api.py (21): anonymous GET/PATCH → 401,
  GET auto-provisions AUTO + no duplicates across reads, persisted level
  returned, PATCH updates+persists, all 7 documented levels accepted,
  invalid/wrong-case/blank → 400 with level unchanged, unknown fields
  ignored, cross-user isolation, unsupported methods → 405.
- Gates: ruff check/format clean; pytest 123 passed (Postgres); manage.py
  check clean.
- Live verification (bind-mounted compose backend, no rebuild): register →
  GET {"level":"AUTO"} 200 → PATCH B2 200 → PATCH Z9 400 choice error → GET
  B2 → anonymous 401. Smoke user deleted afterwards.
- Gotcha (expected Django behavior, not a bug): DB-level FKs are plain
  DEFERRABLE constraints — CASCADE lives in the ORM collector, so raw-SQL
  user deletes must remove child rows (learning_profile,
  token_blacklist_outstandingtoken) first.

### TASK-016 — Create learning profile model (COMPLETED 2026-08-26)
- `learning.Level` TextChoices: A1/A2/B1/B2/C1/C2 + AUTO (labels include
  CEFR descriptors; AUTO = "let AI decide").
- `learning.Profile`: OneToOneField(settings.AUTH_USER_MODEL, CASCADE,
  related_name="learning_profile") + level CharField(max_length=4, choices,
  default=AUTO). No extra fields — SPEC lists `level` only; expansion later.
- learning/admin.py: ProfileAdmin with list_display/list_filter/search.
- Migration learning/0001_initial created AND applied to live Postgres from
  host (`POSTGRES_PASSWORD=change-me manage.py migrate learning`) so the
  compose backend picks it up without rebuild.
- New tests backend/tests/test_profile.py (12): default AUTO, all 7 levels
  persist round-trip, __str__, duplicate-profile IntegrityError, related-name
  access, user-delete cascade, distinct-user independence, invalid/blank
  level + missing user via full_clean, exact choice-set assertion,
  field-shape assertions (CharField + max_length + choices).
- Gates: ruff check/format clean; pytest 102 passed (Postgres); manage.py
  check clean.

### TASK-015 — Implement mobile authentication flow (COMPLETED 2026-08-26)
- `react-native-keychain` ^10 added (pnpm); autolinked into debug APK
  (`com.oblador.keychain` classes verified inside APK). Tokens are stored as a
  JSON blob via setGenericPassword under service `com.elearningmobile.auth` —
  never AsyncStorage.
- New structure `mobile/src/`: `config.ts` (API_BASE_URL =
  http://10.0.2.2:8000 emulator→host alias), `auth/tokens.ts`,
  `auth/secureStorage.ts` (save/load/clear; corrupted/partial payloads → null),
  `api/client.ts` (fetch wrapper + ApiError normalizing DRF `{detail}` and
  field-error shapes; network failure → status 0 friendly message),
  `api/auth.ts` (register/login/refresh/me/logout bindings matching backend
  response shapes), `auth/AuthContext.tsx`.
- AuthContext: restore-on-start via /me with single refresh-token fallback
  (both fail → clearTokens → unauthenticated); login stores tokens + user;
  register auto-logs-in with submitted credentials; logout is best-effort
  server invalidation + unconditional local clear. Errors surfaced via
  `error` state; `busy` guards double submits.
- Screens: LoginScreen / RegisterScreen / HomeScreen (+ SplashScreen);
  state-based switching in App.tsx RootNavigator (react-navigation deferred to
  TASK-043). Minimal neutral styling; full theme system remains TASK-044.
- Backend tweak needed by live testing: DisallowedHost for emulator Host
  header → DEBUG-mode default now appends `10.0.2.2`; compose default and
  .env.example updated too. (Production unaffected — DJANGO_ALLOWED_HOSTS must
  be set explicitly.)
- Jest/RNTL gotcha: RNTL v14 render() is async (screen binding) AND
  fireEvent.* returns a promise that must be awaited or state assertions read
  stale trees. All interactions awaited.
- Tests: 29 passing across secureStorage(5), apiClient(5), AuthContext(8),
  LoginScreen(3), RegisterScreen(4), App flow(3+1). Keychain mocked globally
  in jest.setup.js with in-memory store.
- Gates: pnpm lint/typecheck/test green; gradlew assembleDebug SUCCESS;
  backend ruff check/format + manage.py check + pytest 90 passed.
- Live verification on headless emulator (AVD elearning, Metro via adb
  reverse): register smoke_t15 → auto-login Home; force-stop + relaunch →
  session restored ("Welcome, smoke_t15"); logout → backend logged POST
  /auth/logout/ 200 (refresh blacklisted), UI back to login; re-login via
  username OK. Smoke user deleted, app uninstalled afterwards.

### TASK-014 — Implement logout (COMPLETED 2026-08-26)
- `rest_framework_simplejwt.token_blacklist` added to INSTALLED_APPS; its
  bundled migrations applied to dev Postgres automatically at compose backend
  boot (no project-level migration needed).
- `POST /api/v1/auth/logout/` in accounts app (name "logout"), authenticated
  via default IsAuthenticated (like MeView). Body {refresh}: LogoutSerializer
  parses the token with RefreshToken(token) during validation — garbage,
  wrong-type (access), expired, blank or already-blacklisted tokens all map to
  a clean 400 field error instead of an unhandled 500 (TokenError must be
  caught explicitly). View then calls token.blacklist() → 200 {"detail":
  "Logged out."}.
- Invalidation semantics: blacklisted refresh token fails /auth/refresh/ with
  401 (simplejwt verify() checks the blacklist); other sessions' refresh
  tokens unaffected; outstanding access tokens stay valid until their short
  expiry (no access-token denylist — documented MVP strategy).
- New tests backend/tests/test_logout.py (14): success + blacklist row
  persisted, refresh rejected afterwards, access token still authenticates
  /me, sibling session unaffected, anonymous → 401, missing/blank/garbage/
  access-as-refresh/expired/already-blacklisted → 400, GET → 405, full
  login→use→logout→refresh-rejected lifecycle.
- Gates: ruff check/format clean; pytest 90 passed (Postgres) / 87+3 skips
  (sqlite fallback); manage.py check clean.
- Live verification (compose backend restarted for migrations): register →
  login → refresh 200 → logout 200 → refresh 401 → anonymous logout 401.
  Throwaway smoke user deleted afterwards.

### TASK-013 — Implement JWT authentication (COMPLETED 2026-08-26)
- `djangorestframework-simplejwt` 5.5.1 (+ pyjwt) added via uv.
- settings.py: SIMPLE_JWT with ACCESS_TOKEN_LIFETIME / REFRESH_TOKEN_LIFETIME
  derived from existing env vars (JWT_ACCESS_TOKEN_MINUTES=15,
  JWT_REFRESH_TOKEN_DAYS=7). DRF DEFAULT_AUTHENTICATION_CLASSES →
  JWTAuthentication; DEFAULT_PERMISSION_CLASSES → IsAuthenticated (secure by
  default; register/login/refresh/health opt out via AllowAny, which they
  already declared).
- Endpoints in accounts app: `POST /api/v1/auth/login/` (LoginView),
  `POST /api/v1/auth/refresh/` (TokenRefreshView), `GET /api/v1/auth/me/`
  (MeView, IsAuthenticated → current user id/username/email).
- LoginSerializer subclasses TokenObtainPairSerializer: authenticate with the
  submitted identifier as username first; if it contains "@" and failed, resolve
  account by case-insensitive email and retry with its username. Returns
  {access, refresh, user}. Gotcha: raising ValidationError yields HTTP 400 for
  bad credentials; must raise InvalidToken to get proper 401 + Bearer header.
- No blacklist app yet — token invalidation is TASK-014 (logout).
- New tests backend/tests/test_auth.py (15): login via username/mixed-case
  email, tokens authenticate /me, no password echo; wrong password/unknown/
  inactive → 401; missing fields → 400; refresh happy path + garbage token +
  access-token-as-refresh → 401; expired AccessToken (set_exp backdated) → 401;
  tampered signature → 401; anonymous /me → 401 with WWW-Authenticate: Bearer
  (realm suffix asserted via startswith); public endpoints stay open;
  SIMPLE_JWT lifetimes derive from env settings.
- Gates: ruff check/format clean; pytest 76 passed (Postgres) / 73+3 skips
  (sqlite fallback); manage.py check clean.
- Live verification (rebuilt compose backend image for new dep): register 201 →
  login (username AND mixed-case email) → /me 200 with access, 401 without →
  refresh issues working new access. Throwaway smoke user deleted afterwards.

### TASK-012 — Implement registration API (COMPLETED 2026-08-26)
- `POST /api/v1/auth/register/` via accounts app: `RegistrationSerializer`
  (ModelSerializer on accounts.User; fields id/username/email/password) +
  `RegistrationView` (DRF CreateAPIView, AllowAny). Wired through
  accounts/urls.py (`app_name = "accounts"`, name "register") included under
  `/api/v1/` in config/urls.py. 201 on success; DRF field errors → 400.
- Password handling: write_only CharField with trim_whitespace=False (no silent
  mutation); Django `validate_password` runs in serializer.validate() against a
  candidate unsaved User built from submitted username/email so
  UserAttributeSimilarityValidator compares against both identifiers before any
  DB write; creation via `create_user` (hashes password, normalizes email
  domain). Password never appears in responses or error payloads.
- Gotcha: similarity validator uses SequenceMatcher quick_ratio ≥ 0.7 —
  "alice123456789"-style long passwords pass; test uses near-identical
  "WalterWhite!" vs username "walterwhite".
- Uniqueness enforced at API layer by model unique=True → UniqueValidator
  (duplicate username/email → clean 400, no IntegrityError leak).
- New tests backend/tests/test_registration.py (17): happy path 201 (+ no
  password in payload), persistence + check_password, hashed storage,
  email domain normalization, duplicate username/email, missing required
  fields (parametrized), invalid email format, short/common/numeric-only/
  similar-to-username passwords, no user created on validation failure,
  GET → 405, unauthenticated access allowed.
- Gates: ruff check/format clean; pytest 55 passed (Postgres) / 52+3 skips
  (sqlite fallback); manage.py check clean.
- Live verification (compose backend): valid POST → 201 {id, username, email};
  duplicate POST → 400 field error; throwaway smoke user deleted afterwards.

### TASK-011 — Create user model (COMPLETED 2026-08-26)
- `accounts.User(AbstractUser)` with unique non-blank email override; username
  stays USERNAME_FIELD → login can accept either identifier later. Stock
  AbstractUser password hashing retained (no custom manager needed).
- `AUTH_USER_MODEL = "accounts.User"` set in settings.py BEFORE any dependent
  migration existed (accounts had no models/migrations until now).
- accounts/0001_initial generated and applied against live Postgres.
  Gotcha: dev DB already had pre-AUTH_USER_MODEL admin/auth migrations →
  InconsistentMigrationHistory. Dev DB had zero data, so schema was dropped
  (`DROP SCHEMA public CASCADE`) and re-migrated fresh — mirrors clean checkout.
- User registered in Django admin via stock UserAdmin passthrough.
- ruff: added `extend-exclude = ["**/migrations"]` to backend/pyproject.toml —
  Django-generated migrations trip E501/format; standard exclusion.
- Fixed TASK-009 test fallout in tests/test_database.py: isolation probe's raw
  SQL referenced legacy table name `auth_user` → now uses
  `get_user_model()._meta.db_table`; all create_user calls now pass unique
  emails (unique constraint rejects duplicate "" emails).
- New tests backend/tests/test_user.py (10): creation round-trip, hashing
  (never plaintext), email domain normalization, superuser flags, duplicate
  username/email IntegrityErrors, missing-email full_clean rejection,
  AUTH_USER_MODEL wiring + USERNAME_FIELD.
- Gates: ruff check/format clean; pytest 38 passed (Postgres) / 35+3 skips
  (sqlite fallback); manage.py check clean; compose backend restarted healthy,
  live /api/v1/health/ → 200.

### TASK-010 — Add API health endpoint (COMPLETED 2026-08-26)
- `GET /api/v1/health/` implemented in backend/config/views.py (DRF api_view,
  AllowAny) + wired in config/urls.py with name "health"; no new app needed.
- Payload: {status, components{database}, time ISO8601 UTC}; DB probe is
  SELECT 1 via connection.cursor(); any probe exception → component
  "unavailable" and HTTP 503, all healthy → 200.
- Secret hygiene: response contains only statuses — never SECRET_KEY,
  POSTGRES_PASSWORD, or OPENROUTER_API_KEY (asserted by test).
- Redis/Celery probes deferred until those app-level integrations exist;
  compose healthchecks already cover infra. `components` dict keeps it
  extensible.
- New tests backend/tests/test_health.py (5): 200+payload, recent tz-aware
  timestamp, secret-leak guard, 405 on POST, 503 on patched probe failure.
- Gates: ruff check/format clean, pytest 28 passed (Postgres-backed),
  manage.py check clean; live curl against compose backend → 200 healthy.

### TASK-009 — Create database configuration (COMPLETED 2026-08-26)
- PostgreSQL confirmed as primary engine from host AND inside Docker
  (postgres:17-alpine, healthy). Host access needs POSTGRES_PASSWORD matching
  compose default when no root .env exists (compose interpolates change-me).
- Migrations verified against real Postgres: `manage.py migrate --plan` → no
  pending operations (container applies them at boot).
- settings.py postgres branch now declares explicit TEST database
  (POSTGRES_TEST_DB, default test_elearning) so pytest never touches the dev DB;
  documented transaction policy comment (ATOMIC_REQUESTS stays off — long LLM
  streams must not hold open transactions).
- New backend/tests/test_database.py (7 tests): postgres vendor assertion,
  isolated test-DB naming, transaction support, commit persistence, atomic
  rollback discards writes, savepoint rollback keeps outer writes, and a
  behavioral isolation probe — row written in test is invisible via a direct
  psycopg connection to the dev database.
- Gotcha: pytest-django mutates connection.settings_dict globally, so comparing
  NAME before/after setup reads identical values; isolation asserted via
  decouple-sourced dev name + cross-connection probe instead.
- Teardown verified: only `elearning` remains after pytest (test DB dropped);
  dev auth_user count unchanged (0).
- sqlite fallback intact for Docker-less local runs (DB_ENGINE=sqlite3):
  20 passed / 3 postgres-specific skips.
- .env.example documents POSTGRES_TEST_DB; README explains isolated test DB +
  sqlite fallback. All gates green via `POSTGRES_PASSWORD=... make quality`
  (ruff check/format, pytest 23 passed, manage.py check).

### TASK-008 — Configure environment management (COMPLETED 2026-08-26)
- settings.py now sources every documented category via python-decouple:
  REDIS_URL, JWT_ACCESS_TOKEN_MINUTES / JWT_REFRESH_TOKEN_DAYS,
  OPENROUTER_API_KEY / OPENROUTER_BASE_URL, LLM_PRIMARY_MODEL /
  LLM_FALLBACK_MODELS (Csv) / LLM_REQUEST_TIMEOUT_SECONDS.
- Production guard: `validate_production_configuration()` runs at import when
  DJANGO_DEBUG=False and raises ImproperlyConfigured naming ALL missing
  values (real SECRET_KEY — dev default rejected, non-empty ALLOWED_HOSTS,
  POSTGRES_PASSWORD, OPENROUTER_API_KEY). Pure function → directly unit-testable.
- .env.example updated: marks [REQUIRED IN PRODUCTION] variables, documents
  DB_ENGINE and CELERY_TASK_ALWAYS_EAGER (both already consumed by settings).
- Verified end-to-end: `DJANGO_DEBUG=False` with missing values → clear
  aggregated error naming all three missing vars; fully specified production
  env → `manage.py check` clean.
- New tests backend/tests/test_env_config.py (12): validation pass/per-category/
  aggregated/dev-secret-rejected + smoke checks for new settings.
- All gates green via `make quality`: ruff check, ruff format, pytest 16 passed,
  manage.py check clean. Secrets not tracked (only .env.example in git).

### TASK-007 — Configure mobile linting and testing (COMPLETED 2026-08-26)
- Strict mode already inherited from `@react-native/typescript-config`
  (`strict: true`, verified via `tsc --showConfig`); no tsconfig change needed.
- ESLint/Jest/typecheck scripts already present from RN CLI template and working.
- Added `@testing-library/react-native@14` (dev dep) and rewrote the template's
  react-test-renderer test as an RNTL component test (async render in v14).
- RNCSafeAreaProvider renders no children without native metrics → added
  `mobile/jest.setup.js` mocking `react-native-safe-area-context`; wired via
  `setupFiles` in `jest.config.js`.
- Enabled `env.jest` in `.eslintrc.js` so setup file passes `no-undef`.
- All gates green: `pnpm lint`, `pnpm typecheck`, `pnpm test` (1 passed).

### TASK-006 — Initialize React Native application (COMPLETED 2026-08-26)
- Scaffolded RN 0.81.4 bare app (CLI template) into `mobile/`; package name
  `elearning-mobile`, Android module `com.elearningmobile`, display name `eLearning`.
- New Architecture confirmed: `newArchEnabled=true`, Hermes on; runtime log shows
  `"fabric":true` when the JS bundle loads.
- pnpm compatibility via `mobile/.npmrc` (`node-linker=hoisted`); added `typecheck` script.
- Verified: `pnpm install` OK; `pnpm typecheck` (tsc --noEmit) clean;
  `./gradlew assembleDebug` BUILD SUCCESSFUL (arm64-v8a+x86_64).
- Runtime verification: no physical device available → provisioned cmdline-tools +
  system-images;android-35;google_apis;x86_64, created AVD `elearning`, booted headless
  emulator (KVM ACL granted), installed debug APK, launched MainActivity.
  App rendered ("Welcome to React Native", Hermes 0.81.4); topResumedActivity confirmed.
- Tooling note: system Java was missing and no passwordless sudo → installed portable
  Temurin JDK 21 at `~/.jdks/jdk-21.0.12.1+1` (outside repo). RN CLI's pnpm detection is
  broken in this env; scaffolded with default npm flag + `--skip-install`, then used pnpm.
- READMEs updated (root Mobile section: run instructions; mobile/README.md rewritten).
- `.gitignore` verified: node_modules, local.properties, android build outputs excluded.

### TASK-005 — Configure backend quality gates (COMPLETED 2026-08-26)
- All 5 gates already functional from TASK-002 scaffolding: ruff lint (E,F,W,I,N,UP,B,DJ,
  line-length 100), ruff format (44 files clean), pytest+pytest-django (4 passed),
  `manage.py check` (0 issues).
- Added root `Makefile` with CI-oriented aggregate target `make quality`
  chaining backend-lint / backend-format-check / backend-test / backend-check.
- README "Backend" section now documents every gate plus `make quality`.
- Verified clean-checkout flow: `uv sync` → all 4 gates green via `make quality`.

### TASK-004 — Create Django application boundaries (COMPLETED 2026-08-26)
- Scaffolded 5 apps via `manage.py startapp`: `accounts`, `learning`,
  `conversations`, `vocabulary`, `llm` under `backend/`.
- Each `apps.py` carries a docstring stating its responsibility
  (identity/auth, learning profile, sessions/messages, vocabulary+enrichment,
  LLM provider abstraction) plus `verbose_name`; standard BigAutoField PK.
- All 5 registered in `INSTALLED_APPS`.
- startapp's unused-import placeholders cleaned via `ruff --fix` + format.
- Verified: `manage.py check` clean, pytest 4 passed, ruff check + format clean.

### TASK-003 — Configure Docker Compose backend infrastructure (COMPLETED 2026-08-26)
- Added `celery[redis]>=5.4` dep; created `backend/config/celery.py` wired via
  `config/__init__.py`; Celery settings (`CELERY_BROKER_URL`,
  `CELERY_RESULT_BACKEND`, `CELERY_TASK_ALWAYS_EAGER`) added to settings.py.
- Created `docker/backend/Dockerfile` (uv base image, python3.14-slim,
  venv at `/opt/venv` so dev bind-mount can't shadow it) + `backend/.dockerignore`.
- Root `docker-compose.yml`: `postgres` (pg_isready HC), `redis` (redis-cli ping HC),
  `backend` (migrate+runserver, HTTP HC on /admin/login/), `worker` (celery worker).
  Env via root `.env` (env_file, required:false) + `${VAR:-default}` interpolation;
  intra-network hostnames injected as service env overrides. Named volumes for data.
- Verified clean-slate: all 4 services up, 3 healthy; migrations applied against
  Postgres; HTTP 200; `celery inspect ping` → pong.
- Gotchas hit & fixed: POSTGRES_HOST must match compose service name (`postgres`,
  not `db`); credentials must be interpolated into backend/worker env too.
- pytest 4 passed; ruff check + format clean.

### TASK-001 — Initialize repository structure (COMPLETED 2026-08-26)
- All sub-steps completed: folder structure, .gitignore/.env.example, README.md.
- Also added `backend/pyproject.toml` (uv/Ruff/pytest config) and `mobile/package.json`
  stubs to satisfy "independent package/tooling configuration".
- Note: `opencode.json` contains a local provider API key; added it to `.gitignore`
  so no generated secrets are committed.

### TASK-002 — Initialize Django project (COMPLETED 2026-08-26)
- Deps added via `backend/pyproject.toml`: django 6.1, djangorestframework 3.18,
  psycopg[binary] 3.3, python-decouple 3.8 (dev: pytest 9, pytest-django 4.14, ruff).
- Created `backend/config/{settings,urls,wsgi,asgi}.py` + `manage.py`.
- Settings read `DJANGO_*` / `POSTGRES_*` env vars via decouple (matches `.env.example`);
  PostgreSQL is default engine, `DB_ENGINE=sqlite3` enables pre-Docker local dev.
- Smoke tests in `backend/tests/test_smoke.py` (4 passing, DB-free).
- Verified: `manage.py check` clean, pytest 4 passed, ruff clean,
  runserver serves admin login (200) under sqlite override.
- Note: Postgres-backed runserver boot requires TASK-003 Docker services.

## Execution Logs & Recovery Notes
- Mobile emulator flow: start Metro with `CI=true pnpm exec react-native start`
  (interactive mode crashes headless) and `adb reverse tcp:8081 tcp:8081`;
  debug APK needs Metro. AVD `elearning` boots headless in ~2 min.
- Headless UI driving works well: RN testIDs appear as uiautomator
  resource-id; dump via `adb shell uiautomator dump /sdcard/ui.xml` + pull,
  then `adb shell input tap` on bounds centers.
- No open issues. Next task: TASK-030 — Create session API (Phase 5):
  POST /api/v1/sessions/ with optional topic hint → create session, generate
  topic, generate sample conversation (topics.generate/generate_sample),
  return session info; authenticated only; failures must not leave corrupt
  sessions; tests exist.
- Running `make quality` against Postgres from the host requires
  `POSTGRES_PASSWORD=change-me` (or a root .env) since compose owns credentials.
  Compose services up and healthy; backend restarted with token_blacklist
  migrations applied.
- Note: `make quality` output can render oddly in this shell (truncated);
  run gates individually if in doubt. README's compose path is the repo-root
  `docker-compose.yml` (not docker/docker-compose.yml).
- Local-only artifacts (not committed, not required by repo): `~/.jdks/jdk-21.0.12.1+1`,
  `~/Android/Sdk/cmdline-tools/latest`, system image android-35 google_apis x86_64,
  AVD `elearning`.
