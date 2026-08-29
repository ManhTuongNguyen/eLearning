<div align="right">

**English** | [Tiếng Việt](README.vi.md)

</div>

# English Learning Chat

A mobile application for learning English through natural AI conversation, built as a ChatGPT-style chat experience with features designed for language learners.

## Development

This project was completed end-to-end by an **Autonomous Agent Loop** (Loop Engineering): [opencode](https://opencode.ai) running the `ox-alpha` (GLM 5.3 flash) model executed the backlog without step-by-step human prompting. A shell loop re-invokes the agent indefinitely; the agent itself decides what to do next by reading tracked state files. This section documents the full flow so you can replicate it on any project — and how to run, test and use what the loop built.

### Project navigation

| File | Role |
| --- | --- |
| [`ROADMAP.md`](ROADMAP.md) | Product and architecture goals — the target state |
| [`SPEC.md`](SPEC.md) | Executable backlog — ordered tasks with acceptance criteria |
| [`STATE.md`](STATE.md) | Live loop execution state — where the agent is right now |
| [`prompts/PROMPT_LOOP_TASKS.md`](prompts/PROMPT_LOOP_TASKS.md) | The single prompt the loop feeds the agent every cycle |
| [`run-loop.sh`](run-loop.sh) | The `while (true)` driver that keeps the agent running |

### How it works — the agentic loop

A Loop Engineering workflow that needs no intermittent prompting works like a self-contained REPL (Read-Eval-Print Loop):

1. **Read** — the agent reads `STATE.md` to know where it is, reads `SPEC.md` to pick the next task, and checks `ROADMAP.md` when it needs orientation.
2. **Execute** — it performs the work: writes code, runs tests, fixes errors.
3. **Eval** — it evaluates the result of the execution: do the tests pass or fail?
4. **Update State** — it writes the fresh information back into `STATE.md` and marks the completed task in `SPEC.md`.
5. **Repeat** — the outer `while (true)` loop keeps invoking the agent with the same base call: *"Read STATE.md and perform the next step."*

```text
while true:                        # run-loop.sh
    Read     → STATE.md, SPEC.md, ROADMAP.md   # where am I? what is next?
    Execute  → code, tests, fixes
    Eval     → quality gates pass?
    Update   → STATE.md + SPEC.md + git commit
    Repeat   → until SPEC.md has no uncompleted task left
```

### Why it works — fault tolerance

The standout property of this model is **fault tolerance**. If the agent crashes, the API quota runs out, or the process is interrupted abruptly, you simply restart the loop: the agent re-reads `STATE.md` and continues the work exactly where it stopped — no lost context, no redoing work from the beginning. `run-loop.sh` automates this for transient failures: a non-zero agent exit is logged and retried after 30 seconds.

Further properties:

- **Zero intermittent prompting** — one static prompt drives hundreds of tasks; humans set goals, not steps.
- **Context persistence** — `STATE.md` carries execution context across cycles, surviving crashes and context-window resets.
- **Self-verifying progress** — every task ships acceptance criteria and quality gates; the loop cannot mark work done while tests fail.
- **Auditability** — per-task git commits (`feat: complete TASK-XXX`), checkboxes in `SPEC.md` and timestamps in `STATE.md` form a complete execution trail.
- **Agent-agnostic** — the protocol is just files plus a prompt; any CLI coding agent can replace opencode without changing the loop.
- **Incremental delivery** — the repository is shippable at any phase boundary, not only at the end.

### The result — what the loop delivered

The loop executed `TASK-001` → `TASK-120` and produced a complete, working application: every feature in this README — both server and serverless modes, JWT auth, SSE streaming, conversation memory, the vocabulary pipeline with Celery enrichment, Anki export, TTS — implemented, tested and audited without a single manual prompt.

The closing `TASK-120` MVP audit verified all 24 `ROADMAP.md` MVP requirements and every quality gate. The exact outcome is recorded in `STATE.md` at commit `bb70fdc` (`feat: complete TASK-120`) — check out that commit to see the full audit log:

| Suite | Result |
| --- | --- |
| Backend tests — `uv run pytest` | **1040 passed** (+293 subtests) |
| Backend lint/format — `ruff check`, `ruff format --check` | clean (125 files) |
| Backend system checks — `python manage.py check` | no issues |
| Mobile tests — `pnpm test` | **614 passed** across 50 Jest suites |
| Mobile lint — `pnpm lint` | clean |
| Mobile typecheck — `pnpm typecheck` (strict) | clean |
| `docker compose up --build` | stack starts healthy |
| Android build — `assembleDebug` | succeeds |

### The flow from zero to completion

#### Step 1 — Generate `ROADMAP.md` and `SPEC.md` with another AI

Use a separate AI session (a strong reasoning model) to author the two planning files, then add navigation links to them in your project README (the table above serves this role in this repository):

- `ROADMAP.md` — the project goal: product scope, architecture, modes, constraints, and the rule that the agent must not need extra human decisions for routine engineering choices. See [`ROADMAP.md`](ROADMAP.md).
- `SPEC.md` — the executable backlog: split the roadmap into an ordered list of tasks, each with a ``Status: `[ ]` `` marker and explicit acceptance criteria. Open with an "Instructions for the Autonomous Coding Agent" preamble so the backlog is self-describing. See [`SPEC.md`](SPEC.md).

> **Review both files line by line before running the loop — this is the single most important human checkpoint of the whole flow.** The agent never asks you anything: whatever these files say about the tech stack, languages, frameworks, package managers and versions, libraries and dependencies, directory structure, coding conventions and quality gates becomes the final project, exactly as written. A wrong decision here (the wrong database, an unmaintained package, a structure that fights your deployment target) is built faithfully across a hundred tasks and is expensive to undo afterwards. Iterate with the AI until every technical choice is what you actually want, then freeze the files.

#### Step 2 — Initialize `STATE.md`

The loop's memory. Create it before the first run with the first task pre-broken down (the agent rewrites it every cycle; you only edit it to clear blockers):

```markdown
# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 0 — Foundation

## Current Active Task
- **Task ID**: TASK-001 — Initialize repository structure
- **Sub-steps**:
  - [ ] Create folder structure (backend, mobile, docker, docs)
  - [ ] Initialize .gitignore and .env.example
  - [ ] Create root README.md
- **Status**: IN_PROGRESS

## Unhandled Errors
- (Only record errors or context BLOCKING the current Task. Leave blank if none)
```

#### Step 3 — Write the loop prompt and `run-loop.sh`

The prompt is the only instruction the agent receives each cycle — [`prompts/PROMPT_LOOP_TASKS.md`](prompts/PROMPT_LOOP_TASKS.md):

```markdown
Execution Rules:
1. READ 'STATE.md' FIRST to recall previous execution context, active sub-steps, or unhandled errors.
2. READ 'ROADMAP.md' ONLY to understand high-level phase trajectory and context.
3. READ 'SPEC.md' to find the FIRST uncompleted task (marked Status: `[ ]`).
4. If 'STATE.md' has NO active sub-steps, BREAK DOWN the selected task from SPEC.md into small sub-steps inside 'STATE.md' under '## Current Active Task'.
5. Execute the current sub-step and run test/quality checks (Ruff, pytest, pnpm, etc.).
6. IMMEDIATELY UPDATE 'STATE.md': Mark the completed sub-step as [x] right after finishing it before moving to the next sub-step.
7. Fix any errors or test failures encountered.
8. ONLY WHEN ALL sub-steps and acceptance criteria pass:
   - Change Status: `[ ]` to Status: `[x]` in 'SPEC.md'.
   - UPDATE 'STATE.md': Advance 'Current Phase' in Metadata, and SET '## Current Active Task' strictly to this exact text:
     - **Task ID**:
     - **Sub-steps**:
     - [ ]
     - **Status**: Empty
   - Commit code changes to git with message 'feat: complete TASK-XXX'.
```

The driver script — write `run-loop.sh` and make it executable (`chmod +x run-loop.sh`):

```bash
#!/bin/bash

trap "echo -e '\n🛑 Loop execution stopped by user.'; exit" INT TERM

echo "🚀 Starting Autonomous Loop Engineering with STATE tracking..."

while true; do
  REMAINING_TASKS=$(grep -c "Status: \`\[ \]\`" SPEC.md)

  if [ "$REMAINING_TASKS" -eq 0 ]; then
    echo "=================================================================="
    echo "🎉 ALL TASKS COMPLETED IN SPEC.md!"
    echo "🏁 Autonomous Loop is exiting successfully."
    echo "=================================================================="
    break
  fi

  echo "=================================================================="
  echo "🔄 Starting Loop Cycle at: $(date) | Remaining Tasks: $REMAINING_TASKS"
  echo "=================================================================="

  opencode run "$(cat prompts/PROMPT_LOOP_TASKS.md)" --dangerously-skip-permissions

  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "⚠️ Agent exited with code $EXIT_CODE (Network/Token limit). Retrying in 30 seconds..."
    sleep 30
  else
    echo "✅ Cycle step completed. Moving to next in 5 seconds..."
    sleep 5
  fi
done
```

The `grep` target and the prompt file are the only two knobs — point them at any backlog to reuse the loop (this repository drives its post-completion feedback backlog in `POST_COMPLETION_FEEDBACK_V1.md` the same way).

##### Safety — `--dangerously-skip-permissions`

This project runs the loop with opencode's `--dangerously-skip-permissions` flag. Without it, the agent stops and asks for confirmation before every shell command or file write — which defeats an unattended loop. The flag trades permission gates for autonomy, so follow these best practices:

- **Run inside a sandbox.** Execute the loop in an isolated container, VM or devcontainer with only the project directory mounted, so a bad command cannot damage anything outside the repository.
- **Use a dedicated git branch and commit often.** The loop commits after each task, giving per-task rollback points via `git revert` / `git reset`; push to a remote for off-machine backup.
- **Scope credentials.** Keep only the keys the loop needs in `.env` — ideally a dedicated LLM API key with a spend limit. Never commit secrets, and treat `.env` as readable by the agent.
- **Cap the blast radius.** Run tests against ephemeral databases (as this repo's pytest setup does), avoid granting the Docker socket unless required, and pin dependency versions.
- **Supervise, don't babysit.** Check `git log`, `STATE.md` and the remaining-task counter periodically. `Ctrl+C` stops the loop cleanly at any time; restart it and it resumes from `STATE.md`.

#### Step 4 — Configure the model

This project configures the model through `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.schema.json",
  "model": "9router/ox-alpha"
}
```

`ox-alpha` (GLM 5.3 flash) is the model that completed this repository. Adapt the configuration to your agent:

- **opencode** — set `model` to your `provider/model` id and authenticate the provider (see the [opencode configuration docs](https://opencode.ai/docs/config/)).
- **Other agents** (Claude Code, Codex CLI, Aider, …) — use that tool's own config mechanism and replace the `opencode run …` line in `run-loop.sh` with the equivalent headless/non-interactive invocation. The loop mechanics (`STATE.md` / `SPEC.md` / prompt) are agent-agnostic.

Choose a model that reliably follows the execution rules and runs the tests. The loop invokes it hundreds of times, so speed and cost matter — a fast model such as GLM 5.3 flash is a good fit.

#### Step 5 — Run the loop until the project is complete

```bash
./run-loop.sh
```

Every cycle the agent reads `STATE.md`, picks the next uncompleted `SPEC.md` task, implements it, runs the quality gates, updates `STATE.md`, marks the task `[x]` in `SPEC.md` and commits. The shell loop keeps re-invoking the agent until `grep` finds no uncompleted ``Status: `[ ]` `` marker left in `SPEC.md`, then exits — the project is complete. Track progress via `git log`, `STATE.md` and the remaining-task counter printed each cycle.

#### Loop requirements — the prompt must fit `SPEC.md`

For the loop to run unattended, the prompt in `prompts/PROMPT_LOOP_TASKS.md` must fit `SPEC.md` exactly:

- **Status marker must match.** Rule 3 of the prompt and the script's task counter both depend on the exact ``Status: `[ ]` `` convention — if you change the marker or the file names, update the prompt and the script together.
- **Task IDs and phases must be stable.** The prompt advances "Current Phase" and commits `feat: complete TASK-XXX`, so `SPEC.md` must use consistent `TASK-XXX` ids grouped into phases.
- **Tasks must be small enough for one cycle.** One task per agent invocation, with acceptance criteria verifiable by automated tests and quality gates.
- **Quality gates must be non-interactive.** `pytest`, `ruff`, `pnpm test`, … must run without prompts, TTYs or interactive logins.
- **`ROADMAP.md` is context, not backlog.** The agent reads it only for orientation; every actionable requirement must live in a `SPEC.md` task.
- **Git repo initialized and `.env` ignored.** The loop commits after each task, so start from a clean repository with secrets excluded by `.gitignore`.

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
LLM_PROVIDER                 provider integration: openrouter | gemini | openai | ninerouter | openai-compatible (default openrouter)
<PROVIDER>_API_KEY           server-side key of the selected provider (required in production, never sent to clients)
<PROVIDER>_BASE_URL          provider API root (optional; every provider has a default except openai-compatible)
LLM_PRIMARY_MODEL            model tried first (an id from the configured provider's catalog)
LLM_FALLBACK_MODELS          comma-separated fallbacks, tried in order
LLM_REQUEST_TIMEOUT_SECONDS  per-request HTTP timeout (> 0)
```

Switching provider is a configuration change (`LLM_PROVIDER`), never a code
change (`backend/llm/registry.py`). The ordered chain (`LLM_PRIMARY_MODEL`
followed by `LLM_FALLBACK_MODELS`) is assembled by `backend/llm/config.py`
(`load_model_configuration()`), which strips names and drops blank/duplicate
entries. Only retryable failures (timeouts, transport errors, provider
availability) move to the next model; invalid configuration raises
`ImproperlyConfigured` naming the offending variable at startup. Model ids
follow the configured provider's catalog (for OpenRouter: `vendor/model`,
listed at https://openrouter.ai/api/v1/models).

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
- Multi-provider LLM support (OpenRouter, Google Gemini, OpenAI, 9Router, OpenAI-compatible) with ordered model fallback

## Architecture

```text
Server mode:
React Native → HTTPS → Django REST API → PostgreSQL / Redis / Celery → LLM provider (selected by `LLM_PROVIDER`)

Serverless mode:
React Native → Local SQLite + LLM provider directly (user-selected provider and key)
```

| Directory | Purpose |
| --- | --- |
| `backend/` | Django 6.x REST API, Celery workers, LLM provider abstraction |
| `mobile/` | React Native (TypeScript) application |
| `docker/` | Backend Docker image definition (referenced by the root `docker-compose.yml`) |
| `docs/` | Architecture notes and documentation |

A detailed walkthrough of the system — modes, LLM provider abstraction,
streaming, conversation memory, Celery and the vocabulary enrichment flow —
lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The server-mode REST
API reference — endpoints, request/response behavior, SSE frames and the
standard error format — lives in [`docs/API.md`](docs/API.md).

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
| `LLM_PROVIDER` | Server-side provider integration: `openrouter` (default), `gemini`, `openai`, `ninerouter`, `openai-compatible` |
| `<PROVIDER>_API_KEY` / `<PROVIDER>_BASE_URL` | Credentials of the selected provider (e.g. `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) — never sent to the mobile application |
| `LLM_PRIMARY_MODEL` / `LLM_FALLBACK_MODELS` | Server-mode model chain (see [LLM model configuration](#llm-model-configuration)) |
| `JWT_*` | Access/refresh token lifetimes |

The mobile app has its own environment file — copy `mobile/.env.example` to `mobile/.env` and set `API_BASE_URL` (the backend base URL; `http://10.0.2.2:8000` on the Android emulator). Mode-specific files (`.env.development` / `.env.test` / `.env.production`) override it per build type, values are inlined at build time, and a missing `API_BASE_URL` fails the bundle. Serverless provider settings (provider, API key, primary/fallback models) are configured in the app (Settings → provider settings; the key is stored in secure device storage).
