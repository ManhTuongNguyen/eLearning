# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 0 — Foundation (TASK-004 done)

## Current Active Task

None. Ready for next loop cycle.

## Archived Tasks

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
- No open issues. Next task: TASK-004 — Create Django application boundaries.
