# ROADMAP.md

# English Learning Chat — Development Roadmap

## 1. Project Goal

Build a mobile application for learning English through natural AI conversation.

The application should feel similar to a modern ChatGPT-style mobile chat application while adding features specifically designed for English learning:

- AI-generated conversation topics
- Natural conversational practice
- Streaming AI responses
- English-learning profile and difficulty
- Conversation history
- Long-term conversation memory with rolling summaries
- Suggested replies
- Explicit English improvement/correction
- Text selection and vocabulary saving
- Asynchronous vocabulary enrichment
- Anki-compatible CSV export
- Text-to-speech
- Serverless/local mode
- OpenRouter model fallback
- Authentication
- Smooth mobile navigation and interactions

The system must be implementable autonomously by OpenCode using Loop Engineering.

The agent must not require the user to provide additional implementation decisions for normal engineering choices.

---

# 2. Product Modes

The application has two completely separate modes.

## 2.1 Server Mode

Server mode is the authenticated/default mode.

Architecture:

```text
React Native
    |
    | HTTPS
    v
Django REST API
    |
    +-- PostgreSQL
    +-- Redis
    +-- Celery
    |
    v
OpenRouter
```

Server mode provides:

- Authentication
- Cloud conversation history
- AI conversations
- Streaming responses
- Conversation summaries
- Learning profile
- Suggested replies
- Message improvement
- Vocabulary saving
- Vocabulary enrichment
- Anki export
- Server-side model configuration
- Persistent account data

---

## 2.2 Serverless Mode

Serverless mode is a completely local mode.

Architecture:

```text
React Native
    |
    +-- Local SQLite
    |
    +-- OpenRouter directly
```

Serverless mode provides:

- Local conversations
- Local conversation summaries
- Local learning profile
- AI topic generation
- AI conversation
- Streaming AI responses
- Suggested replies
- Message improvement
- TTS
- User-selected OpenRouter API key
- User-selected primary model
- User-selected fallback models

Serverless mode does not provide:

- Account synchronization
- Server conversation history
- Server vocabulary
- Vocabulary enrichment
- Anki export
- Server-side persistence

Switching modes does not merge databases.

When serverless mode is active, server history is not shown.

When server mode is restored, server history becomes available again.

Serverless local data remains on the device until the user explicitly clears it.

---

# 3. Technology Stack

## Backend

- Python
- Django 6.x
- Django REST Framework
- PostgreSQL
- Redis
- Celery
- Celery Beat where scheduled work is required
- OpenRouter
- SSE for LLM response streaming
- pytest
- pytest-django
- uv
- Ruff
- python-decouple
- Docker
- Docker Compose

Do not introduce pgvector unless a concrete feature requires semantic/vector search.

Do not introduce WebSockets unless SSE becomes demonstrably insufficient.

---

## Frontend

- React Native
- TypeScript
- pnpm
- React Navigation
- NativeWind
- React Native Reanimated
- React Native Gesture Handler
- Lucide React Native icons
- React Native SQLite-compatible local persistence
- Android native TTS
- React Native Testing Library
- Jest

Use the React Native New Architecture.

Use Android-native capabilities through small isolated native modules when a reliable JavaScript package is not appropriate.

---

# 4. Architectural Principles

## 4.1 Backend separation

Separate:

```text
API
Application services
Domain/business logic
Infrastructure
Persistence
External integrations
```

Do not put OpenRouter calls directly inside Django views.

Do not put business logic directly inside serializers.

Do not use Django signals for important domain workflows unless there is a strong reason.

---

## 4.2 LLM provider abstraction

All backend OpenRouter interaction must go through an application-level provider abstraction.

Conceptually:

```text
LLMProvider
    |
    +-- OpenRouterProvider
```

The rest of the application must not depend directly on OpenRouter HTTP details.

The provider must support:

- Normal completion
- Streaming completion
- Model fallback
- Structured responses where needed
- Error normalization
- Timeouts
- Retry-safe behavior

---

# 5. Conversation Context Architecture

Never send the complete conversation to the LLM indefinitely.

Each conversation consists conceptually of:

```text
system instructions
+
learning profile
+
topic
+
conversation summary
+
recent messages
+
current user message
```

The application maintains:

- A rolling summary
- Recent raw messages
- Topic information
- Learning profile

The summary is not regenerated for every message.

A summary is updated only when the conversation context crosses a configured threshold.

The summary operation should summarize only the newly archived portion plus the previous summary.

Example:

```text
Summary:
messages 1-40

Recent messages:
41-60
```

