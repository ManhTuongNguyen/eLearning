# Backend API Reference

The server-mode REST API for the English Learning Chat backend.

- **Base URL:** `/api/v1/`
- **Authentication:** JWT bearer tokens (`Authorization: Bearer <access>`). Every endpoint requires authentication unless explicitly listed as public.
- **Content type:** JSON (`application/json`), except streaming endpoints (Server-Sent Events) and the CSV export.
- **Pagination:** DRF `PageNumberPagination` with page size 20. Paginated responses use the standard envelope:

```json
{
  "count": 42,
  "next": "http://host/api/v1/sessions/?page=2",
  "previous": null,
  "results": []
}
```

This document covers the major endpoints and their request/response behavior. It intentionally does not duplicate every serializer validation rule; the source of truth is the code under `backend/` and the tests in `backend/tests/`.

---

## Error format

All error responses share one canonical structure (`backend/api/errors.py`):

```json
{
  "detail": "Human-readable message.",
  "code": "ERROR_CODE",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message.",
    "details": []
  }
}
```

The top-level `detail`/`code` pair preserves DRF's default contract; the nested `error` block is the canonical form new clients should parse. Validation errors additionally include top-level field keys (`{"field": ["message"]}`) for backward compatibility, and `error.details` carries structured per-field entries.

Common codes: `VALIDATION_ERROR` (400), `AUTHENTICATION_FAILED` (401), `PERMISSION_DENIED` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429, with `error.details.retry_after_seconds`), `LLM_*` codes (502, or 503 when the provider failure is retryable), `INTERNAL_ERROR` (500, internals never leaked).

Ownership is enforced everywhere: another user's resource — or a nonexistent id — is an indistinguishable `404 NOT_FOUND`.

---

## Health

### `GET /api/v1/health/` — public

Infrastructure health probe for load balancers and uptime checks.

```json
// 200 (all components healthy)
{
  "status": "ok",
  "components": { "database": "ok" },
  "time": "2026-08-28T12:00:00.000000+00:00"
}
```

`503` with `status: "unavailable"` when any component fails. The payload contains only component statuses — never credentials, hosts, or other environment details.

---

## Authentication

All auth endpoints share one anonymous rate-limit bucket (`auth` scope, default 10/min; returns `429 RATE_LIMITED` with a retry hint when exceeded).

### `POST /api/v1/auth/register/` — public

Create an account. Body: `{"username": str, "email": str, "password": str}`.

- Password runs through Django's configured `AUTH_PASSWORD_VALIDATORS` (including similarity checks against the submitted username/email).
- `201` → `{"id": int, "username": str, "email": str}` — the password is write-only and never returned.
- `400` → validation errors (taken username/email, rejected password, etc.).

### `POST /api/v1/auth/login/` — public

Exchange credentials for tokens. Body: `{"username": str, "password": str}` — the `username` field accepts either the username or the email address (email matching is case-insensitive).

```json
// 200
{
  "access": "<JWT>",
  "refresh": "<JWT>",
  "user": { "id": 1, "username": "ada", "email": "ada@example.com" }
}
```

`401 AUTHENTICATION_FAILED` for any invalid credential — failure modes are indistinguishable to the caller.

### `POST /api/v1/auth/refresh/` — public

Exchange a valid refresh token for a new access token. Body: `{"refresh": str}` → `200 {"access": "<JWT>"}`. Blacklisted, expired, or malformed refresh tokens → `401`.

### `POST /api/v1/auth/logout/` — authenticated

Invalidate a refresh token (blacklist). Body: `{"refresh": str}` → `200 {"detail": "Logged out."}`. Requires a valid access token. A malformed/expired/non-blacklist-eligible refresh token is a `400`. Blacklisting only kills the supplied refresh token; outstanding access tokens expire on their own configured lifetime.

### `GET /api/v1/auth/me/` — authenticated

Return the current user: `{"id": int, "username": str, "email": str}`.

---

## Learning profile

### `GET /api/v1/profile/` — authenticated

Read the caller's English level. The profile row is provisioned lazily on first access; the default level is `AUTO`.

```json
{ "level": "B1" }
```

Allowed levels: `A1`, `A2`, `B1`, `B2`, `C1`, `C2`, `AUTO`.

### `PATCH /api/v1/profile/` — authenticated

Update the level. Body: `{"level": "B2"}` → `200 {"level": "B2"}`. Anything outside the allowed set (including wrong-case or blank values) is a `400` validation error.

---

## Sessions

A session is one conversation. Its `title` is the topic's short display name, `topic` the full generated scenario description, and `learning_level` is a snapshot of the profile level taken at creation.

