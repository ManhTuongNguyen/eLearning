# Architecture

This document describes how the English Learning Chat system is built: the two
product modes (server and serverless), the LLM provider abstraction, streaming,
conversation memory, background processing with Celery, and the vocabulary
enrichment flow.

For setup and running the project, see the [README](../README.md). For the
product goals and constraints, see [ROADMAP.md](../ROADMAP.md).

---

## 1. High-level overview

The product has two completely isolated modes. They share no database and no
synchronization path.

```text
Server mode (default, authenticated):

  React Native app
        |  HTTPS (JWT bearer)
        v
  Django REST API  ──  PostgreSQL
        |             Redis (broker DB 1 / result DB 2)
        v             Celery worker
  OpenRouter (server-side key)

Serverless mode (local only):

  React Native app
        ├── Local SQLite (react-native-sqlite-storage)
        └── OpenRouter directly (user-supplied key)
```

Isolation rules:

- Switching modes never merges or migrates data.
- While serverless is active, server history is hidden; restoring server mode
  makes it available again.
- The serverless OpenRouter key never reaches the backend; the server key is
  never sent to the mobile app.
- Serverless local data is removed only by an explicit "Clear local data"
  action in Settings.

### Mode enforcement in the mobile app

The active mode (`'server' | 'serverless'`) is stored in AsyncStorage
(`mobile/src/mode/`) and exposed through `ModeProvider` / `useApplicationMode()`.
Transport code cannot be bypassed: `assertServerApiAllowed()` in
`mobile/src/api/client.ts` (REST) and `mobile/src/api/chatStream.ts` (SSE)
throws `ServerApiBlockedError` before any connection opens when the runtime
mode is `serverless`. Serverless-local data therefore cannot leak into server
API calls.

---

## 2. Backend architecture (Django)

### 2.1 Apps and responsibilities

| App | Responsibility |
| --- | --- |
| `config` | Settings (`config/settings.py`), root URLs, health endpoint, Celery app (`config/celery.py`) |
| `api` | Shared API error format: `APIErrorCode`, `api_exception_handler`, LLM error mapping |
| `accounts` | Custom user model, registration, JWT login/refresh/logout, `me` endpoint, auth throttling |
| `learning` | Per-user CEFR learning level (`Profile.level`: A1–C2 or `AUTO`) |
| `conversations` | Sessions, messages, chat write path, topic generation, context assembly, rolling summaries, suggestions, improvement |
| `vocabulary` | Saved expressions, async enrichment, Anki CSV export |
| `llm` | Provider abstraction, OpenRouter client, model fallback, streaming normalization, SSE plumbing (no DB models) |

Layering conventions (enforced by review and tests):

- Django views never call OpenRouter; they use application services.
- Serializers only validate/shape data; business logic lives in service modules.
- Every LLM-consuming service receives an `LLMProvider` via constructor
  injection; production wiring uses cached `FallbackProvider.from_settings()`
  per process (`@lru_cache` getters double as test seams).

### 2.2 Configuration

