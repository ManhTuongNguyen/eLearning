# SPEC.md

# English Learning Chat — Executable Specification

## 0. Instructions for the Autonomous Coding Agent

This file is the executable backlog for the project.

Work through tasks in order unless a dependency explicitly permits parallel work.

For every incomplete task:

1. Read its description.
2. Inspect the existing repository before changing code.
3. Implement the smallest complete solution.
4. Add or update tests.
5. Run relevant tests and quality checks.
6. Fix failures.
7. Mark the task `[x]` only after its acceptance criteria are satisfied.
8. Do not mark future tasks as complete.
9. Do not implement unrelated features.

When a task contains a technical decision that is not fully specified, use the simplest production-appropriate implementation consistent with `ROADMAP.md`.

Do not ask the user for routine engineering decisions.

Prefer existing project conventions over introducing new abstractions.

Do not introduce a dependency unless it provides clear value.

---

# Phase 0 — Foundation

## TASK-001 — Initialize repository structure

Status: `[x]`

Create the top-level project structure.

Expected structure:

```text
backend/
mobile/
docker/
docs/
ROADMAP.md
SPEC.md
README.md
.gitignore
.env.example
```

Acceptance criteria:

- Backend and mobile have independent package/tooling configuration.
- Root documentation explains the project.
- No generated secrets are committed.
- Directory structure is suitable for Docker Compose.

---

## TASK-002 — Initialize Django project

Status: `[x]`

Create the Django 6.x backend using uv.

Requirements:

- Python managed by uv.
- Django 6.x.
- Django REST Framework.
- PostgreSQL support.
- Ruff configuration.
- pytest configuration.
- pytest-django.
- python-decouple.

Acceptance criteria:

- Django starts successfully.
- `uv run python manage.py check` passes.
- pytest can discover tests.
- Ruff can run successfully.

---

## TASK-003 — Configure Docker Compose backend infrastructure

Status: `[x]`

Create Docker Compose services for:

- backend
- postgres
- redis
- worker

Acceptance criteria:

- All services start successfully.
- PostgreSQL is reachable by Django.
- Redis is reachable by Django/Celery.
- Environment variables are not hard-coded.
- Health checks exist where practical.

---

## TASK-004 — Create Django application boundaries

Status: `[x]`

Create initial Django apps/modules for:

```text
accounts
learning
conversations
vocabulary
llm
```

Do not over-engineer.

Acceptance criteria:

- Apps are registered.
- Each app has a clear responsibility.
- Existing checks pass.

---

## TASK-005 — Configure backend quality gates

Status: `[x]`

Configure:

- Ruff linting
- Ruff formatting
- pytest
- pytest-django
- Django system checks

Acceptance criteria:

- Commands are documented in README.
- A clean checkout can run all quality checks.
- CI-oriented commands are available locally.

---

## TASK-006 — Initialize React Native application

Status: `[x]`

Create the React Native mobile application using TypeScript and pnpm.

Requirements:

- React Native New Architecture.
- Android support.
- pnpm.
- TypeScript.
- No Expo dependency unless a later requirement explicitly justifies it.

Acceptance criteria:

- `pnpm install` succeeds.
- Android development build succeeds.
- Application starts on an Android physical device.
- TypeScript compilation succeeds.

---

## TASK-007 — Configure mobile linting and testing

Status: `[x]`

Configure:

- TypeScript strict mode
- ESLint
- Jest
- React Native Testing Library

Acceptance criteria:

- Test command works.
- Type checking works.
- Linting works.
- A basic component test passes.

---

# Phase 1 — Backend Core

## TASK-008 — Configure environment management

Status: `[x]`

Create environment configuration using python-decouple.

Required configuration categories:

- Django secret key
- Debug
- Allowed hosts
- Database
- Redis
- Celery
- OpenRouter
- JWT
- LLM configuration

Acceptance criteria:

- `.env.example` documents required variables.
- Secrets are never committed.
- Missing required production values fail clearly.

---

## TASK-009 — Create database configuration

Status: `[x]`

Configure PostgreSQL as the primary Django database.

Acceptance criteria:

- Local Docker PostgreSQL works.
- Migrations work.
- Transaction behavior is correct.
- Tests use an isolated test database.

---

## TASK-010 — Add API health endpoint

Status: `[x]`

Implement:

```text
GET /api/v1/health/
```

Return service health information.

Acceptance criteria:

- Endpoint returns HTTP 200 when application infrastructure is healthy.
- Test exists.
- Endpoint does not expose secrets.

---

# Phase 2 — Authentication

## TASK-011 — Create user model

Status: `[x]`

Implement the application user model.

Requirements:

- Email or username authentication.
- Password authentication.
- Appropriate uniqueness constraints.
- Normal Django password hashing.

Acceptance criteria:

- User model is configured before dependent migrations.
- Passwords are never stored in plain text.
- Tests cover creation and uniqueness.

---

## TASK-012 — Implement registration API

Status: `[x]`

Implement user registration.

Acceptance criteria:

- Valid users can register.
- Invalid credentials/data are rejected.
- Password validation is enforced.
- Password is never returned by the API.
- API tests exist.

---

## TASK-013 — Implement JWT authentication

