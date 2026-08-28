# English Learning Chat — Post-Completion Audit and Improvement Backlog

## 0. Purpose

This document is a **post-completion engineering backlog** for the English Learning Chat project.

This is the active backlog for post-MVP development.

IMPORTANT:
- The MVP described by ROADMAP.md and SPEC.md is already implemented.
- Do NOT read the entire SPEC.md before every task.
- Do NOT restart or re-audit the original MVP.
- This file is the authoritative task list for post-completion work.
- Read the existing source code before implementing each task.
- Read SPEC.md or ROADMAP.md only when a task explicitly requires clarification
  about an original product requirement or architecture.

---

# 1. Scope and Priorities

Tasks are grouped by priority:

- **P0 — Critical:** broken functionality or behavior that violates an explicit product requirement.
- **P1 — High:** important UX, reliability, configuration, or architectural problems.
- **P2 — Medium:** maintainability and quality improvements.

Priority does not override dependencies.

The agent must prefer the first incomplete dependency-safe task, not simply the highest-numbered task.

---

# 2. Global Rules

## Rule 1 — Preserve the two application modes

The application has two intentionally isolated modes:

```text
SERVER
    React Native
        ↓
    Django API
        ↓
    PostgreSQL / Redis / Celery
        ↓
    LLM provider

SERVERLESS
    React Native
        ↓
    Local SQLite
        ↓
    LLM provider directly
```

Serverless mode must never silently route conversation requests through the backend.

Server mode must continue to use the backend.

Mode switching must not merge or migrate conversation data.

---

## Rule 2 — Preserve provider abstraction

LLM integrations must not leak provider-specific HTTP details into screens, domain logic, or unrelated application services.

The project currently has OpenRouter support. The improved architecture must allow additional providers such as:

- Gemini
- OpenRouter
- 9router
- OpenAI
- OpenAI-compatible APIs
- Other compatible providers later

Provider-specific behavior belongs behind a strategy/provider interface.

---

## Rule 3 — Tests accompany implementation

Every bug fix must include a regression test where practical.

Every architectural change must include tests for the changed behavior.

Do not mark a task complete merely because the application appears to work manually.

---

## Rule 4 — Do not weaken type safety

Mobile:

- Strict TypeScript.
- Explicit types for API responses, navigation parameters, state, repositories, provider interfaces, and configuration.
- Avoid `any`.
- Use single quotes.
- No semicolons.

Backend:

- Full type annotations.
- Explicit return types.
- Docstrings for public functions/classes.
- PEP 8.
- Ruff-compatible code.

---

## Rule 5 — Do not expose secrets

Never:

- log access tokens
- log refresh tokens
- log OpenRouter API keys
- return server provider credentials to mobile
- send a serverless user's provider key to the backend
- store serverless provider keys in ordinary SQLite
- commit secrets

---

# 3. P0 — Critical Bugs

## TASK-AUDIT-001 — Fix 406 for chat SSE streaming

Status: `[x]`

Priority: `P0`

Problem:

The chat endpoint:

```text
POST /api/v1/sessions/{id}/messages/stream/
```

returns HTTP 406 when the mobile client requests:

```text
Accept: text/event-stream
```

The client requires SSE, but Django REST Framework content negotiation currently rejects the request before a valid SSE response can be produced.

The original specification explicitly requires SSE streaming and a correct content type.

### Requirements

Inspect the current DRF negotiation and streaming implementation.

Implement a proper solution that:

- accepts the client's SSE request
- returns:

```text
Content-Type: text/event-stream
```

- streams events incrementally
- preserves authentication and authorization
- preserves the existing SSE event format where possible
- does not replace SSE with polling
- does not introduce WebSockets
- does not disable content negotiation globally
- does not weaken authentication
- does not create a special bypass that accepts arbitrary invalid media types

Prefer a narrowly scoped renderer/content-negotiation/view solution appropriate for this endpoint.

### Acceptance criteria

- `Accept: text/event-stream` does not produce 406.
- The endpoint returns `text/event-stream`.
- Text chunks arrive incrementally.
- Completion events still work.
- Provider errors still terminate the stream cleanly.
- Existing authentication/ownership checks remain active.
- Existing SSE clients continue to work.
- Backend regression tests cover the exact 406 scenario.
- Relevant mobile streaming tests still pass.

---

## TASK-AUDIT-002 — Fix 406 for CSV export

Status: `[ ]`

Priority: `P0`

Problem:

The vocabulary CSV export endpoint currently returns HTTP 406.

Endpoint:

```text
GET /api/v1/vocabulary/export/
```

The endpoint must return downloadable CSV rather than being rejected by DRF content negotiation.

### Requirements

Inspect the actual request headers and response negotiation.

Implement a narrowly scoped solution for CSV export.

The endpoint must return an appropriate CSV media type, such as:

```text
text/csv
```

with a valid download filename.

Do not disable DRF content negotiation globally.

### Acceptance criteria

- CSV export no longer returns 406.
- Authenticated users can export their own vocabulary.
- The response has a CSV content type.
- The response has a sensible `Content-Disposition` filename.
- UTF-8 content is preserved.
- Commas, quotes, and newlines are escaped correctly.
- Existing authorization behavior remains unchanged.
- Regression tests cover the failing request.
- Mobile export/share flow continues to work.

---

## TASK-AUDIT-003 — Correct serverless mode entry and persistence

Status: `[ ]`

Priority: `P0`

Problem:

Serverless mode currently requires unnecessary navigation through login/account screens and presents server-account information even though serverless mode is independent of authentication.

Required behavior:

- A user can enable serverless mode directly from the login screen.
- Once serverless mode is enabled, the application must not route the user to login on subsequent app launches.
- This remains true after the application is closed and reopened.
- Serverless mode must not display account/server information.

### Requirements

Treat application mode as an early startup decision, before normal authenticated navigation.

Expected startup behavior:

```text
App launch
    ↓
Load persisted application mode
    ↓
SERVERLESS ─────────→ Serverless application
    |
SERVER ─────────────→ Restore authentication
                         |
                         +── authenticated → Main application
                         |
                         +── unauthenticated → Login
```

The serverless state must persist securely and independently of server authentication state.

### UI requirements

On the login screen:

- provide a clear way to enter serverless mode
- do not require an account
- explain that conversations remain on the device
- explain that AI requests go directly to the configured provider

When serverless mode is active:

- remove "Signed in as ..."
- remove username/email account information
- remove server-only account UI
- remove server logout/account controls
- do not show server history
- do not make authentication requests merely to initialize the serverless application

### Acceptance criteria

- Serverless mode can be entered directly from login.
- Closing and reopening the app keeps serverless mode active.
- Serverless startup never redirects to login.
- Serverless mode does not require a valid server JWT.
- Account information is absent in serverless mode.
- Server history is absent in serverless mode.
- Switching back to server mode restores the normal authentication flow.
- Tests cover cold-start behavior.

---

## TASK-AUDIT-004 — Fix OpenRouter model discovery without token validation

Status: `[ ]`

Priority: `P0`

Problem:

Users cannot select an OpenRouter model after entering their API token.

The OpenRouter models endpoint does not require the user's API token for the application's model discovery use case.

Model discovery must therefore not depend on token validation.

### Requirements

Separate:

```text
model discovery
```

from:

```text
authenticated provider request
```

Model discovery should call the OpenRouter models endpoint directly without first requiring a user API key.

The normalized model representation must support data such as:

```json
{
  "id": "tencent/hy4-preview",
  "canonical_slug": "tencent/hy4-preview-20260827",
  "name": "Tencent: Hy4 preview",
  "context_length": 1048576,
  "architecture": {
    "modality": "text->text",
    "input_modalities": ["text"],
    "output_modalities": ["text"],
    "tokenizer": "Other"
  },
  "pricing": {
    "prompt": "0.000000834",
    "completion": "0.000002501",
    "input_cache_read": "0.000000042"
  },
  "top_provider": {
    "context_length": 1048576,
    "max_completion_tokens": 64000
  },
  "supported_parameters": [
    "include_reasoning",
    "max_completion_tokens",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "stop",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools"
  ]
}
```

Do not assume every optional field is present.

### Acceptance criteria

- Model discovery succeeds without an API key.
- Entering an API key is not required before loading models.
- Invalid/expired user API keys do not prevent model discovery.
- Model data is normalized into a typed internal representation.
- Optional OpenRouter fields are handled safely.
- Model selection works after discovery.
- The user's API key is still required for actual serverless LLM requests.
- Tests cover discovery without a token.
- External OpenRouter HTTP calls are mocked in tests.

---

# 4. P1 — Authentication and Reliability

## TASK-AUDIT-005 — Implement one-time access-token refresh wrapper

Status: `[ ]`

Priority: `P1`