A single `config/settings.py` driven by `python-decouple`; there is no
base/dev/prod split. When `DEBUG=False`, `validate_production_configuration()`
fails startup unless `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`,
`POSTGRES_PASSWORD` and `OPENROUTER_API_KEY` are set. All variables are
documented in the root `.env.example`. Key LLM/memory settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` | `""` / `https://openrouter.ai/api/v1` | Server-side provider credentials |
| `LLM_PRIMARY_MODEL` | `openai/gpt-4o-mini` | First model tried |
| `LLM_FALLBACK_MODELS` | `openai/gpt-4o,anthropic/claude-3.5-haiku` | Ordered fallbacks |
| `LLM_REQUEST_TIMEOUT_SECONDS` / `_CONNECT_` / `_READ_` | 60 / 10 / 60 | HTTP timeouts |
| `CONTEXT_RECENT_MESSAGE_WINDOW` | 20 | Recent-message window sent to the LLM |
| `CONTEXT_SUMMARY_TRIGGER_THRESHOLD` | 40 | Messages past the window before summarization fires |
| `JWT_ACCESS_TOKEN_MINUTES` / `JWT_REFRESH_TOKEN_DAYS` | 15 / 7 | Token lifetimes |
| `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | Redis DB 1 / DB 2 | Celery transport |
| `AUTH_THROTTLE_RATE` | `10/min` | Anonymous auth-endpoint throttle |

`ATOMIC_REQUESTS` is deliberately off so LLM streaming responses do not hold a
database transaction open for the duration of a stream.

### 2.3 Data model

- `accounts.User` — `AbstractUser` with unique `email`; login accepts
  username or email.
- `learning.Profile` — one-to-one with the user; `level` choices
  `A1..C2, AUTO` (default `AUTO`).
- `conversations.Session` — user-owned; `title`, `topic`, `topic_hint`,
  `learning_level`, plus the rolling-memory fields `summary` and
  `summary_message_boundary` (last message sequence covered by the summary).
- `conversations.Message` — belongs to a session; `role` (`user`/`assistant`),
  `status` (`pending`/`complete`/`failed`), `content`, `sequence`
  (unique per session). User rows must be `complete`; assistant rows start
  `pending` and settle to `complete` or `failed`. Performance indexes exist on
  `(session, status, sequence)` and `(user, -updated_at)`.
- `vocabulary.VocabularyItem` — user-owned; `expression` plus
  `normalized_expression` (dedupe key), enrichment fields
  (`definition`, `translation`, `pronunciation`, `part_of_speech`, `example`),
  optional `source_message`/`source_session`, and `status`
  (`pending`/`complete`/`failed`).

Ownership is enforced everywhere by user-scoped querysets with 404-collapsing
lookups — a foreign object is indistinguishable from a missing one.

### 2.4 API surface

All endpoints live under `/api/v1/` and are JWT-protected unless noted:

```text
GET  /api/v1/health/                                  (public; probes the database)
POST /api/v1/auth/register/ | login/ | refresh/ | logout/   (public + throttled)
GET  /api/v1/auth/me/
GET,PATCH /api/v1/profile/
GET,POST /api/v1/sessions/                            POST generates topic + sample conversation
GET,PATCH,DELETE /api/v1/sessions/{id}/               PATCH renames
GET  /api/v1/sessions/{id}/messages/
POST /api/v1/sessions/{id}/messages/stream/           SSE chat turn
POST /api/v1/sessions/{id}/messages/{mid}/retry/      SSE retry of a failed generation
POST /api/v1/sessions/{id}/messages/{mid}/suggestions/  three suggested replies
POST /api/v1/sessions/{id}/messages/{mid}/improve/    improve-my-English
GET,POST /api/v1/vocabulary/                          list / immediate save
GET  /api/v1/vocabulary/export/                       Anki CSV download (anki-vocabulary.csv)
POST /api/v1/llm/stream/                              generic SSE completion (no persistence)
```

Errors use the shared format from `api/errors.py`: a machine-readable `code`
(`VALIDATION_ERROR`, `AUTHENTICATION_FAILED`, `NOT_FOUND`, `CONFLICT`,
`LLM_TIMEOUT`, `LLM_UNAVAILABLE`, `LLM_AUTH_FAILED`, `RATE_LIMITED`, …).
Retryable LLM failures map to 503, permanent ones to 502.

---

## 3. LLM provider abstraction

All OpenRouter interaction is funneled through the `llm` app. Nothing outside
it knows OpenRouter's HTTP details.

```text
LLMProvider (ABC, llm/provider.py)
    ├── OpenRouterProvider   (llm/openrouter.py, httpx)
    └── FallbackProvider     (llm/fallback.py, ordered model chain)
