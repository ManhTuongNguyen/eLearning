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
| `docker/` | Backend Docker image definition (referenced by the root `docker-compose.yml`) |
| `docs/` | Architecture notes and documentation |

A detailed walkthrough of the system — modes, LLM provider abstraction,
streaming, conversation memory, Celery and the vocabulary enrichment flow —
lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Technology Stack

**Backend:** Python · Django 6.x · Django REST Framework · PostgreSQL · Redis · Celery · SSE streaming · pytest · uv · Ruff · python-decouple · Docker Compose

**Frontend:** React Native (New Architecture) · TypeScript · pnpm · React Navigation · NativeWind · Reanimated · Jest · React Native Testing Library

## Prerequisites

| Tool | Version | Used for | Notes |
| --- | --- | --- | --- |
| [uv](https://docs.astral.sh/uv/) | latest | Python/venv + dependency management for the backend | Install: `curl -LsSf https://astral.sh/uv/install.sh \| sh` (Windows: `powershell -c "irm https://astral.sh/uv/install.ps1 \| iex"`). uv provisions the Python interpreter itself. |
| Node.js | >= 20 | Mobile build runtime | |
| [pnpm](https://pnpm.io/) | latest | Mobile package manager | Enable via `corepack enable pnpm` (ships with Node 20+). The mobile app requires `node-linker=hoisted`, already configured in `mobile/.npmrc`. |
| Docker + Compose | 24+ | PostgreSQL, Redis, backend and Celery worker services | Any Compose v2-capable install (`docker compose version`). |
| JDK | 17+ | Android Gradle builds | Set `JAVA_HOME`. |
| Android SDK | recent API level | Building/installing on a device or emulator | Set `ANDROID_HOME` (e.g. `~/Android/Sdk`); easiest via [Android Studio](https://developer.android.com/studio). |

The backend also needs a PostgreSQL server and Redis instance for full fidelity — both are provided by Docker Compose (see [Running the backend](#running-the-backend)).

## Environment configuration

Copy the example environment file at the repository root and fill in real values — never commit `.env`:

```bash
cp .env.example .env
```

`.env.example` documents every variable. The most important ones:

| Variable | Purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Django signing key; generate with `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"` |
| `DJANGO_DEBUG` / `DJANGO_ALLOWED_HOSTS` | Server mode; production-required variables are enforced at startup when `DJANGO_DEBUG=False` |
| `POSTGRES_*` | Database credentials used by Django, Docker Compose and pytest |
| `DB_ENGINE` | `postgresql` (default) or `sqlite3` for a no-Docker quick start |
| `REDIS_URL` / `CELERY_*` | Redis connection and Celery broker/result backends |
| `OPENROUTER_API_KEY` | Server-side LLM key — never sent to the mobile application |
| `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODELS` | Server-mode model chain (see [LLM model configuration](#llm-model-configuration)) |
| `JWT_*` | Access/refresh token lifetimes |

The mobile app needs no `.env`; server-mode API base URL and serverless settings (user OpenRouter key, models) are configured in the app (Settings → serverless OpenRouter settings; the key is stored in secure device storage).

## Development

The project uses an autonomous Loop Engineering workflow tracked in [`SPEC.md`](SPEC.md) (executable backlog), [`ROADMAP.md`](ROADMAP.md) (product/architecture goals), and [`STATE.md`](STATE.md) (loop execution state).

### Running the backend

Option A — everything in Docker (recommended first run):

```bash
docker compose up --build
```

This starts `postgres` (PostgreSQL 17), `redis` (Redis 8), `backend` (Django — applies migrations and serves on `http://localhost:8000`) and `worker` (Celery), with health checks gating startup order. Intra-network hostnames (`postgres`, `redis`) are injected automatically; your `.env` still supplies credentials.

Option B — native Python with data services in Docker:

```bash
docker compose up -d postgres redis
cd backend
uv sync                           # creates .venv, installs locked dependencies
uv run python manage.py migrate
uv run python manage.py runserver # http://localhost:8000
```

In a second terminal, run the Celery worker (vocabulary enrichment, conversation summarization):

```bash
cd backend
uv run celery -A config worker --loglevel=info
```

Local debugging without Docker at all: set `DB_ENGINE=sqlite3` in `.env` (or pass it per command). The health endpoint `GET /api/v1/health/` reports infrastructure status.

### Running mobile

```bash
cd mobile
pnpm install
pnpm start          # Metro dev server (keep running)
pnpm android        # builds debug APK, installs and launches on a connected device/emulator
```

Requires JDK 17+ (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`); for an emulator, Metro reachability is handled automatically by `run-android` (`adb reverse tcp:8081 tcp:8081`). The app targets the New Architecture (`newArchEnabled=true`) and Hermes. Debug builds load JS from Metro; a production bundle is produced by `cd android && ./gradlew assembleRelease`. See [`mobile/README.md`](mobile/README.md) for details on local SQLite storage, application modes and secure key storage.

### Running tests

Backend — pytest + pytest-django against an isolated database (`test_elearning`, see `POSTGRES_TEST_DB`); it is created and destroyed per run and never touches the development database. Start Postgres first (`docker compose up -d postgres redis`):

```bash
cd backend
uv run pytest
```

Without Docker services available, fall back to SQLite (a few DB-fidelity tests are excluded):

```bash
DB_ENGINE=sqlite3 uv run pytest
```

All backend quality gates at once, CI-style, from the repository root:

```bash
make quality
```

Individual gates:

```bash
cd backend
uv run ruff check .             # lint
uv run ruff format --check .    # formatting check (apply: uv run ruff format .)
uv run pytest                   # tests (pytest + pytest-django)
uv run python manage.py check   # Django system checks
```

Mobile — Jest with React Native Testing Library (no device required):

```bash
cd mobile
pnpm test           # jest
pnpm typecheck      # tsc --noEmit (strict mode)
pnpm lint           # eslint
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
POST /api/v1/auth/logout/     Bearer + {refresh} → blacklists that refresh token
POST /api/v1/auth/refresh/    {refresh} → {access}
GET  /api/v1/auth/me/         Bearer token → current user
```

Login accepts either the username or the email address. Token lifetimes come
from `JWT_ACCESS_TOKEN_MINUTES` and `JWT_REFRESH_TOKEN_DAYS` in `.env`.

Logout requires an authenticated request and permanently blacklists the
supplied refresh token (simplejwt `token_blacklist`); refreshing with it then
fails with 401. Other sessions are unaffected. Outstanding access tokens stay
valid until their own short expiry — there is no access-token denylist.

### LLM streaming API

```text
POST /api/v1/llm/stream/      Bearer + {messages: [{role, content}], temperature?} → text/event-stream
```

Streams the completion as Server-Sent Events. Frames map onto the normalized
application events; every stream ends with exactly one terminal frame:

```text
event: start       data: {"model": "..."}
event: delta       data: {"text": "..."}
event: completed   data: {"text": "...", "model": "...", "delta_count": N}
event: error       data: {"error": "...", "retryable": true|false}
```

The server-side model chain (primary model plus configured fallbacks) always
decides which model serves a request — clients cannot pin a model. Responses
carry `Cache-Control: no-cache` and `X-Accel-Buffering: no` so intermediaries
do not buffer the stream.

### LLM model configuration

Server-mode models are configured entirely through the environment; no model
names are hard-coded in application code.

```text
OPENROUTER_API_KEY           server-side key (required in production, never sent to clients)
OPENROUTER_BASE_URL          OpenRouter API root (default https://openrouter.ai/api/v1)
LLM_PRIMARY_MODEL            model tried first ("vendor/model", OpenRouter catalog id)
LLM_FALLBACK_MODELS          comma-separated fallbacks, tried in order
LLM_REQUEST_TIMEOUT_SECONDS  per-request HTTP timeout (> 0)
```

The ordered chain (`LLM_PRIMARY_MODEL` followed by `LLM_FALLBACK_MODELS`) is
assembled by `backend/llm/config.py` (`load_model_configuration()`), which
strips names and drops blank/duplicate entries. Only retryable failures
(timeouts, transport errors, provider availability) move to the next model;
invalid configuration raises `ImproperlyConfigured` naming the offending
variable at startup. Valid catalog ids are listed at
https://openrouter.ai/api/v1/models.