Problem:

Access tokens expire after approximately 15 minutes.

The API client currently needs a robust wrapper that:

1. executes the original HTTP request
2. detects an expired/unauthorized access token
3. refreshes the access token using the refresh token
4. retries the original request exactly once
5. returns the result of the retry

Expected flow:

```text
HTTP request
    ↓
401 / expired access token
    ↓
refresh token
    ↓
new access token
    ↓
retry original HTTP request once
    ↓
return result
```

### Requirements

Implement this in the central API/authentication layer rather than separately in each screen.

The original request must be retained sufficiently to retry it.

The retry must happen at most once.

If refresh fails:

```text
clear invalid authentication state
→ require login
```

Do not retry indefinitely.

### Concurrency requirement

If multiple requests receive an expired token at approximately the same time, avoid unnecessary refresh-token races.

Prefer a single shared refresh operation:

```text
request A ─┐
request B ─┼→ shared refresh → retry
request C ─┘
```

Do not start multiple refresh operations if one is already in progress.

### Acceptance criteria

- Expired access tokens are detected centrally.
- Refresh is attempted once.
- Original request is retried once after successful refresh.
- The original request's method, URL, headers, body, and relevant options are preserved.
- Refresh failure clears authentication state.
- No infinite retry loop is possible.
- Concurrent requests do not unnecessarily trigger multiple refresh requests.
- Tests cover:
  - normal request
  - 401 → refresh → retry success
  - 401 → refresh failure
  - retry returning 401 again
  - concurrent expired-token requests

---

# 5. P1 — Serverless UX and Navigation

## TASK-AUDIT-006 — Add back navigation to Settings

Status: `[ ]`

Priority: `P1`

Problem:

The Settings screen does not provide an expected navigator/back action.

### Acceptance criteria

- Settings has a clear back navigation affordance where appropriate.
- Back navigation follows the existing React Navigation structure.
- Android system back behavior remains correct.
- No duplicate navigation stack entries are introduced.
- Navigation tests are updated.

---

## TASK-AUDIT-007 — Simplify vocabulary save flow

Status: `[ ]`

Priority: `P1`

Problem:

After selecting text, the system popup includes:

```text
Cut
Copy
Share
Select all
...
Save word
```

After selecting `Save word`, the application opens another confirmation menu.

This second confirmation is redundant.

### Required behavior

```text
Select text
    ↓
System selection menu
    ↓
Save word
    ↓
Save immediately
    ↓
Success toast
```

Do not display a second confirmation step.

### Acceptance criteria

- Selecting `Save word` immediately starts the save operation.
- No second confirmation dialog/menu is displayed.
- Successful save shows a small success toast.
- Save remains asynchronous with respect to enrichment.
- Failure still produces useful feedback.
- Existing vocabulary behavior is preserved.
- Regression test covers the interaction.

---

## TASK-AUDIT-008 — Fix history state after successful login

Status: `[ ]`

Priority: `P1`

Problem:

After login succeeds, the application sometimes displays:

```text
No conversation yet
```

even though conversation history already exists.

This indicates a state initialization, cache, timing, or navigation synchronization problem.

### Requirements

Inspect:

- authentication state restoration
- history loading
- screen mounting
- repository/cache state
- navigation transitions
- query invalidation/refetch behavior

Do not solve this by adding an arbitrary fixed delay.

The history screen must derive its state from the authoritative repository/query state.

### Acceptance criteria

- Existing server conversations appear after login.
- Empty state appears only when the server actually has no conversations.
- Loading state is distinct from empty state.
- Login navigation does not race history initialization.
- Returning to History refreshes appropriately when required.
- Regression tests reproduce the original failure.

---

# 6. P1 — Chat Layout and Rendering

## TASK-AUDIT-009 — Improve chat message width and alignment

Status: `[ ]`

Priority: `P1`

Problem:

Chat messages currently use too little horizontal space.

Observed issues:

- Messages consume roughly 55% of screen width.
- User messages have excessive right margin.
- User messages should sit closer to the right edge.
- Short text such as `Hello` can wrap incorrectly:

```text
Hel
lo
```

even when enough horizontal space should exist.

### Requirements

Review:

- message container width
- max-width
- horizontal padding
- parent flex layout
- text measurement
- `flexShrink`
- alignment
- bubble padding
- list content container styles

Do not solve wrapping problems by disabling text wrapping globally.

Recommended behavior:

```text
Assistant:
[ wider message area ................. ]

                         [ user message .... ]
```

