# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 2 — Authentication (TASK-013 next)

## Current Active Task

None. Ready for next loop cycle.

## Archived Tasks

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
- No open issues. Next task: TASK-013 — Implement JWT authentication (Phase 2).
  Settings already expose JWT_ACCESS_TOKEN_MINUTES / JWT_REFRESH_TOKEN_DAYS;
  a JWT library (e.g. djangorestframework-simplejwt) will need to be added.
- Running `make quality` against Postgres from the host requires
  `POSTGRES_PASSWORD=change-me` (or a root .env) since compose owns credentials.
  Compose services currently up and healthy.
- Local-only artifacts (not committed, not required by repo): `~/.jdks/jdk-21.0.12.1+1`,
  `~/Android/Sdk/cmdline-tools/latest`, system image android-35 google_apis x86_64,
  AVD `elearning`.