Status: `[x]`

Implement access/refresh token authentication.

Acceptance criteria:

- Login returns tokens.
- Protected endpoints reject unauthenticated requests.
- Access tokens expire.
- Refresh tokens can obtain a new access token.
- Tests cover valid and invalid authentication.

---

## TASK-014 — Implement logout

Status: `[x]`

Implement logout/token invalidation according to the selected JWT strategy.

Acceptance criteria:

- Logout endpoint exists.
- Appropriate token invalidation behavior is tested.
- Authentication documentation is updated.

---

## TASK-015 — Implement mobile authentication flow

Status: `[x]`

Create mobile authentication screens and API integration.

Screens:

```text
Login
Register
```

Acceptance criteria:

- User can register.
- User can log in.
- Tokens are stored securely.
- Authenticated state survives app restart.
- Logout works.

Do not store authentication tokens in plain AsyncStorage.

Use an appropriate secure-storage mechanism.

---

# Phase 3 — Learning Profile

## TASK-016 — Create learning profile model

Status: `[x]`

Create a profile associated with the user.

Initial fields:

```text
level
```

Allowed values:

```text
A1
A2
B1
B2
C1
C2
AUTO
```

Acceptance criteria:

- Every authenticated user can have one profile.
- Default level is sensible.
- Validation exists.

---

## TASK-017 — Create learning profile API

Status: `[x]`

Implement:

```text
GET /api/v1/profile/
PATCH /api/v1/profile/
```

Acceptance criteria:

- Authenticated access only.
- Level can be read and updated.
- Invalid levels are rejected.
- Tests exist.

---

## TASK-018 — Create mobile learning-level screen

Status: `[x]`

Create onboarding/settings UI for selecting English level.

Acceptance criteria:

- All levels are shown.
- Selection is persisted.
- API is updated in server mode.
- UI is testable.

---

# Phase 4 — LLM Infrastructure

## TASK-019 — Create LLM provider interface

Status: `[x]`

Create an application-level abstraction for LLM providers.

The abstraction must support:

- non-streaming completion
- streaming completion

Acceptance criteria:

- Application code does not depend directly on OpenRouter HTTP implementation.
- Interface is easy to mock.

---

## TASK-020 — Implement OpenRouter client

Status: `[x]`

Implement OpenRouter integration.

Requirements:

- API key configuration.
- Base URL configuration.
- Timeouts.
- Normal error handling.
- Request IDs/logging where useful.
- No secret logging.

Acceptance criteria:

- Unit tests mock HTTP.
- Successful completion is handled.
- Provider errors are normalized.

---

## TASK-021 — Implement model fallback

Status: `[x]`

Support:

```text
primary model
fallback models
```

If the primary model fails in a retryable/provider-availability scenario, try fallback models according to configured order.

Do not fallback for invalid user requests or permanent application errors.

Acceptance criteria:

- Primary success works.
- Primary failure can invoke fallback.
- All models failing returns a normalized error.
- Tests cover fallback ordering.

---

## TASK-022 — Implement OpenRouter model discovery

Status: `[x]`

Implement provider support for retrieving available models.

Acceptance criteria:

- Models can be retrieved.
- External API errors are handled.
- Secrets are not returned.
- Results have a normalized internal representation.

---

## TASK-023 — Create backend model configuration

Status: `[x]`

Create configuration for server-mode primary/fallback models.

Acceptance criteria:

- Configuration comes from environment/settings.
- No model names are hard-coded in business logic.
- Documentation explains configuration.

---

## TASK-024 — Implement LLM streaming service

Status: `[x]`

Implement streaming at the application service layer.

Acceptance criteria:

- Provider streaming events are normalized.
- Text chunks can be consumed incrementally.
- Provider errors terminate the stream cleanly.
- No incomplete assistant message is incorrectly marked complete.

---

## TASK-025 — Implement SSE endpoint foundation

Status: `[x]`

Create an authenticated SSE endpoint for streaming application events.

Acceptance criteria:

- Correct content type.
- Events can be consumed incrementally.
- Connection closes correctly.
- Errors have a defined event format.
- Tests cover successful and failed streams.

---

# Phase 5 — Conversation Backend

## TASK-026 — Create conversation/session model

Status: `[x]`

Create a session model containing at minimum:

```text
user
title
topic
topic_hint
learning_level
summary
summary_message_boundary
created_at
updated_at
```

Acceptance criteria:

- Sessions belong to users.
- Users cannot access another user's session.
- Migrations and model tests exist.

---

## TASK-027 — Create message model

Status: `[x]`

Create message model with:

```text
session
role
content
sequence/order
status
created_at
```

Roles:

```text
user
assistant
```

The model must support incomplete/failed assistant generation states.

Acceptance criteria:

- Message ordering is deterministic.
- Messages belong to a session.
- Failed assistant messages can be retried.
- Tests exist.

---

## TASK-028 — Implement topic generation service

Status: `[x]`

Create a service that generates a conversation topic from:

```text
learning level
optional user hint
```

The service must return structured topic information.

Acceptance criteria:

- Empty hint generates a topic.
- User hint influences the topic.
- Invalid LLM output is handled safely.
- Tests mock the LLM.

---

## TASK-029 — Generate sample conversation