The exact percentage is not prescribed. Choose a natural mobile-chat width that provides substantially more usable space while preserving visual separation.

### Acceptance criteria

- User messages are aligned toward the right.
- Assistant messages remain aligned toward the left.
- Both message types can use substantially more than the current ~55% width.
- Short words/sentences do not wrap unexpectedly.
- Long messages still wrap normally.
- Very long words/URLs do not overflow the screen.
- Layout works on small and larger Android screens.
- Regression tests cover message container styles/rendering where practical.

---

# 7. P1 — Environment and Configuration

## TASK-AUDIT-010 — Remove hard-coded backend server configuration

Status: `[ ]`

Priority: `P1`

Problem:

The mobile application hard-codes the backend server in `config.ts`.

The backend URL must be environment/configuration driven.

### Requirements

Use the project's existing configuration mechanism if one exists.

Otherwise introduce the smallest appropriate React Native environment configuration mechanism.

At minimum support:

```text
development
test
production
```

The server URL must not be embedded in application source code.

Do not introduce a large configuration framework for a single URL.

### Acceptance criteria

- No production backend URL is hard-coded in `config.ts`.
- `.env`/environment configuration controls the backend base URL.
- `.env.example` documents required configuration.
- Test configuration can use a test API URL/mock.
- Existing development workflow remains straightforward.
- Configuration values are typed.
- No secrets are placed in source control.

---

# 8. P1 — Learning and OpenRouter Screen Layout

## TASK-AUDIT-011 — Fix excessive top margin on Learning Level screen

Status: `[ ]`

Priority: `P1`

Problem:

The Learning Level screen has an excessively large top margin/empty area.

### Acceptance criteria

- Remove unnecessary top whitespace.
- Preserve safe-area behavior.
- Maintain consistent spacing with the rest of the application.
- Ensure content remains reachable when the keyboard/system UI is present.
- Test the layout on representative Android screen sizes.

Do not use arbitrary negative margins as the primary fix.

---

## TASK-AUDIT-012 — Fix excessive top margin on OpenRouter setup screen

Status: `[ ]`

Priority: `P1`

Problem:

The OpenRouter setup screen has the same excessive top whitespace issue.

### Acceptance criteria

- Remove unnecessary top whitespace.
- Preserve safe-area behavior.
- Align the screen with the application's normal content spacing.
- Keep API key/model controls usable on small screens.
- Avoid arbitrary negative margins.

---

# 9. P1 — Multi-Provider LLM Architecture

## TASK-AUDIT-013 — Implement multi-provider strategy architecture

Status: `[ ]`

Priority: `P1`

Problem:

The application needs to support multiple AI providers in both modes.

Required providers include:

```text
Gemini
OpenRouter
9router
OpenAI
OpenAI-compatible providers
```

The exact provider list may grow.

Both server and serverless implementations must support the same conceptual provider architecture.

### Goal

The application should be able to select an LLM provider without coupling conversation features to provider-specific implementations.

Conceptually:

```text
LLMProvider
    |
    +── OpenRouterProvider
    +── GeminiProvider
    +── NineRouterProvider
    +── OpenAIProvider
    +── OpenAICompatibleProvider
```

For both environments:

```text
Server:
Application service
    ↓
Provider strategy
    ↓
External provider

Serverless:
Mobile application service
    ↓
Provider strategy
    ↓
External provider
```

### Provider interface

The abstraction should cover the capabilities actually required by the application, including:

- normal completion
- streaming completion
- model discovery where supported
- structured output where supported
- error normalization
- timeout handling
- provider-specific authentication
- model fallback compatibility

Do not force every provider to expose identical capabilities if the provider does not support them. Capabilities should be represented explicitly where necessary.

### Configuration

A provider configuration should conceptually contain:

```text
provider
base_url
api_key reference
primary model
fallback models
```

Do not store actual secrets in normal application state or logs.

### OpenAI-compatible providers

OpenAI-compatible providers should reuse a common implementation where their API contract is genuinely compatible.

Do not create separate duplicated clients for every OpenAI-compatible vendor.

### Serverless isolation

Serverless provider requests must go directly from mobile to the configured provider.

Server provider credentials must never be bundled into mobile.

### Acceptance criteria

