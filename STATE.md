# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 5B chat write-side done (TASK-040 complete; next
  TASK-041, streaming chat endpoint)

## Current Active Task

(none — TASK-040 completed; next: TASK-041 — Implement POST
/api/v1/sessions/{id}/messages/stream/: auth + ownership, save user message,
build context, start LLM stream, SSE text chunks, persist final assistant
message onto the pending row, emit completion event; failed generation must
be retryable)

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