Session representation:

```json
{
  "id": 1,
  "title": "Ordering coffee in Lisbon",
  "topic": "Role-play ordering coffee at a busy café…",
  "topic_hint": "travel",
  "learning_level": "B1",
  "created_at": "2026-08-28T12:00:00Z"
}
```

### `GET /api/v1/sessions/` — authenticated

List the caller's sessions only, most recently updated first, paginated (page size 20).

### `POST /api/v1/sessions/` — authenticated

Start a new conversation. Body: `{"topic_hint"?: str}` — blank/omitted hint means "let AI choose".

Behavior:

1. Generate a topic from the profile level + hint (LLM).
2. Generate the sample conversation for that topic (LLM).
3. Persist the session.

All LLM work happens before the single session write, so provider failures never leave corrupt or half-filled sessions behind.

```json
// 201
{
  "id": 7,
  "title": "Ordering coffee in Lisbon",
  "topic": "Role-play ordering coffee at a busy café…",
  "topic_hint": "travel",
  "learning_level": "B1",
  "created_at": "2026-08-28T12:00:00Z",
  "sample_conversation": {
    "turns": [
      { "role": "assistant", "content": "Good morning! What can I get you?" },
      { "role": "user", "content": "Could I have a latte, please?" }
    ]
  }
}
```

`sample_conversation.turns` is pure display data for the "Show me an example" flow — it is never persisted as chat messages. Provider failure → `502`/`503` LLM error, no session created.

### `GET /api/v1/sessions/{id}/` — authenticated

Retrieve one session (representation above). Foreign/nonexistent sessions → `404`.

### `PATCH /api/v1/sessions/{id}/` — authenticated

Rename. Body: `{"title": str}` (required, non-blank after stripping) → `200` full session representation. Only `title` is mutable; any other keys in the payload are ignored.

### `DELETE /api/v1/sessions/{id}/` — authenticated

Delete the session; its messages are removed through the FK cascade. `204` with empty body.

---

## Messages

Message representation:

```json
{
  "id": 31,
  "role": "assistant",
  "status": "complete",
  "content": "Sure! Latte coming right up…",
  "sequence": 5,
  "created_at": "2026-08-28T12:01:30Z"
}
```

- `role`: `user` | `assistant`
- `status`: `pending` (generation in progress) | `complete` | `failed` (retryable)

### `GET /api/v1/sessions/{id}/messages/` — authenticated

List one session's messages in deterministic `sequence` order, paginated (page size 20). Ownership enforced via the session lookup → `404` for foreign/nonexistent sessions.

### `POST /api/v1/sessions/{id}/messages/stream/` — authenticated

One chat turn, streamed as Server-Sent Events. Body: `{"text": str}` (stripped, non-blank).

Server-side flow:

1. Persist the user message plus a pending assistant row atomically and build the turn's LLM context (system prompt, learning profile, topic, rolling summary, recent messages, current user message).
2. Stream the LLM completion; text chunks are forwarded incrementally.
3. Persist the outcome onto the pending assistant row **before** the terminal frame: `complete` on success, `failed` (retryable) on provider failure.

SSE wire format (all streaming endpoints):

```text
event: start
data: {"model": "vendor/model"}

event: delta
data: {"text": "Hello"}

event: completed
data: {"text": "Hello", "model": "vendor/model", "delta_count": 1}

event: error
data: {"error": "openrouter [model]: boom", "retryable": true}
```

Every stream ends with exactly one terminal frame: `completed` (success) or `error` (failure). Partial output from a failed stream is never persisted as a complete assistant message. Responses carry `Content-Type: text/event-stream`, `Cache-Control: no-cache` and `X-Accel-Buffering: no`.

Clients send `Accept: text/event-stream`; content negotiation accepts it on the streaming endpoints (and `Accept: text/csv` on the vocabulary export) while any other unmatched media type still returns `406`.

Errors: `400` for blank/missing `text`; `404` for foreign/nonexistent sessions; provider failures arrive as the terminal `error` event (the already-committed user message stays intact and the failed assistant row can be retried).

### `POST /api/v1/sessions/{id}/messages/{message_pk}/retry/` — authenticated

Retry a failed assistant generation. No body. Re-arms the `failed` assistant row in place (same id, back to `pending`, blank content) and re-streams the new attempt as SSE with the same frame format; the row ends `complete` or `failed` again.

- Only `failed` assistant rows are retryable — targeting a successful/pending/user message is `409 CONFLICT`.
- Retry never duplicates the user message.
- `404` for foreign/nonexistent sessions or messages.

