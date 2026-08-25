# English Learning Chat

A mobile application for learning English through natural AI conversation, built as a ChatGPT-style chat experience with features designed for language learners.

## Features

- AI-generated conversation topics and sample conversations
- Natural conversational practice with streaming AI responses
- English-learning profile (CEFR levels A1–C2 + AUTO)
- Conversation history with long-term memory via rolling summaries
- Suggested replies and on-demand "Improve my English" corrections
- Vocabulary saving via text selection with asynchronous enrichment
- Anki-compatible CSV export
- Text-to-speech (Android native)
- Two isolated modes: authenticated **Server mode** and local **Serverless mode**
- OpenRouter model fallback

## Architecture

```text
Server mode:
React Native → HTTPS → Django REST API → PostgreSQL / Redis / Celery → OpenRouter

Serverless mode:
React Native → Local SQLite + OpenRouter directly
```

| Directory | Purpose |
| --- | --- |
| `backend/` | Django 6.x REST API, Celery workers, LLM provider abstraction |
| `mobile/` | React Native (TypeScript) application |
| `docker/` | Docker and Docker Compose configuration for development services |
| `docs/` | Architecture notes and documentation |

## Technology Stack

**Backend:** Python · Django 6.x · Django REST Framework · PostgreSQL · Redis · Celery · SSE streaming · pytest · uv · Ruff · python-decouple · Docker Compose

**Frontend:** React Native (New Architecture) · TypeScript · pnpm · React Navigation · NativeWind · Reanimated · Jest · React Native Testing Library

## Development

The project uses an autonomous Loop Engineering workflow tracked in [`SPEC.md`](SPEC.md) (executable backlog), [`ROADMAP.md`](ROADMAP.md) (product/architecture goals), and [`STATE.md`](STATE.md) (loop execution state).

### Backend

```bash
cd backend
uv sync
```

Quality gates (run individually):

```bash
uv run ruff check .             # lint
uv run ruff format --check .    # formatting check (apply: uv run ruff format .)
uv run pytest                   # tests (pytest + pytest-django)
uv run python manage.py check   # Django system checks
```

Tests run against an isolated PostgreSQL database (`test_elearning`, see
`POSTGRES_TEST_DB`); it is created and destroyed per run and never touches the
development database. Without Docker services available, fall back to SQLite:

```bash
DB_ENGINE=sqlite3 uv run pytest
```

Or all at once, CI-style, from the repository root:

```bash
make quality
```

### User model

Authentication uses a custom user model (`AUTH_USER_MODEL = "accounts.User"`,
`accounts.User` extending Django's `AbstractUser`). Both `username` and `email`
are unique; passwords use Django's standard hashing. The setting was introduced
before any dependent migrations existed, so no data migration is required.

### Authentication API

JWT-based authentication via `djangorestframework-simplejwt`. DRF defaults are
deny-unauthenticated: every endpoint requires a bearer token unless it
explicitly opts out (`register`, `login`, `refresh`, `health`).

```text
POST /api/v1/auth/register/   {username, email, password} → 201
POST /api/v1/auth/login/      {username | email, password} → {access, refresh, user}
POST /api/v1/auth/refresh/    {refresh} → {access}
GET  /api/v1/auth/me/         Bearer token → current user
```

Login accepts either the username or the email address. Token lifetimes come
from `JWT_ACCESS_TOKEN_MINUTES` and `JWT_REFRESH_TOKEN_DAYS` in `.env`.

### Mobile

```bash
cd mobile
pnpm install
pnpm typecheck
pnpm test
```

Run on Android (requires JDK 17+ and `ANDROID_HOME` pointing at the Android SDK):

```bash
cd mobile
pnpm start          # Metro, keep running
pnpm android        # builds debug APK, installs and launches on a connected device/emulator
```

The app targets the New Architecture (`newArchEnabled=true`) and Hermes. Debug builds load JS from Metro; a production bundle is produced by `assembleRelease`. See `mobile/README.md` for details.

### Infrastructure

Docker Compose provides `backend`, `postgres`, `redis`, and `worker` services. See `.env.example` for required environment variables; copy it to `.env` and fill in real values.

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up
```