After compaction:

```text
Summary:
messages 1-60

Recent messages:
61-80
```

The exact thresholds must be configurable.

---

# 6. Conversation Flow

## New conversation

The user opens a new conversation.

The UI provides an optional topic hint:

```text
What would you like to talk about?

[ Traveling ]

or

[ Let AI choose a topic ]
```

If the user provides a hint:

```text
hint -> LLM -> topic
```

If the user skips:

```text
no hint -> LLM -> topic
```

The generated topic contains enough information for the AI to conduct an English-learning conversation.

The session then begins with an AI message.

---

# 7. Sample Conversation

Every topic should have a sample conversation.

The sample conversation is accessed through:

```text
Show me an example
```

The example is displayed in a modal or equivalent overlay.

The example supports TTS.

The example does not become part of the user's actual conversation history.

---

# 8. Message Features

## Retry

Only failed AI responses are retryable in the MVP.

No message editing is required.

No regeneration of successful responses is required.

---

## Suggest replies

Long-pressing any chat message provides:

```text
Suggest replies
```

The system generates exactly three possible replies.

Suggestions are based on:

- Selected message
- Conversation context surrounding the message
- Topic
- Learning level

Suggestions must be:

- Natural
- Appropriate for the user's level
- Relevant to the topic
- Meaningfully different from each other

Selecting a suggestion places it into the composer.

It does not automatically send the message.

---

## Improve my English

Long-pressing a user message provides:

```text
Improve my English
```

The feature performs an additional LLM request only when explicitly requested.

Normal messages do not trigger a separate grammar-check request.

The result should explain:

- Improved sentence
- Important corrections
- Short explanation appropriate for the user's level

MVP does not automatically flag grammar errors on every message.

---

# 9. Vocabulary

The user can select:

- A word
- A phrase
- A multi-word expression

A popup provides:

```text
Save word
```

Saving is immediate.

The UI shows a small success toast.

The enrichment process happens asynchronously.

Flow:

```text
select text
    |
save
    |
database
    |
toast
    |
transaction commit
    |
Celery task
    |
LLM enrichment
    |
update vocabulary
```

Do not make the user wait for enrichment.

Do not enqueue background work before the database transaction commits.

---

# 10. Vocabulary Data

The vocabulary model must contain enough information for future learning-card generation.

MVP export fields:

```text
Front
Back
Example
Pronunciation
```

The exported CSV must be usable as an input for creating Anki cards.

The internal model may contain additional metadata.

---

# 11. Authentication

MVP authentication:

- Email or username
- Password
- Login
- Registration
- Logout
- Token refresh

No social login is required.

JWT-based authentication is recommended.

---

# 12. Learning Profile

The user provides an initial English level.

Supported levels:

```text
A1
A2
B1
B2
C1
C2
AUTO
```

The profile may later be expanded.

The learning level influences:

- Topic difficulty
- Vocabulary
- Suggested replies
- Corrections
- AI communication style

`AUTO` allows the AI to infer an appropriate level.

---

# 13. TTS

The first implementation uses Android-native text-to-speech.

TTS must work for:

- AI messages
- Sample conversations
- Vocabulary pronunciation where applicable

TTS is local and does not require an additional backend service.

---

# 14. OpenRouter

OpenRouter is the LLM gateway.

Backend:

```text
application -> OpenRouter
```

Serverless:

```text
mobile -> OpenRouter
```

Serverless settings include:

- API key
- Primary model
- Fallback models

The application should retrieve available OpenRouter models through the OpenRouter models endpoint and cache the result locally.

Do not expose the server's OpenRouter API key to the mobile application.

---

# 15. Data Isolation

Server mode and serverless mode are intentionally isolated.

There is no synchronization in MVP.

There is no automatic migration between modes.

There is no merging of conversations.

This reduces complexity and makes privacy expectations clear.

---

# 16. Mobile UX

The UI should be inspired by ChatGPT-style interaction patterns without copying proprietary branding.

Primary navigation:

```text
Chat
History
Settings
```

The chat interface should provide:

- Smooth message streaming
- Auto-scrolling
- Composer
- Keyboard handling
- Long press
- Text selection
- TTS controls
- Loading states
- Error states
- Retry
- Topic information
- Example conversation
- Suggested replies

Use a free neutral theme with:

- Light mode
- Dark mode
- System theme support
- Neutral backgrounds
- Strong text hierarchy
- Accessible contrast

Do not spend MVP effort reproducing ChatGPT pixel-for-pixel.

---

# 17. Backend Infrastructure