```

- **Interface**: `complete(request) -> CompletionResponse` and
  `stream(request) -> Iterator[StreamEvent]`. The first stream event is always
  `StreamStart`; generator exhaustion means success; failures raise `LLMError`
  subclasses.
- **Normalized types** (`llm/types.py`): `Message`, `CompletionRequest`,
  `CompletionResponse`, stream events `StreamStart | StreamDelta` and terminal
  `StreamCompleted | StreamFailed`, `ModelInfo` for the model catalog.
- **Error normalization** (`llm/exceptions.py`): `LLMRequestError`,
  `LLMTimeoutError`, `LLMAuthenticationError`, `LLMBadRequestError`,
  `LLMAvailabilityError`, `LLMResponseError` — each carries a `retryable` flag.
  HTTP statuses map to classes (401/403 → auth; 400/404/413/422 → bad request;
  408 → timeout; 429/5xx → availability). Error snippets are capped and secrets
  are never logged.
- **Fallback**: `FallbackProvider` walks `primary → fallbacks…`; only
  retryable failures advance to the next model, exhaustion raises a single
  aggregated `LLMAvailabilityError`. A per-request model pin bypasses the
  chain. In streaming, fallback probing happens only before the first emitted
  event; once a stream has delivered text, a mid-stream failure is terminal
  (partial text is never duplicated by switching models).
- **Streaming service** (`llm/streaming.py`): `StreamingCompletionService`
  guarantees exactly one `StreamStart`, zero or more `StreamDelta`, and exactly
  one terminal event; contract violations from the provider become
  `StreamFailed` (`LLMResponseError`).
- **Model discovery**: `OpenRouterProvider.list_models()` normalizes the
  `/models` catalog into `ModelInfo` entries (malformed entries skipped). The
  server exposes no `/models` HTTP endpoint; server-side models are configured
  purely through the environment.

---

## 4. Streaming

### 4.1 SSE transport

`llm/sse.py` encodes events as `event: <name>\ndata: <json>\n\n` frames and
wraps them in a `StreamingHttpResponse` with `Cache-Control: no-cache` and
`X-Accel-Buffering: no`. Frame names map 1:1 to the normalized events:

```text
event: start       data: {"model": "..."}
event: delta       data: {"text": "..."}
event: completed   data: {"text": "...", "model": "...", "delta_count": N}
event: error       data: {"error": "...", "retryable": true|false}
```

Every stream ends with exactly one terminal frame (`completed` or `error`).

### 4.2 Chat turn lifecycle

`POST /api/v1/sessions/{id}/messages/stream/`
(`MessageStreamView` → `conversations/chat.py`):

1. Inside one transaction (session locked with `select_for_update`):
   append the user message (`complete`), append an assistant row (`pending`),
   build the `CompletionRequest` via `ContextBuilder`.
2. After commit: enqueue the asynchronous summary update via
   `transaction.on_commit(...)`.
3. Stream the LLM response through `finalize_turn`, which persists the
   **final** assistant content and flips the row to `complete` *before*
   yielding the `completed` frame (a client that saw `completed` can trust the
   database write). On `StreamFailed` the row is marked `failed`; partial
   output is never persisted as complete. Abandoned streams simply leave the
   row `pending`.

Streaming chunks are transient — only the canonical final message is stored.

### 4.3 Retry

`POST .../messages/{message_pk}/retry/` (`RetryService.prepare_retry`) re-arms
the same failed assistant row in place (same primary key and sequence, reset to
`pending`, content blanked) under row locks, rebuilds the original turn request
from the prior user message, and streams again. Only `failed` assistant rows
are retryable (409 otherwise); the user message is never duplicated.

### 4.4 Mobile SSE client

`mobile/src/api/chatStream.ts` consumes the SSE stream over `XMLHttpRequest`
(RN `fetch` buffers response bodies) with an `onprogress` cursor, splitting
frames on blank lines; typed events (`start`/`delta`/`completed`/`error`) are
dispatched to the chat screen. `mobile/src/screens/streamingUx.ts` provides
`DeltaBuffer`, which coalesces token bursts into at most one render per 50 ms
tick, keeping streaming smooth without excessive re-renders.

---

## 5. Conversation memory

Long conversations never send the full history to the LLM. The effective
context is:

```text
system instructions + learning profile + topic
+ rolling summary + recent messages (window) + current user message
```

- **Context builder** (`conversations/context.py`): pure and deterministic;
  assembles the system prompt (tutor persona, CEFR level line, topic title and
  scenario, and — only if non-blank — the summary header block), then history
  turns, then the current message.
- **Recent window** (`conversations/window.py`): the last
  `CONTEXT_RECENT_MESSAGE_WINDOW` (default 20) `complete` messages after the
  summary boundary; the SQL query itself is bounded and ordered
  (`sequence` desc, sliced, re-sorted chronologically).
- **Summarizer** (`conversations/summarizer.py`): consumes exactly the
  increment — previous summary plus the turns that just left the window — and
  produces the new summary. It never re-reads the whole conversation.
- **Trigger** (`conversations/trigger.py`): when the number of messages beyond
  the window and past the persisted boundary reaches
  `CONTEXT_SUMMARY_TRIGGER_THRESHOLD` (default 40), the inclusive range
  `(boundary+1, total-window)` is archived. `SessionSummaryTrigger.update()`
  re-reads the session under a row lock, summarizes only `complete` turns, and
  persists `summary` + `summary_message_boundary` atomically — so duplicate
  task deliveries are no-ops and a provider failure rolls both fields back.
- **Asynchronous maintenance** (`conversations/tasks.py`): the chat request
  never waits for summarization; a Celery task
  (`conversations.update_session_summary`) performs it after the transaction
  commits. Conversation remains fully usable if summarization fails.

The mobile serverless mode mirrors this design exactly
(`mobile/src/serverless/contextConfig.ts`: window 20, threshold 40, plus the
same context builder, window selector, trigger math and summarizer), persisting
summaries in the local `summaries` table.

---

## 6. Celery

- App: `config/celery.py` (`Celery("elearning")`, autodiscovery, namespace
  `CELERY`). Broker and result backend are Redis DB 1 and DB 2 respectively.
- Tasks:
  - `conversations.update_session_summary` — rolling summary maintenance.
  - `vocabulary.enrich_vocabulary_item` — vocabulary enrichment.
- Both tasks share the same policy: `acks_late=True`, `max_retries=5`,
  exponential backoff starting at 5 s capped at 600 s with jitter. Retryable
  LLM failures retry; permanent failures are logged and swallowed (the next
  threshold crossing or user action naturally retries). Enrichment exhausts
  its budget by marking the item `failed`; summarization leaves the boundary
  untouched so the same range is retried later.
- **Enqueue discipline**: background work is always enqueued from
  `transaction.on_commit(...)` — never from `post_save` signals — so a rolled
  back transaction never spawns a task against phantom rows. Enqueue points:
  `conversations/chat.py` (turn creation and retry) and
  `vocabulary/views.py` (vocabulary save).
- There is no Celery Beat schedule; all work is commit-triggered.

---

## 7. Vocabulary enrichment flow

```text
select text (mobile)
    → POST /api/v1/vocabulary/          (save is immediate, synchronous)
    → transaction commits               (item created in status "pending")
    → on_commit → Celery task
    → LLM enrichment (definition, translation, pronunciation,
      part_of_speech, example)          (status → "complete", or "failed")
    → GET /api/v1/vocabulary/           (list reflects enrichment status)
    → GET /api/v1/vocabulary/export/    (Anki CSV)