Status: `[x]`

Extend topic generation to create a short sample conversation.

Acceptance criteria:

- Sample conversation belongs to the topic.
- It is not persisted as user chat messages.
- Sample data can be returned through the API.
- Tests exist.

---

## TASK-030 — Create session API

Status: `[x]`

Implement session creation.

Expected behavior:

```text
POST /api/v1/sessions/
```

Input:

```text
optional topic hint
```

Behavior:

1. Create session.
2. Generate topic.
3. Generate sample conversation.
4. Return session information.

Acceptance criteria:

- Authenticated only.
- Topic is generated.
- Sample conversation is available.
- Failures do not leave corrupt sessions.
- API tests exist.

---

## TASK-031 — Create session listing API

Status: `[x]`

Implement:

```text
GET /api/v1/sessions/
```

Requirements:

- User-specific.
- Pagination.
- Most recently updated first.

Acceptance criteria:

- Users only see their own sessions.
- Pagination works.
- Tests exist.

---

## TASK-032 — Implement session detail/messages API

Status: `[x]`

Implement retrieval of:

```text
GET /api/v1/sessions/{id}/
GET /api/v1/sessions/{id}/messages/
```

Acceptance criteria:

- Ownership enforced.
- Message ordering correct.
- Pagination works where appropriate.
- Tests exist.

---

## TASK-033 — Implement session rename

Status: `[x]`

Implement:

```text
PATCH /api/v1/sessions/{id}/
```

Allow title updates.

Acceptance criteria:

- User can rename own session.
- Other fields cannot be modified unintentionally.
- Tests exist.

---

## TASK-034 — Implement session deletion

Status: `[x]`

Implement:

```text
DELETE /api/v1/sessions/{id}/
```

Acceptance criteria:

- Ownership enforced.
- Related messages are deleted appropriately.
- Tests exist.

---

# Phase 5A — Conversation Context

## TASK-035 — Create context builder

Status: `[x]`

Create a service that constructs the LLM context:

```text
system prompt
learning profile
topic
summary
recent messages
current user message
```

Acceptance criteria:

- Context is deterministic.
- Old messages are not automatically included forever.
- Tests verify ordering and included sections.

---

## TASK-036 — Implement recent-message window

Status: `[x]`

Implement configurable recent-message selection.

Initial recommended default:

```text
20 recent messages
```

Acceptance criteria:

- Only the configured recent window is included.
- Ordering is correct.
- Current user message is handled correctly.

---

## TASK-037 — Implement conversation summarizer

Status: `[x]`

Create a summarization service.

Input:

```text
previous summary
+
messages leaving the active recent window
```

Output:

```text
new summary
```

The summarizer must not process the complete conversation every time.

Acceptance criteria:

- Existing summary is incorporated.
- Only newly archived messages are summarized.
- Tests verify input boundaries.
- LLM calls are mockable.

---

## TASK-038 — Implement summary trigger

Status: `[x]`

Implement configurable summary thresholds.

The system must not summarize after every user message.

Trigger summarization only when the configured context threshold is crossed.

Acceptance criteria:

- Normal short conversations do not trigger summarization.
- Long conversations eventually trigger summarization.
- Summary boundary is persisted.
- Repeated requests do not summarize the same messages unnecessarily.
- Tests cover boundary behavior.

---

## TASK-039 — Implement asynchronous summary update

Status: `[x]`

Use Celery for conversation summary updates where appropriate.

The user-facing chat request must not unnecessarily wait for summary maintenance if the summary can safely be updated asynchronously.

Acceptance criteria:

- Conversation remains usable if summarization fails.
- Failed summary jobs can retry.
- No duplicate summary ranges are produced.
- Tests cover task behavior.

---

# Phase 5B — Chat Generation

## TASK-040 — Implement user-message creation service

Status: `[x]`

Create an application service for adding user messages.

Requirements:

- Validate session ownership.
- Store user message.
- Build context.
- Create assistant generation state.

Acceptance criteria:

- Message persistence is transactional.
- Failed generation does not corrupt existing conversation.

---

## TASK-041 — Implement streaming chat endpoint

Status: `[x]`

Implement:

```text
POST /api/v1/sessions/{id}/messages/stream/
```

The endpoint must:

1. Validate authentication.
2. Validate session ownership.
3. Save user message.
4. Build context.
5. Start LLM stream.
6. Stream text chunks through SSE.
7. Persist final assistant message.
8. Emit completion event.

Acceptance criteria:

- Text appears incrementally.
- Final assistant message is persisted.
- Provider errors are represented clearly.
- Failed generation is retryable.

---

## TASK-042 — Implement failed-generation retry

Status: `[x]`

Implement retry for failed assistant generation.

Only failed assistant responses are retryable in MVP.

Acceptance criteria:

- Retry does not duplicate the user message.
- Failed assistant state can be replaced or retried safely.
- Successful assistant messages cannot be retried through this MVP endpoint.
- Tests exist.

---

# Phase 6 — Mobile Foundation

## TASK-043 — Create application navigation

Status: `[x]`

Implement navigation structure:

```text
Auth stack
Main stack
    Chat
    History
    Settings
```

Acceptance criteria:

- Unauthenticated users see auth screens.
- Authenticated users see main application.
- Navigation state is testable.

---

## TASK-044 — Implement theme system

Status: `[x]`

Implement:

- Light theme
- Dark theme
- System theme

Use a neutral, modern visual design.

Acceptance criteria:

- Theme can switch.
- System preference is respected.
- Core screens use theme tokens rather than hard-coded colors.

---

## TASK-045 — Create mobile API client

Status: `[x]`

Implement typed API client.

Requirements:

- TypeScript types.
- Authentication headers.
- Error normalization.
- JSON handling.

Acceptance criteria:

- No `any` for normal API models.
- API errors are represented consistently.
- Unit tests exist.

---

## TASK-046 — Create secure token storage

Status: `[x]`

Store authentication tokens using secure device storage.

Acceptance criteria:

- Tokens are not stored in plain AsyncStorage.
- Tokens survive restart.
- Logout removes credentials.

---

## TASK-047 — Implement authentication state

Status: `[x]`

Create application auth state.

Acceptance criteria:

- Startup restores authentication.
- Expired access tokens can be refreshed.
- Invalid refresh credentials return the user to login.

---

# Phase 7 — Mobile Chat

## TASK-048 — Create chat screen

Status: `[x]`

Implement the main conversation UI.

Requirements:

- Message list
- Composer
- Send button
- Loading state
- Empty state

Acceptance criteria:

- User can enter and send a message.
- Messages render in chronological order.
- UI works with keyboard.

---

## TASK-049 — Implement SSE mobile client

Status: `[ ]`

Implement typed SSE consumption for chat streaming.

Acceptance criteria:

- Chunks append incrementally.
- Assistant message appears while streaming.
- Completion is handled.
- Error events are displayed.
- Connection cleanup works when leaving screen.

---

## TASK-050 — Implement smooth streaming UX

Status: `[ ]`

Optimize chat streaming behavior.

Requirements:

- Avoid excessive React renders.
- Keep scroll position sensible.
- Automatically scroll when the user is near the bottom.
- Do not force-scroll when the user intentionally scrolls upward.

Acceptance criteria:

- Streaming feels continuous.
- Long messages do not visibly stutter.
- Tests cover core state transitions.

---

## TASK-051 — Implement new conversation UI

Status: `[ ]`

Create new conversation screen/modal.

Features:

```text
Optional topic hint
Start
Let AI choose
```

Acceptance criteria:

- Empty input works.
- Topic hint works.
- Session creation navigates to chat.
- Loading/error states exist.

---

## TASK-052 — Implement topic header

Status: `[ ]`

Display current topic in chat.

Acceptance criteria:

- Topic is visible without dominating the chat.
- Topic can be collapsed or compacted if appropriate.

---

## TASK-053 — Implement sample conversation UI

Status: `[ ]`

Add:

```text
Show me an example
```

Display sample conversation in a modal or equivalent overlay.

Acceptance criteria:

- Example is separate from actual chat history.
- Example supports TTS controls.
- Modal is accessible and dismissible.

---

## TASK-054 — Implement failed-response retry UI

Status: `[ ]`

Display retry control when assistant generation fails.

Acceptance criteria:

- Retry invokes backend retry.
- User sees useful error state.
- Successful responses remove failure state.

---

# Phase 8 — History

## TASK-055 — Create history screen

Status: `[ ]`

Display authenticated user's sessions.

Acceptance criteria:

- Sessions are paginated.
- Most recent sessions appear first.
- Tapping a session opens chat.
- Loading/empty/error states exist.

---

## TASK-056 — Implement session rename UI

Status: `[ ]`

Allow users to rename conversations.

Acceptance criteria:

- Rename is persisted.
- UI updates immediately after success.
- Failure is handled.

---

## TASK-057 — Implement session deletion UI

Status: `[ ]`

Allow users to delete sessions.

Acceptance criteria:

- Confirmation is shown.
- Session disappears after successful deletion.
- Errors are handled.

---

# Phase 9 — Suggested Replies

## TASK-058 — Implement suggestion service

Status: `[ ]`

Create backend service that generates exactly three replies.

Input:

```text
selected message
conversation context up to selected message
topic
learning profile
```

Acceptance criteria:

- Exactly three suggestions are returned.
- Suggestions are relevant.
- LLM output is validated.
- Tests mock the LLM.

---

## TASK-059 — Implement suggestion API

Status: `[ ]`

Create endpoint for generating suggestions for a selected message.

Acceptance criteria:

- Authentication and ownership are enforced.
- Invalid message/session combinations are rejected.
- API tests exist.

---

## TASK-060 — Implement message long-press menu

Status: `[ ]`

Long-press a message to display contextual actions.

Initial actions:

For user messages:

```text
Suggest replies
Improve my English
Copy
TTS
```

For assistant messages:

```text
Suggest replies
Copy
TTS
```

Acceptance criteria:

- Correct actions appear by message type.
- Menu dismisses correctly.
- Accessibility behavior exists.

---

## TASK-061 — Implement suggestion UI

Status: `[ ]`

Display three suggestions.

Acceptance criteria:

- Suggestions can be tapped.
- Tapping inserts text into the composer.
- Suggestions do not automatically send.
- Loading/error states exist.