### `POST /api/v1/sessions/{id}/messages/{message_pk}/suggestions/` — authenticated

Generate exactly three suggested replies for one selected message. No body. Read-only — nothing is persisted.

Inputs are persisted state only: the session's learning level + topic and every complete message before the selection (bounded by the recent-message window).

```json
// 200
{ "replies": ["…", "…", "…"] }
```

- Requires a `complete`, non-empty message → otherwise `409 CONFLICT`.
- Provider failure → `503` (retryable) or `502`.
- `404` for foreign/nonexistent sessions/messages.

### `POST /api/v1/sessions/{id}/messages/{message_pk}/improve/` — authenticated

Improve one user-authored message on explicit request. No body. Read-only — the stored message is never modified.

```json
// 200
{
  "original": "i go to store yesterday",
  "improved": "I went to the store yesterday.",
  "explanation": "Use past tense 'went' for a finished action…"
}
```

- Only `user` messages (non-empty) can be improved → assistant rows or blank content are `409 CONFLICT`.
- Provider failure → `503`/`502`; `404` for foreign/nonexistent sessions/messages.

---

## LLM streaming (generic)

### `POST /api/v1/llm/stream/` — authenticated

Stream a raw LLM completion as SSE. Body:

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful tutor." },
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7
}
```

- `role` must be `system`, `user`, or `assistant`; `content` must be non-blank; `temperature` is optional, bounded to `0.0–2.0`.
- Clients cannot pin a model or provider — the server-side configuration (`LLM_PROVIDER`, primary model + configured fallbacks) always decides which model serves the request.
- Response: same SSE frame format as chat streaming (`start`/`delta`/`completed`/`error`), one terminal frame.

---

## Vocabulary

Vocabulary item representation:

```json
{
  "id": 3,
  "expression": "to run out of",
  "normalized_expression": "to run out of",
  "definition": "…",
  "translation": "…",
  "pronunciation": "…",
  "part_of_speech": "phrasal verb",
  "example": "We ran out of milk.",
  "status": "complete",
  "source_message": 31,
  "source_session": 7,
  "created_at": "2026-08-28T12:02:00Z"
}
```

- `status`: `pending` (enrichment not yet done) | `complete` | `failed` (enrichment retryable)
- Enrichment fields (`definition`, `translation`, `pronunciation`, `part_of_speech`, `example`) are filled asynchronously by a Celery task; the save endpoint never waits for them.

### `GET /api/v1/vocabulary/` — authenticated

List the caller's saved expressions only, newest first, paginated (page size 20). Each row carries its enrichment `status` for the mobile list screen.

### `POST /api/v1/vocabulary/` — authenticated

Save an expression. Body: `{"expression": str, "source_message_id"?: int}`.

- Persisted synchronously with only the expression + source filled in (`pending` status); enrichment happens asynchronously, so the response returns as fast as one insert.
- `source_message_id` is optional; it is resolved through a user-scoped lookup — a foreign or nonexistent message is an indistinguishable `404` and nothing is written. Its session becomes `source_session`.
- Duplicate behavior is deterministic: identity is `(user, normalize(expression))` with normalization = trim + lowercase. Re-saving an expression returns `200` with the **existing** row unchanged (no reset to pending, no duplicate rows); a new expression returns `201`.
- Enrichment is scheduled inside the same atomic block via `transaction.on_commit` — a rolled-back transaction never enqueues a job; a committed one enqueues exactly one.
- `400` for blank `expression` or malformed `source_message_id`.

### `GET /api/v1/vocabulary/export/` — authenticated

Download the caller's vocabulary as an Anki-importable CSV.

- Content type: `text/csv`, served as an attachment (`Content-Disposition: attachment; filename="anki-vocabulary.csv"`).
- Columns: `Front`, `Back`, `Example`, `Pronunciation`; newest first; no pagination (exports are complete).
- Items with pending/failed enrichment are included as cards with empty `Back`/`Example`/`Pronunciation` cells.
- Proper CSV escaping (commas, quotes, newlines) with Unicode preserved.

---

## Conventions

- **Timestamps** are ISO-8601 UTC.
- **JWT lifetimes** come from `JWT_ACCESS_TOKEN_MINUTES` and `JWT_REFRESH_TOKEN_DAYS`; expired access tokens → `401 AUTHENTICATION_FAILED` with a `WWW-Authenticate: Bearer` header.
- **Secrets** (server provider keys, database credentials) are never present in any response.
- The mobile app's **serverless mode** does not use this API at all: it talks to the configured LLM provider directly and stores data in local SQLite (see [`ARCHITECTURE.md`](ARCHITECTURE.md)).