- Provider interface exists in both server and serverless architecture where appropriate.
- Conversation code depends on the provider abstraction rather than OpenRouter-specific HTTP code.
- OpenRouter continues to work.
- At least one additional provider implementation is supported end-to-end as proof of the abstraction.
- OpenAI-compatible providers can reuse a common strategy when compatible.
- Provider errors are normalized.
- Streaming is supported through the abstraction.
- Tests mock provider implementations.
- Existing serverless OpenRouter behavior remains functional.
- No provider API keys are logged.
- The architecture does not duplicate conversation logic per provider.

---

# 10. P1 — Screen Maintainability and Shared State

## TASK-AUDIT-014 — Reduce oversized screen files

Status: `[ ]`

Priority: `P1`

Problem:

Some screen files contain too much UI, state, business logic, networking, persistence, and interaction handling.

This makes the code difficult to understand, test, and modify.

### Requirements

Do not perform a blind "split every file" refactor.

First identify responsibilities currently mixed inside large screens.

Move reusable/shared behavior into appropriate layers such as:

```text
screens/
components/
hooks/
state/
services/
repositories/
utils/
types/
```

Use the project's existing conventions where possible.

### Preferred separation

A screen should primarily coordinate:

```text
navigation
layout
presentation
user interaction wiring
```

Business operations should live in:

```text
services
repositories
hooks/state
```

Reusable visual pieces should live in:

```text
components
```

Shared types should not be duplicated across screens.

### State

When state is shared by multiple screens or represents application-level state, move it into the existing shared-state mechanism or introduce a small appropriate one.

Do not introduce a global state library solely to shorten one file.

### Acceptance criteria

- The largest problematic screens are reduced to understandable responsibilities.
- Networking logic is not duplicated across screens.
- Persistence logic is not embedded directly in complex UI components.
- Shared state has a clear owner.
- Components/hooks/services are individually testable where appropriate.
- No behavior regression occurs.
- The refactor does not create excessive abstraction layers.

---

# 11. P1 — Cross-Cutting Provider and Request Behavior

## TASK-AUDIT-015 — Unify HTTP request and authentication behavior

Status: `[ ]`

Priority: `P1`

Review the mobile networking architecture after implementing `TASK-AUDIT-005`.

The following concerns should have a single predictable owner:

```text
base URL
authentication headers
token refresh
request retry
error normalization
JSON handling
timeouts
```

Screens must not implement their own token refresh logic.

### Acceptance criteria

- Authentication behavior is centralized.
- API services use the same request wrapper.
- Error types are consistent.
- One-time token refresh behavior is reusable.
- Streaming requests use an explicitly appropriate path when they cannot use the normal JSON request wrapper.
- Tests cover normal and authenticated requests.

---

# 12. P2 — Additional Hardening

## TASK-AUDIT-016 — Audit all mode-dependent UI

Status: `[ ]`

Priority: `P2`

Audit every screen and navigation route for correct behavior in:

```text
SERVER
SERVERLESS
```

Build a mode capability matrix.

Example:

| Feature | Server | Serverless |
|---|---:|---:|
| Account | Yes | No |
| Server history | Yes | No |
| Local history | No | Yes |
| Server vocabulary | Yes | No |
| Vocabulary enrichment | Yes | No |
| CSV export | Yes | No |
| Direct provider request | No | Yes |
| Server authentication | Yes | No |

### Acceptance criteria

- No server-only UI appears in serverless mode.
- No serverless-only configuration is required in server mode.
- Navigation routes are mode-safe.
- API calls are mode-safe.
- Mode-dependent tests exist for critical routes.

---

## TASK-AUDIT-017 — Audit model discovery caching

Status: `[ ]`

Priority: `P2`

Review model discovery after `TASK-AUDIT-004`.

The application should not request the complete model catalog unnecessarily on every screen render.

### Acceptance criteria

- Model discovery results are cached appropriately.
- Explicit refresh is supported.
- Cached models remain available when temporarily offline.
- Loading, cached, empty, and error states are distinct.
- A screen re-render does not trigger unnecessary model requests.

---

## TASK-AUDIT-018 — Add regression coverage for audited bugs

Status: `[ ]`

Priority: `P2`

Create a focused regression suite covering all confirmed audit bugs.

At minimum:

### Backend

- SSE `Accept: text/event-stream` does not return 406.
- CSV export does not return 406.
- Provider model discovery works without token validation.
- Access token refresh works exactly once.
- Refresh failure logs the user out.
- User ownership remains enforced.

### Mobile