---

# Phase 9B — English Improvement

## TASK-062 — Implement improvement service

Status: `[ ]`

Create LLM service for improving a user's English message.

Output should contain:

```text
original
improved
explanation
```

Acceptance criteria:

- Grammar/wording issues can be corrected.
- Explanation is concise.
- Valid structured output is enforced.
- Tests mock LLM behavior.

---

## TASK-063 — Implement improvement API

Status: `[ ]`

Create endpoint for improving a user message.

Acceptance criteria:

- Only user messages can use this action.
- Ownership is enforced.
- Existing message is not modified.
- API tests exist.

---

## TASK-064 — Implement improvement result UI

Status: `[ ]`

Display the improved message and explanation.

Acceptance criteria:

- Original message remains unchanged.
- User can copy the improved version.
- Loading/error states exist.

---

# Phase 10 — Vocabulary

## TASK-065 — Create vocabulary model

Status: `[ ]`

Create vocabulary item model.

Minimum fields:

```text
user
expression
normalized_expression
definition
translation
pronunciation
part_of_speech
example
source_message
source_session
status
created_at
updated_at
```

The model must support enrichment states.

Acceptance criteria:

- User ownership is enforced.
- Expression can represent words and phrases.
- Tests exist.

---

## TASK-066 — Implement vocabulary save API

Status: `[ ]`

Create vocabulary save endpoint.

Saving must be immediate.

Acceptance criteria:

- User can save a word/phrase.
- Duplicate behavior is deterministic.
- API returns quickly without waiting for enrichment.
- Tests exist.

---

## TASK-067 — Implement post-commit enrichment task scheduling

Status: `[ ]`

After vocabulary creation, enqueue enrichment using a transaction commit hook.

Do not use a `post_save` signal for this workflow.

Conceptual flow:

```text
transaction
    |
create vocabulary
    |
on_commit
    |
Celery enqueue
```

Acceptance criteria:

- Rollback does not enqueue enrichment.
- Successful transaction enqueues exactly one enrichment task.
- Tests cover rollback and success.

---

## TASK-068 — Implement vocabulary enrichment

Status: `[ ]`

Celery task enriches vocabulary using the LLM.

Fields:

```text
definition
translation
pronunciation
part_of_speech
example
```

Acceptance criteria:

- Task is retryable.
- Failure does not delete vocabulary.
- Enrichment status is persisted.
- LLM calls are mocked in tests.

---

## TASK-069 — Implement text selection flow

Status: `[ ]`

Implement mobile text selection for vocabulary saving.

The selection must support:

- single word
- phrase
- multi-word expression

Acceptance criteria:

- User can select text from a message.
- Selected text is passed to save flow.
- Selection does not break normal scrolling.

---

## TASK-070 — Implement vocabulary save popup

Status: `[ ]`

Display a popup after text selection.

Action:

```text
Save
Cancel
```

Acceptance criteria:

- Save calls API.
- Successful save immediately displays a toast.
- Enrichment is not awaited.
- Failure is clearly shown.

---

## TASK-071 — Implement vocabulary list API

Status: `[ ]`

Create:

```text
GET /api/v1/vocabulary/
```

Acceptance criteria:

- User only sees their vocabulary.
- Pagination exists.
- Tests exist.

---

## TASK-072 — Implement vocabulary screen

Status: `[ ]`

Create mobile vocabulary screen.

Acceptance criteria:

- Saved expressions are listed.
- Enrichment status is visible when useful.
- Loading/empty/error states exist.

---

# Phase 11 — Anki Export

## TASK-073 — Implement CSV export service

Status: `[ ]`

Generate generic Anki-compatible CSV.

Columns:

```text
Front
Back
Example
Pronunciation
```

Acceptance criteria:

- CSV escaping is correct.
- Unicode is preserved.
- Empty fields are handled.
- Tests cover commas, quotes and newlines.

---

## TASK-074 — Implement vocabulary export API

Status: `[ ]`

Create:

```text
GET /api/v1/vocabulary/export/
```

Acceptance criteria:

- Authenticated user can export own vocabulary.
- Correct content type.
- Correct filename.
- Tests exist.

---

## TASK-075 — Implement mobile export flow

Status: `[ ]`

Allow the user to export/share the CSV from the vocabulary screen.

Acceptance criteria:

- File can be generated.
- Native share/save workflow works.
- User receives useful success/error feedback.

---

# Phase 12 — TTS

## TASK-076 — Create TTS abstraction

Status: `[ ]`

Create a frontend TTS interface independent of the Android implementation.

Acceptance criteria:

- UI does not depend directly on native TTS APIs.
- Play/stop behavior is defined.

---

## TASK-077 — Implement Android TTS

Status: `[ ]`

Use Android-native TextToSpeech.

Acceptance criteria:

- English text can be spoken.
- Start/stop works.
- Missing language support is handled.
- TTS does not crash the application.

---

## TASK-078 — Add TTS to messages

Status: `[ ]`

Add TTS action to message menus.

Acceptance criteria:

- AI messages can be spoken.
- Playback state is visible.
- Starting another message stops or manages previous playback cleanly.

---

## TASK-079 — Add TTS to sample conversation