Docker Compose must provide the required development services.

At minimum:

```text
backend
postgres
redis
worker
```

Add other services only when required.

The application must have:

- `.env.example`
- Development configuration
- Production-oriented configuration structure
- Health checks
- Database migrations
- Test environment

---

# 18. Testing Strategy

Backend:

- Unit tests
- Service tests
- API tests
- Authentication tests
- LLM provider tests with mocked external calls
- Streaming tests
- Celery task tests
- Database behavior tests

Frontend:

- Component tests
- Navigation tests
- Chat state tests
- Local database tests
- Serverless mode tests
- API client tests
- Critical interaction tests

Do not test third-party OpenRouter behavior directly.

Mock external network calls.

---

# 19. Definition of Done

A task is complete only when:

1. Implementation exists.
2. Relevant tests exist or an explicit reason explains why tests are unnecessary.
3. Existing tests still pass.
4. Ruff/type/lint checks pass where applicable.
5. The implementation follows the architecture.
6. No unrelated work is introduced.
7. Documentation/configuration is updated when required.
8. The task's acceptance criteria are satisfied.
9. The task is marked complete in `SPEC.md`.

---

# 20. Autonomous Loop Rules

OpenCode should operate without asking the user for routine engineering decisions.

For every loop:

```text
1. Read ROADMAP.md.
2. Read SPEC.md.
3. Determine the first incomplete task whose dependencies are satisfied.
4. Inspect the existing implementation.
5. Implement only the selected task.
6. Run relevant tests.
7. Fix failures caused by the implementation.
8. Run broader checks when appropriate.
9. Mark the task complete.
10. Update documentation if required.
11. Commit the completed task when the repository workflow allows it.
12. Continue with the next task.
```

If implementation details are unspecified:

> Choose the simplest production-appropriate implementation consistent with this roadmap and the existing codebase.

Do not stop to ask the user about:

- Naming
- File organization
- Normal library choices
- Internal implementation details
- Test structure
- Error handling
- UI spacing
- Standard REST conventions

Ask the user only if a decision would change an explicit product requirement or make the documented architecture impossible.

---

# 21. Phase Overview

## Phase 0 — Foundation

Repository, Docker, Django, React Native, tooling and quality gates.

## Phase 1 — Backend Core

Database models, configuration, API foundation and health checks.

## Phase 2 — Authentication

Registration, login, refresh, logout and protected APIs.

## Phase 3 — Learning Profile

User learning level and profile management.

## Phase 4 — LLM Infrastructure

OpenRouter abstraction, model configuration, fallback and streaming.

## Phase 5 — Conversation Backend

Sessions, topics, messages and rolling conversation summaries.

## Phase 6 — Mobile Foundation

Navigation, theme, API client, authentication state and local storage foundation.

## Phase 7 — Chat Experience

Chat screen, streaming messages, composer, errors and retry.

## Phase 8 — History

Session listing, rename and deletion.

## Phase 9 — Learning Features

Suggested replies and message improvement.

## Phase 10 — Vocabulary

Text selection, saving, enrichment and vocabulary UI.

## Phase 11 — Anki Export

CSV generation and download/share workflow.

## Phase 12 — TTS

Android native TTS integration.

## Phase 13 — Serverless Mode

Local SQLite conversations and direct OpenRouter.

## Phase 14 — Settings and Data Management

Mode selection, model settings, API key management and local-data clearing.

## Phase 15 — Testing and Hardening

Integration testing, error handling, performance, security and UX polish.

## Phase 16 — Release Readiness

Production configuration, documentation, migrations, Docker and release checklist.

---

# 22. Final Product Definition

The MVP is complete when a user can:

1. Install the application.
2. Create an account.
3. Select an English level.
4. Start a new conversation.
5. Provide an optional topic hint or let AI choose.
6. Receive a generated topic.
7. Chat naturally with the AI.
8. See AI responses stream into the UI.
9. Open conversation history.
10. Rename and delete conversations.
11. Retry a failed AI response.
12. Long-press a message and request three suggested replies.
13. Long-press a user message and request an English improvement.
14. Select a word or phrase.
15. Save it immediately.
16. Receive enrichment asynchronously.
17. Export vocabulary as CSV.
18. Listen to AI/sample text using TTS.
19. Switch to serverless mode.
20. Configure an OpenRouter API key.
21. Select primary/fallback models.
22. Continue chatting using local SQLite.
23. Clear serverless local data from Settings.
24. Switch back to server mode without synchronizing the two data stores.

No feature outside this definition is required for MVP.