- Serverless mode can be entered from login.
- Serverless mode survives app restart.
- Serverless mode does not route to login.
- Account UI is absent in serverless mode.
- Existing history appears after login.
- Save word is immediate.
- Chat message widths/alignment are correct.
- Environment configuration is loaded correctly.
- Provider strategy selection works.

### Acceptance criteria

- Tests are deterministic.
- External APIs are mocked.
- Tests do not depend on real OpenRouter credentials.
- Existing tests continue to pass.

---

# 13. Final Audit Validation

## TASK-AUDIT-019 — Run complete post-completion validation

Status: `[ ]`

Priority: `P2`

After all previous tasks are complete, perform a full audit.

### Server mode journey

```text
Login
→ Restore authentication
→ History
→ Open existing conversation
→ Send message
→ SSE streaming
→ Token expiration
→ Refresh token
→ Continue original request
→ Save vocabulary
→ Export CSV
```

### Serverless journey

```text
Login screen
→ Enable serverless
→ Restart application
→ Remain serverless
→ Configure provider
→ Discover models without token validation
→ Select model
→ Start conversation
→ Stream response directly from provider
→ Open local history
→ Save vocabulary where supported
→ TTS
```

### Provider journey

Verify the provider abstraction does not require conversation screens to know whether the configured provider is:

```text
OpenRouter
Gemini
9router
OpenAI
OpenAI-compatible
```

### Quality checks

Run the actual project commands.

Backend, where applicable:

```text
uv run ruff check .
uv run ruff format --check .
uv run pytest
uv run python manage.py check
```

Mobile, where applicable:

```text
pnpm lint
pnpm test
pnpm typecheck
```

Use the repository's actual commands if they differ.

### Acceptance criteria

- All previous audit tasks are complete.
- Relevant tests pass.
- Existing tests pass.
- Type/lint/format checks pass.
- No known P0/P1 regression remains.
- No hard-coded production server configuration remains.
- No provider secret is exposed.
- Server and serverless data remain isolated.
- The project remains consistent with `ROADMAP.md` and `SPEC.md`.

---

# 14. Recommended Execution Order

The default execution order is:

```text
TASK-AUDIT-001  SSE 406
      ↓
TASK-AUDIT-002  CSV 406
      ↓
TASK-AUDIT-003  Serverless startup/navigation
      ↓
TASK-AUDIT-004  OpenRouter model discovery
      ↓
TASK-AUDIT-005  Token refresh wrapper
      ↓
TASK-AUDIT-006  Settings back navigation
      ↓
TASK-AUDIT-007  Immediate vocabulary save
      ↓
TASK-AUDIT-008  History state after login
      ↓
TASK-AUDIT-009  Chat layout
      ↓
TASK-AUDIT-010  Environment configuration
      ↓
TASK-AUDIT-011  Learning screen layout
      ↓
TASK-AUDIT-012  OpenRouter setup layout
      ↓
TASK-AUDIT-013  Multi-provider strategy
      ↓
TASK-AUDIT-014  Screen/state refactoring
      ↓
TASK-AUDIT-015  HTTP/auth unification
      ↓
TASK-AUDIT-016  Mode-dependent UI audit
      ↓
TASK-AUDIT-017  Model discovery caching
      ↓
TASK-AUDIT-018  Regression suite
      ↓
TASK-AUDIT-019  Final validation
```

Dependencies may allow parallel work, but the agent should not start a task if a preceding task changes the same architectural area and would make the work unnecessarily duplicative.

---

# 15. Definition of Done

An audit task is complete only when:

1. The implementation exists.
2. The original bug or requirement is demonstrably addressed.
3. Relevant regression tests exist.
4. Existing tests still pass.
5. Type/lint/format checks pass where applicable.
6. The implementation follows the existing architecture.
7. Server/serverless isolation is preserved.
8. Provider secrets remain protected.
9. No unrelated feature is introduced.
10. Documentation/configuration is updated when required.
11. Acceptance criteria are satisfied.
12. The task is marked `[x]`.
13. The agent can explain the change from repository evidence if asked.

Do not mark a task complete merely because the application builds.

---

# 16. Final Principle

This is a **post-MVP audit**, not a second MVP implementation.

Prefer:

```text
small regression fix
+
focused test
+
minimal architectural improvement
```

over:

```text
large rewrite
+
new dependency
+
unrelated refactor
```

Preserve working behavior.

Fix the observed problems first.

When a deeper architectural change is necessary, make the smallest change that creates a clean long-term boundary without rewriting unrelated working code.