Status: `[ ]`

Add TTS controls to sample conversation messages.

Acceptance criteria:

- Sample text can be spoken.
- TTS behavior is consistent with normal messages.

---

# Phase 13 — Serverless Mode

## TASK-080 — Define application mode state

Status: `[ ]`

Implement:

```text
SERVER
SERVERLESS
```

as explicit application modes.

Acceptance criteria:

- Mode persists across application restarts.
- Mode switching is deterministic.
- Serverless data is never accidentally sent to server APIs.

---

## TASK-081 — Implement local SQLite database

Status: `[ ]`

Create local persistence for serverless mode.

Minimum entities:

```text
sessions
messages
summaries
learning_profile
settings
```

Acceptance criteria:

- Database initializes automatically.
- Migrations/versioning are supported.
- CRUD operations are tested.

---

## TASK-082 — Implement local conversation repository

Status: `[ ]`

Create repository abstraction for local conversations.

Acceptance criteria:

- Create session.
- Add message.
- Read session.
- List sessions.
- Rename session.
- Delete session.
- Store summaries.

---

## TASK-083 — Implement serverless OpenRouter client

Status: `[ ]`

Create mobile-side OpenRouter client.

Requirements:

- User API key.
- Primary model.
- Fallback models.
- Streaming.
- Model discovery.

Acceptance criteria:

- API key never goes to backend.
- Streaming works.
- Errors are normalized.
- Tests/mock adapter exists.

---

## TASK-084 — Implement serverless model discovery

Status: `[ ]`

Retrieve available models directly from OpenRouter.

Cache results locally.

Acceptance criteria:

- Models can be refreshed.
- Cached models remain available without immediate network access.
- Errors are handled.

---

## TASK-085 — Implement serverless topic generation

Status: `[ ]`

Use direct OpenRouter to generate topics.

Acceptance criteria:

- Optional topic hint works.
- Automatic topic generation works.
- Topic is persisted locally.

---

## TASK-086 — Implement serverless chat streaming

Status: `[ ]`

Use direct OpenRouter streaming.

Acceptance criteria:

- User messages are stored locally.
- Assistant messages stream locally.
- Completed assistant responses are persisted.
- Failed responses can be retried.

---

## TASK-087 — Implement serverless conversation context

Status: `[ ]`

Reuse the same context strategy as server mode:

```text
system prompt
+
learning profile
+
topic
+
summary
+
recent messages
+
current message
```

Acceptance criteria:

- Full history is not sent indefinitely.
- Summary threshold behavior matches server mode.
- Local summaries are persisted.

---

## TASK-088 — Implement serverless suggested replies

Status: `[ ]`

Implement suggestions directly through OpenRouter.

Acceptance criteria:

- Exactly three replies.
- No backend request.
- Suggestions are based on local conversation context.

---

## TASK-089 — Implement serverless message improvement

Status: `[ ]`

Implement English improvement directly through OpenRouter.

Acceptance criteria:

- No backend request.
- Existing message remains unchanged.
- Result is displayed correctly.

---

## TASK-090 — Implement serverless mode UI

Status: `[ ]`

Create Settings controls for serverless mode.

Display clear explanation:

```text
Server mode
Your conversations are stored with your account.

Serverless mode
Conversations stay on this device and AI requests go directly to OpenRouter.
```

Acceptance criteria:

- Mode can be switched.
- Server history disappears while serverless is active.
- Local history appears in serverless mode.

---

# Phase 14 — Settings

## TASK-091 — Create settings screen

Status: `[ ]`

Include:

```text
Account
Learning level
Application mode
OpenRouter settings
Theme
Clear local data
Logout
```

Show only relevant options for the current mode.

---

## TASK-092 — Implement serverless OpenRouter settings

Status: `[ ]`

Allow the user to configure:

```text
API key
Primary model
Fallback models
```

Acceptance criteria:

- API key is stored securely.
- API key is never logged.
- Models are selectable from discovered models.
- Fallback order is configurable.

---

## TASK-093 — Implement secure API-key storage

Status: `[ ]`

Store the serverless OpenRouter API key using secure device storage.

Acceptance criteria:

- Key is not stored in plain SQLite.
- Key is not logged.
- Key can be replaced.
- Key can be removed.

---

## TASK-094 — Implement local-data clearing

Status: `[ ]`

Settings must provide:

```text
Clear local data
```

Require confirmation.

The operation clears serverless SQLite data.

It must not delete server-side account data.

Acceptance criteria:

- Confirmation exists.
- Local conversations are removed.
- Local profile/settings data that belongs to serverless storage is removed appropriately.
- Server data remains untouched.

---

# Phase 15 — Error Handling and Reliability

## TASK-095 — Define API error format

Status: `[ ]`

Create a consistent backend API error structure.

Acceptance criteria:

- Validation errors are predictable.
- Authentication errors are predictable.
- Server errors do not leak internals.
- Frontend can display useful messages.

---

## TASK-096 — Implement network error handling

Status: `[ ]`

Mobile API clients must distinguish:

```text
network failure
authentication failure
validation failure
server failure
LLM failure
timeout
```

Acceptance criteria:

- User receives appropriate feedback.
- Retry is available where useful.