```

- Saving never waits for enrichment; the API returns `201` (or `200` for an
  exact duplicate — same user + normalized expression — which is left
  unchanged and never re-enriched).
- The enrichment level is resolved from the source session, falling back to the
  user's profile, then `AUTO`. The service demands structured JSON output;
  malformed responses raise a normalized error.
- Export (`vocabulary/csv_export.py`) builds RFC 4180 CSV with columns
  `Front, Back, Example, Pronunciation` (expression, definition, example,
  pronunciation); pending/failed items export with empty enrichment fields.
- Vocabulary features are server-mode only; the serverless mode intentionally
  does not provide them.

---

## 8. Mobile architecture (React Native)

React Native 0.81 (New Architecture, Hermes), TypeScript strict mode, pnpm.
State management is plain React Context — no external store library.

### 8.1 Navigation

`App.tsx` nests `SafeAreaProvider → ModeProvider → ThemeProvider → AuthProvider`.
`RootNavigator` swaps whole stacks based on auth state:

```text
loading      → SplashScreen
unauthenticated → AuthNavigator   (Login, Register)
authenticated   → MainNavigator   (Chat, NewConversation, History,
                                   Settings, Level, Vocabulary, OpenRouterSettings)
```

Navigation params are fully typed (`src/navigation/types.ts`), including the
`sampleTurns` route param that carries the generated sample conversation from
session creation into the chat screen.

### 8.2 Server mode data flow

- **API client** (`src/api/client.ts`): typed request helper producing a
  normalized `ApiError` with categories
  `network | authentication | validation | server | llm | timeout`.
- **Auth state** (`src/auth/AuthContext.tsx`): startup token restore, single
  flight token refresh (concurrent 401s trigger exactly one refresh), automatic
  one-retry of failed authenticated requests.
- **Secure storage**: JWT tokens in the device keychain via
  `react-native-keychain` (`src/auth/secureStorage.ts`, service
  `com.elearningmobile.auth`) — never AsyncStorage.

### 8.3 Chat experience

`ChatScreen` (`src/screens/ChatScreen.tsx`) owns the turn pipeline: optimistic
user echo plus a pending assistant bubble (synthetic negative ids), streamed
deltas buffered by `DeltaBuffer`, authoritative replacement from the
`completed` event, then a silent message re-sync. Topic header is collapsible;
the sample conversation renders in a modal with per-turn TTS. Long-press opens
`MessageActionsMenu` (suggest replies, improve English — user messages only —
copy, speak, select text). Text selection uses an editable `TextInput` mirror
(`TextSelectionSheet`) and flows into `VocabularySaveSheet`, which saves
immediately and shows a toast; enrichment status appears in the vocabulary
screen later. The list is windowed and `MessageRow` is memoized
(`streamingUx.ts` tuning constants) for large histories.

### 8.4 Local SQLite database (serverless)

- Library: `react-native-sqlite-storage` behind a driver seam
  (`src/db/driver.ts`, `nativeDriver.ts`, `elearning-serverless.db`), foreign
  keys on, transactions via `BEGIN IMMEDIATE`.
- Schema is versioned with append-only migrations applied atomically and
  tracked in `PRAGMA user_version` (`src/db/migrations.ts`): `learning_profile`
  (single row), `settings` (key/value), `sessions`, `messages`
  (unique `(session_id, sequence)`, cascading delete), `summaries`
  (one per session with `message_boundary`).
- Typed entity stores (`sessionStore`, `messageStore`, `summaryStore`,
  `profileStore`, `settingsStore`) are wrapped by
  `LocalConversationRepository` (`src/db/conversationRepository.ts`); feature
  code never writes SQL.
- `clearServerlessLocalData()` (`src/db/clearLocalData.ts`) wipes serverless
  tables in one transaction and clears the stored OpenRouter key — it never
  touches auth tokens, the theme preference, or the mode flag.

### 8.5 Serverless OpenRouter client

`src/serverless/` mirrors the backend's LLM architecture on-device:

- `openrouterClient.ts` — direct OpenRouter calls with the user's key,
  ordered primary/fallback model chain, XHR-based SSE streaming with the same
  fallback-before-first-event rule, and model discovery.
- `errors.ts` — error hierarchy mirroring `llm/exceptions.py` (retryable vs
  permanent).
- `secureApiKey.ts` — the API key lives in the keychain under a dedicated
  service (`com.elearningmobile.serverless`), separate from auth tokens; it is
  never written to SQLite, AsyncStorage, or logs. Non-secret configuration
  (primary/fallback models) and the cached model catalog live in the local
  `settings` table (`settings.ts`, `modelCatalog.ts`; the catalog is refreshed
  only on success so a failed refresh never destroys the cache).
- Local feature services mirror the backend: `topicGeneration.ts`,
  `contextBuilder.ts` / `conversationContext.ts` (identical context shape and
  thresholds), `summarizer.ts` + `summaryTrigger.ts` (same trigger math),
  `suggestions.ts` (exactly three replies), `improvement.ts`.
- `chatStreaming.ts` implements the local turn pipeline
  (`streamServerlessTurn` / `retryServerlessTurn`): user message + `pending`
  assistant slot persisted in one transaction, terminal state persisted before
  delivering the `completed` event, failed rows retryable in place.

**Wiring status**: the serverless turn pipeline, topic generation and summary
maintenance are implemented and unit-tested at the service layer, but the
chat/new-conversation screens do not yet invoke them — in serverless mode the
UI currently wires History, learning level, suggested replies, improvement,
model/settings management and data clearing directly, while turn streaming
still targets the (blocked) server endpoint. Completing this wiring is tracked
by the Phase 20 validation tasks in `SPEC.md`.

### 8.6 Text-to-speech

`src/tts/textToSpeech.ts` defines the `TextToSpeechEngine` interface and a
module registry; the UI never imports native modules directly. The Android
implementation (`src/tts/androidSpeech.ts`) adapts the Kotlin native module
`SpeechModule.kt` (`com.elearningmobile.Speech`), which handles engine state,
English voice-data availability (`E_TTS_LANGUAGE_UNAVAILABLE`) and single
pending-promise playback. `useSpeechPlayback` enforces one active playback and
silences on unmount/session switch.

---

## 9. Testing strategy

- **Backend** (`backend/tests/`, pytest + pytest-django): unit tests for
  provider/fallback/streaming with scripted fake providers, service tests
  (context, window, summarizer, trigger, topics, suggestions, improvement),
  API/integration tests (auth, chat lifecycle, retry, ownership, vocabulary,
  CSV), Celery task tests with `transaction.on_commit` hooks drained manually,
  DB-performance assertions over SQL query counts, and secret-handling
  regression tests. External HTTP is always mocked; the test database
  (`test_elearning`) is isolated from the development database.
- **Mobile** (`mobile/__tests__/`, `mobile/src/serverless/__tests__/`): Jest +
  React Native Testing Library with a real-SQL in-memory `sql.js` driver for
  database tests, a scriptable `FakeOpenRouterClient` for LLM seams, and
  in-memory mocks for keychain/AsyncStorage/SQLite/share. Component,
  navigation, streaming-state, mode-isolation and serverless service tests all
  run without a device (`pnpm test`, `pnpm lint`, `pnpm typecheck`).