---

## TASK-097 — Implement LLM timeout handling

Status: `[ ]`

Configure sensible timeouts for OpenRouter requests.

Acceptance criteria:

- Hanging provider requests do not hang forever.
- Streaming timeout behavior is defined.
- User receives retryable error state.

---

## TASK-098 — Implement Celery retry policy

Status: `[ ]`

Configure retry policies for:

- vocabulary enrichment
- conversation summarization

Acceptance criteria:

- Transient failures retry.
- Permanent failures do not retry forever.
- Task state is observable.

---

# Phase 16 — Security

## TASK-099 — Review authentication security

Status: `[ ]`

Review:

- password handling
- JWT expiration
- refresh tokens
- token storage
- CORS/CSRF requirements
- authentication rate limiting where appropriate

Acceptance criteria:

- No plaintext passwords.
- No server secrets exposed to mobile.
- Security-sensitive tests exist.

---

## TASK-100 — Review authorization

Status: `[ ]`

Audit all user-owned endpoints.

Acceptance criteria:

- A user cannot access another user's sessions.
- A user cannot access another user's messages.
- A user cannot access another user's vocabulary.
- A user cannot modify another user's profile.

---

## TASK-101 — Review secret handling

Status: `[ ]`

Audit:

- environment variables
- logs
- exception messages
- mobile secure storage
- source control

Acceptance criteria:

- No API keys are committed.
- Server OpenRouter key never reaches mobile.
- User serverless OpenRouter key never reaches backend.

---

# Phase 17 — Performance

## TASK-102 — Optimize chat database access

Status: `[ ]`

Review queries used during chat generation.

Acceptance criteria:

- Avoid N+1 queries.
- Session ownership and recent-message retrieval are efficient.
- Relevant indexes exist.

---

## TASK-103 — Optimize streaming UI

Status: `[ ]`

Profile the React Native chat screen.

Acceptance criteria:

- Streaming does not cause excessive component renders.
- Large message lists remain usable.
- Memoization is used only where useful.

---

## TASK-104 — Optimize conversation context

Status: `[ ]`

Verify that the LLM context builder does not send unnecessary data.

Acceptance criteria:

- Old raw messages are excluded once summarized.
- Summary is reused.
- Recent message count is bounded.
- Tests verify context size boundaries.

---

# Phase 18 — Testing

## TASK-105 — Backend authentication integration tests

Status: `[ ]`

Test:

- registration
- login
- refresh
- logout
- unauthorized access

---

## TASK-106 — Backend conversation integration tests

Status: `[ ]`

Test:

- session creation
- topic generation
- message creation
- streaming lifecycle
- retry
- ownership

Mock OpenRouter.

---

## TASK-107 — Backend memory tests

Status: `[ ]`

Test:

- recent message selection
- summary trigger
- summary boundaries
- rolling summary updates
- duplicate summary prevention

This task is especially important.

---

## TASK-108 — Backend vocabulary integration tests

Status: `[ ]`

Test:

- save
- transaction rollback
- Celery enqueue
- enrichment
- ownership
- CSV export

---

## TASK-109 — Mobile authentication tests

Status: `[ ]`

Test:

- login
- registration
- token restoration
- logout
- expired token handling

---

## TASK-110 — Mobile chat tests

Status: `[ ]`

Test:

- message rendering
- composer
- streaming state
- retry
- navigation
- long press

---

## TASK-111 — Mobile serverless tests

Status: `[ ]`

Test:

- mode switching
- local persistence
- direct OpenRouter client
- local history
- local summary
- local data clearing

---

## TASK-112 — Mobile vocabulary tests

Status: `[ ]`

Test:

- text selection flow
- save popup
- immediate toast
- vocabulary list
- export action

---

# Phase 19 — Documentation

## TASK-113 — Document local development

Status: `[ ]`

README must explain:

- prerequisites
- uv
- pnpm
- Docker
- Android setup
- environment configuration
- running backend
- running mobile
- running tests

---

## TASK-114 — Document architecture

Status: `[ ]`

Document:

- server mode
- serverless mode
- LLM provider
- streaming
- conversation memory
- Celery
- vocabulary enrichment

---

## TASK-115 — Document API

Status: `[ ]`

Document major API endpoints and request/response behavior.

Do not attempt to manually duplicate every serializer implementation.

---

# Phase 20 — Final Product Validation

## TASK-116 — Validate complete server-mode user journey

Status: `[ ]`

Verify:

```text
Register
→ Login
→ Choose level
→ New conversation
→ Generate topic
→ Chat
→ Stream response
→ History
→ Rename
→ Suggest replies
→ Improve message
→ Save vocabulary
→ Enrich vocabulary
→ Export CSV
→ TTS
→ Delete conversation
```

Acceptance criteria:

- Full journey works without manual database manipulation.

---

## TASK-117 — Validate complete serverless journey

Status: `[ ]`

Verify:

```text
Enable serverless
→ Configure API key
→ Select model
→ Generate topic
→ Chat
→ Stream response
→ History
→ Suggest replies
→ Improve message
→ TTS
→ Clear local data
```

Acceptance criteria:

- No server dependency is used for serverless chat.
- Serverless vocabulary functionality is correctly unavailable.
- Local data is removed by clear-data action.

---

## TASK-118 — Validate mode isolation

Status: `[ ]`

Verify:

```text
Server history
    !=
Serverless history
```

Acceptance criteria:

- Serverless never displays server conversations.
- Server never receives serverless conversations.
- Serverless API key never reaches backend.
- Clearing local data does not affect server data.

---

## TASK-119 — Run complete quality checks

Status: `[ ]`

Run all relevant checks.

Backend:

```text
uv run ruff check .
uv run ruff format --check .
uv run pytest
uv run python manage.py check
```

Mobile:

```text
pnpm lint
pnpm test
pnpm typecheck
```

Use the actual project commands if they differ.

Acceptance criteria:

- All checks pass.
- No ignored failing test remains without explicit documentation.

---

## TASK-120 — Final MVP audit

Status: `[ ]`

Compare the implementation against `ROADMAP.md`.

Verify every MVP requirement.

Acceptance criteria:

- No required MVP feature is missing.
- No task is incorrectly marked complete.
- README is usable by a new developer.
- Docker Compose starts successfully.
- Android application builds successfully.
- Test suite passes.

---

# Engineering Rules

## Rule 1 — Do not over-engineer

Prefer:

```text
simple implementation
```

over:

```text
generic framework
```

unless the abstraction is required by the architecture.

---

## Rule 2 — Do not add unnecessary infrastructure

Do not introduce:

- Kafka
- RabbitMQ
- Elasticsearch
- pgvector
- Kubernetes
- WebSockets
- GraphQL

unless a concrete requirement emerges.

Redis + Celery + PostgreSQL are sufficient for MVP.

---

## Rule 3 — LLM calls must be isolated

Never call OpenRouter directly from:

- Django models
- serializers
- React components

Use service/provider abstractions.

---

## Rule 4 — External calls must be mockable

Every OpenRouter integration must be mockable in tests.

Tests must not depend on real OpenRouter availability.

---

## Rule 5 — Streaming must persist final state

Streaming chunks are transient.

The final assistant response must be persisted as one canonical message.

Do not persist every token as an individual database record.

---

## Rule 6 — Conversation summaries are incremental

Never regenerate the complete conversation summary on every message.

Use:

```text
previous summary
+
newly archived messages
```

and persist the boundary.

---

## Rule 7 — Vocabulary saving is synchronous only for persistence

The save operation should:

```text
persist immediately
return success
```

Enrichment is asynchronous.

Never make the user wait for enrichment.

---

## Rule 8 — Use transaction commit hooks for background jobs

When database creation triggers a Celery task:

```python
transaction.on_commit(...)
```

must be preferred over `post_save`.

This prevents jobs from running against rolled-back database state.

---

## Rule 9 — Serverless must remain isolated

Serverless mode must not silently call the application's backend.

Direct OpenRouter requests are allowed.

Backend authentication credentials are irrelevant in serverless mode.

---

## Rule 10 — Never expose API secrets

Never:

- commit API keys
- log API keys
- return API keys through APIs
- include server OpenRouter keys in mobile bundles
- store user OpenRouter keys in ordinary application logs

---

## Rule 11 — Mobile code quality

Use strict TypeScript.

Avoid `any`.

Use explicit types for:

- API responses
- navigation parameters
- local database entities
- state
- service interfaces

Use single quotes and no semicolons.

---

## Rule 12 — Backend code quality

Use:

- Full type annotations
- Explicit return types
- Docstrings for public functions/classes
- PEP 8
- Ruff-compatible code

Do not suppress Ruff rules without a concrete reason.

---

## Rule 13 — Tests accompany implementation

A task involving business logic should normally include tests in the same task.

Do not postpone all testing until the end.

---

## Rule 14 — Keep tasks atomic

If implementation reveals that a task is substantially larger than expected:

1. Complete the smallest coherent part.
2. Add a new task to this specification.
3. Do not silently expand the original task into an uncontrolled feature.

---

## Rule 15 — Preserve existing behavior

Before modifying existing code:

1. Inspect it.
2. Run relevant tests.
3. Understand current behavior.
4. Make the smallest safe change.

---

# Task Execution Protocol

The autonomous agent should repeatedly perform:

```text
READ ROADMAP
    ↓
READ SPEC
    ↓
FIND FIRST UNFINISHED DEPENDENCY-SAFE TASK
    ↓
INSPECT CODE
    ↓
IMPLEMENT
    ↓
TEST
    ↓
FIX
    ↓
QUALITY CHECK
    ↓
MARK [x]
    ↓
COMMIT
    ↓
REPEAT
```

The agent should stop only when:

- All tasks are complete.
- A genuine external blocker exists.
- The repository is irreparably inconsistent.
- A documented product decision contradicts another documented requirement.

Routine implementation uncertainty is not a reason to stop.

When uncertain, choose the smallest implementation that satisfies the documented acceptance criteria.

---

# MVP Completion Condition

The project is complete when:

```text
TASK-001 through TASK-120
```

are either:

- completed, or
- explicitly superseded by a documented implementation decision.

The final implementation must satisfy the product definition in `ROADMAP.md`.

No additional user prompt should be required for normal implementation decisions.