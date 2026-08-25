# Current Loop Execution State

## Metadata
- **Last Run Timestamp**: 2026-08-26
- **Current Phase**: Phase 4 — LLM Infrastructure (TASK-024 next)

## Current Active Task

None. Ready for next loop cycle. Next task: TASK-024 — Implement LLM streaming service.

## Archived Tasks

### TASK-023 — Create backend model configuration (COMPLETED 2026-08-26)
- `backend/llm/config.py`: frozen `ModelConfiguration(api_key, base_url,
  timeout_seconds, primary_model, fallback_models)` + `model_chain` property
  (primary first) and module-level `load_model_configuration()` — the single
  place Django settings are read for LLM concerns. Normalization: model names
  stripped; blank/duplicate fallback entries and fallbacks equal to the
  primary dropped (order preserved); base_url stripped + trailing "/" removed;
  timeout cast to float. Validation raises ImproperlyConfigured naming the
  offending variable: blank LLM_PRIMARY_MODEL, blank OPENROUTER_BASE_URL,
  non-numeric/non-positive/non-finite LLM_REQUEST_TIMEOUT_SECONDS, missing
  setting attributes; missing OPENROUTER_API_KEY passes through "" in dev
  (production requirement enforced by validate_production_configuration).
  Logging "llm.config": debug line with primary + fallback count only.
- Refactor: `OpenRouterProvider.from_settings()` and
  `FallbackProvider.from_settings()` now build from `load_model_configuration()`
  — `django.conf.settings` no longer imported by any llm business module;
  FallbackProvider constructs its inner OpenRouterProvider directly from one
  config load (no double read). No behavior change otherwise.
- Tests backend/tests/test_llm_config.py (18): value assembly from documented
  settings, strip/dedupe rules incl. all-blank fallbacks → primary-only,
  empty-key dev passthrough, per-variable ImproperlyConfigured matrix,
  missing-setting sentinel path, provider wiring (OpenRouter default_model/
  timeout/base_url; Fallback full chain), source-level guards asserting no
  model-name fragments ("gpt|claude|gemini|llama|mistral|deepseek|qwen|grok")
  and no direct `settings.LLM_*`/`settings.OPENROUTER_*` access in llm/
  business modules, api key absent from config logs.
- test_fallback_provider.py: from_settings wiring test updated to patch
  `llm.fallback.load_model_configuration` + OpenRouterProvider constructor;
  DEFAULT_BASE_URL constant added locally.
- Docs: `.env.example` LLM section explains chain semantics/retryable-only
  fallback/catalog id format; README gained "LLM model configuration" section.
- Gates: ruff check/format clean; pytest 233 passed +31 subtests (Postgres);
  manage.py check clean.

## Archived Tasks

### TASK-022 — Implement OpenRouter model discovery (COMPLETED 2026-08-26)
- `llm/types.py`: frozen `ModelInfo(id, name="", description=None,
  context_length=None, created=None)` — normalized provider-agnostic catalog
  entry; blank id rejected; exported via `__all__`.
- `llm/openrouter.py`: `OpenRouterProvider.list_models() -> tuple[ModelInfo, ...]`
  — GET `/models` (MODELS_PATH) with the same Authorization header. Reuses
  `_http_failure`/timeout/transport normalization with model=None (helper
  annotations widened to `str | None`). 200 body must contain a `data` list or
  LLMResponseError ("no data list"; non-object JSON handled by shared parser).
  Entries parsed defensively via module-level `_parse_model_entry` +
  `_int_or_none` (bool rejected as int subclass): non-dict entries and
  blank/non-string ids are skipped, id stripped, missing name coerced to "".
  Catalog order preserved; malformed entries never fail the whole listing.
  Logging "llm.openrouter": info count/skipped/duration on success, warning
  status on failure — never payloads or secrets.
- Design decision: `list_models()` is an OpenRouterProvider capability method,
  NOT on the LLMProvider ABC — completion-interface fakes/mocks elsewhere stay
  trivial; consumers depend only on `llm.types.ModelInfo`.
- Tests: test_openrouter_client.py +13 tests +5 subtests (request shape GET/
  URL/auth, full+minimal normalization, order preservation, id stripping,
  malformed-entry skipping incl. boolean context_length, empty catalog,
  missing/non-list data, non-object JSON, status matrix for /models asserting
  model=None, timeout+transport retryable, key absent from results/errors/
  logs). test_llm_provider.py +3 ModelInfoTests (defaults, blank-id rejection,
  frozen).
- Gates: ruff check/format clean; pytest 215 passed +31 subtests (Postgres);
  manage.py check clean.

## Archived Tasks

### TASK-021 — Implement model fallback (COMPLETED 2026-08-26)
- `backend/llm/fallback.py`: FallbackProvider(LLMProvider) decorating ONE inner
  provider with an ordered model chain (primary first). complete() retries the
  next chain entry only on `LLMError.retryable` failures (transport/timeout/
  availability); auth/bad-request/response errors raise immediately (a
  different model cannot fix them). All-fail → aggregate LLMAvailabilityError
  "all N configured model(s) failed: <model>: <msg>; ..." chained from the
  last error, retryable=True so callers above may still retry.
- stream(): falls back ONLY while probing for the first event (`next()` opens
  the HTTP request + status check in OpenRouterProvider's lazy generator).
  Once any event is emitted the attempt is committed — mid-stream failures
  propagate unchanged (restarting would duplicate already-consumed text).
  StopIteration during probe → LLMResponseError (contract violation,
  non-retryable).
- Explicit `request.model` pin replaces the whole chain for a single attempt
  (pinned intent wins); a pinned retryable failure still normalizes into the
  aggregate availability error. Chain models are stripped/validated non-blank;
  request shape (messages/temperature) preserved per attempt via
  dataclasses.replace.
- Lifecycle: close() delegates to inner provider when it offers one (duck-
  typed; no-op otherwise), context-manager supported; from_settings() builds
  OpenRouterProvider.from_settings() with chain [LLM_PRIMARY_MODEL,
  *LLM_FALLBACK_MODELS]. Logging via "llm.fallback": warning per failed
  attempt/exhaustion, info on fallback success (never logs payloads).
- Tests backend/tests/test_fallback_provider.py (23 tests + 7 subtests) on
  scripted fakes (no HTTP): construction validation/stripping, primary
  passthrough, retryable-class matrix triggers fallback, non-retryable matrix
  aborts with identical exception instance, 3-model ordering, all-fail
  aggregate content + __cause__, single-model normalization, request-shape
  preservation, pin bypass (complete+stream), stream probe fallback /
  mid-stream no-fallback / non-retryable probe / aggregate, close delegation +
  context manager + close-less inner, from_settings wiring.
- Gotchas: test-side walrus-in-dict-literal SyntaxError fixed by hoisting
  RESPONSE_C; pinned single-attempt exhaustion raises the aggregate error too
  (consistent rule: any exhausted chain → normalized availability error).
- Gates: ruff check/format clean; pytest 200 passed (Postgres); manage.py
  check clean.

### TASK-020 — Implement OpenRouter client (COMPLETED 2026-08-26)
- `httpx` 0.28.1 added via uv (sync client, streaming, timeout support;
  MockTransport gives clean mocked-HTTP tests).
- `backend/llm/openrouter.py`: OpenRouterProvider(LLMProvider) — POST
  /chat/completions with {model, messages, stream, temperature?}. Constructor
  takes api_key/default_model/base_url/timeout (+ optional injected
  httpx.Client; provider only closes clients it owns; context-manager
  supported). `from_settings()` classmethod wires Django settings
  (OPENROUTER_API_KEY/BASE_URL, LLM_PRIMARY_MODEL, LLM_REQUEST_TIMEOUT_SECONDS)
  — factory/DI wiring for services stays with later tasks.
- complete(): parses text/model/finish_reason/request_id (x-request-id header
  preferred, body `id` fallback); malformed 200s (missing choices, non-str
  content, bad JSON) → LLMResponseError. stream(): SSE parser ignores blank
  lines + ": keep-alive" comments, stops at [DONE]; StreamStart emitted on
  first chunk with the server-served model (falls back to requested model if
  chunks lack one), empty deltas and usage-only chunks skipped; zero-chunk
  stream → LLMResponseError.
- Error normalization: 401/403→LLMAuthenticationError, 400/404/413/422→
  LLMBadRequestError, 408→LLMTimeoutError, 429+5xx→LLMAvailabilityError,
  other→LLMResponseError; httpx.TimeoutException→LLMTimeoutError,
  other httpx.HTTPError→LLMRequestError (both retryable). Server error
  messages extracted ({error:{message}} / {message} / raw snippet) and
  truncated to 300 chars.
- Secret hygiene: key lives only in the Authorization header — never in
  payloads, exception messages, or logs. Logging via "llm.openrouter":
  info on success (model/request_id/duration/counts), warning on failure
  (status/type names only).
- Tests backend/tests/test_openrouter_client.py (33 tests + 19 subtests):
  constructor validation + client ownership, payload/header shape, model
  override & temperature forwarding, request-id precedence, malformed-response
  matrix, full status-mapping matrix, error-body variants (OpenRouter JSON /
  plain text / truncation), transport failures, stream success (incremental
  Start→Deltas, keep-alive handling, empty-delta skipping, model fallback),
  stream failures (error status, malformed data line, unexpected SSE line,
  empty stream, mid-stream ReadError preserving partial deltas, mid-stream
  timeout), secret-hygiene (errors/payloads/logs never contain the key),
  from_settings wiring.
- Gotcha: test-injected httpx.Client MUST carry base_url when the provider
  posts relative paths — a bare Client(transport=...) makes "/chat/completions"
  an invalid URL inside cookie extraction.
- Gates: ruff check/format clean; pytest 177 passed (Postgres); manage.py
  check clean.

### TASK-019 — Create LLM provider interface (COMPLETED 2026-08-26)
- `backend/llm/types.py`: frozen dataclasses Message (role Literal
  system/user/assistant + non-blank content), CompletionRequest (tuple-
  normalized messages, optional model override, temperature validated to
  0.0–2.0, from_texts helper), CompletionResponse (text, model, finish_reason,
  request_id), StreamStart(model) + StreamDelta(non-empty text) with
  StreamEvent union. No vendor specifics.
- `backend/llm/exceptions.py`: normalized hierarchy under LLMError(message,
  provider, model, retryable) with __str__ "provider [model]: message";
  LLMRequestError→LLMTimeoutError + LLMAuthenticationError / LLMBadRequest /
  LLMAvailabilityError / LLMResponseError; retryable defaults: transport/
  timeout/availability True, auth/bad-request/response False.
- `backend/llm/provider.py`: LLMProvider ABC with complete() and stream()
  returning Iterator[StreamEvent]; docstring contract: first event
  StreamStart, exhaustion = success, failures raise LLMError subclasses.
  Zero HTTP/vendor imports (OpenRouter client is TASK-020; no factory yet —
  DI at service construction, wiring in TASK-020/023).
- Tests backend/tests/test_llm_provider.py (21): role/content validation,
  frozen types, request normalization (list→tuple, empty rejected, model/
  temperature bounds), response defaults, empty-delta rejection, ABC cannot
  instantiate (incl. partial impl), consumer function runs against Fake +
  Mock(spec=LLMProvider) proving mockability, incremental stream consumption
  with delta accumulation, mid-stream LLMError propagates after deltas,
  exception retryable-defaults matrix, and a source-level guard asserting the
  three abstraction modules import no httpx/requests/urllib/socket/openrouter.
- Gates: ruff check/format clean; pytest 144 passed (Postgres); manage.py
  check clean.
- Design note: errors are raised rather than yielded from stream(); SSE layer
  (TASK-025) will map exceptions to error events. StreamStart carries the
  resolved model so TASK-021 fallback attribution needs no interface change.

### TASK-018 — Create mobile learning-level screen (COMPLETED 2026-08-26)
- `src/api/profile.ts`: EnglishLevel union ('A1'..'C2'|'AUTO'), LEVELS metadata
  (label + short description per level), getProfile(token) → GET and
  updateProfile(token, level) → PATCH /api/v1/profile/.
- AuthContext: added async `getAccessToken()` that awaits initial session
  restore before reading tokensRef. Gotcha: child effects run BEFORE parent
  effects in React, so a screen mounted alongside a fresh provider would read
  null mid-restore; a deferred promise resolves at the end of restore() (also
  on unmount, so callers never hang).
- New LevelScreen: header with back button, all 7 levels as radio rows with
  CEFR descriptors; loads current level on mount (loading indicator), tap →
  PATCH with busy guard (rows disabled while saving, spinner on saving row),
  success shows "Saved." + server-confirmed selection, failure keeps last
  confirmed selection + role="alert" error (levels stay selectable so a failed
  GET doesn't block saving). accessibilityRole="radio" +
  accessibilityState.checked.
- Wiring: App.tsx authenticated branch toggles HomeScreen ↔ LevelScreen;
  HomeScreen gained optional onOpenLevels prop rendering a blue "Learning
  level" button (testID home-open-levels).
- Tests: __tests__/LevelScreen.test.tsx (6): all levels listed + GET called,
  server level preselected, PATCH persists new selection, save failure keeps
  confirmed selection + surfaces field error, GET failure still allows saving,
  back invokes callback. App.test.tsx (+1): home → level screen → back.
  Gotcha: jest automock strips module constants — profile API must be mocked
  with a factory spreading requireActual so LEVELS survives.
- Gates: pnpm lint / typecheck clean; jest 36 passed (7 suites).
- Live verification (existing emulator + Metro, no rebuild needed — JS-only):
  register smoke_t18 via curl → app login → Home → Learning level: all 7 rows,
  AUTO checked (server default) → tap B2 → checked + "Saved." → backend GET
  /profile/ confirms {"level":"B2"} → back returns to Home. Smoke user's child
  rows deleted first (see TASK-017 gotcha), then user; app uninstalled.

### TASK-017 — Create learning profile API (COMPLETED 2026-08-26)
- `GET/PATCH /api/v1/profile/` in learning app: ProfileView (APIView,
  IsAuthenticated) + ProfileSerializer (ModelSerializer, fields=["level"];
  choices-generated field rejects anything outside A1..C2/AUTO — wrong case
  and blank included → clean DRF 400).
- Lazy provisioning: both GET and PATCH run
  `Profile.objects.get_or_create(user=request.user)`, so a fresh user can
  read their profile immediately; model default AUTO applies until updated.
  PATCH on missing profile creates then validates.
- Unknown payload fields ignored (only "level" declared → "user" tampering
  is a no-op); POST/PUT/DELETE → 405.
- learning/urls.py (`app_name="learning"`, name "profile") included under
  `/api/v1/` in config/urls.py.
- New tests backend/tests/test_profile_api.py (21): anonymous GET/PATCH → 401,
  GET auto-provisions AUTO + no duplicates across reads, persisted level
  returned, PATCH updates+persists, all 7 documented levels accepted,
  invalid/wrong-case/blank → 400 with level unchanged, unknown fields
  ignored, cross-user isolation, unsupported methods → 405.
- Gates: ruff check/format clean; pytest 123 passed (Postgres); manage.py
  check clean.
- Live verification (bind-mounted compose backend, no rebuild): register →
  GET {"level":"AUTO"} 200 → PATCH B2 200 → PATCH Z9 400 choice error → GET
  B2 → anonymous 401. Smoke user deleted afterwards.
- Gotcha (expected Django behavior, not a bug): DB-level FKs are plain
  DEFERRABLE constraints — CASCADE lives in the ORM collector, so raw-SQL
  user deletes must remove child rows (learning_profile,
  token_blacklist_outstandingtoken) first.

### TASK-016 — Create learning profile model (COMPLETED 2026-08-26)
- `learning.Level` TextChoices: A1/A2/B1/B2/C1/C2 + AUTO (labels include
  CEFR descriptors; AUTO = "let AI decide").
- `learning.Profile`: OneToOneField(settings.AUTH_USER_MODEL, CASCADE,
  related_name="learning_profile") + level CharField(max_length=4, choices,
  default=AUTO). No extra fields — SPEC lists `level` only; expansion later.
- learning/admin.py: ProfileAdmin with list_display/list_filter/search.
- Migration learning/0001_initial created AND applied to live Postgres from
  host (`POSTGRES_PASSWORD=change-me manage.py migrate learning`) so the
  compose backend picks it up without rebuild.
- New tests backend/tests/test_profile.py (12): default AUTO, all 7 levels
  persist round-trip, __str__, duplicate-profile IntegrityError, related-name
  access, user-delete cascade, distinct-user independence, invalid/blank
  level + missing user via full_clean, exact choice-set assertion,
  field-shape assertions (CharField + max_length + choices).
- Gates: ruff check/format clean; pytest 102 passed (Postgres); manage.py
  check clean.

### TASK-015 — Implement mobile authentication flow (COMPLETED 2026-08-26)
- `react-native-keychain` ^10 added (pnpm); autolinked into debug APK
  (`com.oblador.keychain` classes verified inside APK). Tokens are stored as a
  JSON blob via setGenericPassword under service `com.elearningmobile.auth` —
  never AsyncStorage.
- New structure `mobile/src/`: `config.ts` (API_BASE_URL =
  http://10.0.2.2:8000 emulator→host alias), `auth/tokens.ts`,
  `auth/secureStorage.ts` (save/load/clear; corrupted/partial payloads → null),
  `api/client.ts` (fetch wrapper + ApiError normalizing DRF `{detail}` and
  field-error shapes; network failure → status 0 friendly message),
  `api/auth.ts` (register/login/refresh/me/logout bindings matching backend
  response shapes), `auth/AuthContext.tsx`.
- AuthContext: restore-on-start via /me with single refresh-token fallback
  (both fail → clearTokens → unauthenticated); login stores tokens + user;
  register auto-logs-in with submitted credentials; logout is best-effort
  server invalidation + unconditional local clear. Errors surfaced via
  `error` state; `busy` guards double submits.
- Screens: LoginScreen / RegisterScreen / HomeScreen (+ SplashScreen);
  state-based switching in App.tsx RootNavigator (react-navigation deferred to
  TASK-043). Minimal neutral styling; full theme system remains TASK-044.
- Backend tweak needed by live testing: DisallowedHost for emulator Host
  header → DEBUG-mode default now appends `10.0.2.2`; compose default and
  .env.example updated too. (Production unaffected — DJANGO_ALLOWED_HOSTS must
  be set explicitly.)
- Jest/RNTL gotcha: RNTL v14 render() is async (screen binding) AND
  fireEvent.* returns a promise that must be awaited or state assertions read
  stale trees. All interactions awaited.
- Tests: 29 passing across secureStorage(5), apiClient(5), AuthContext(8),
  LoginScreen(3), RegisterScreen(4), App flow(3+1). Keychain mocked globally
  in jest.setup.js with in-memory store.
- Gates: pnpm lint/typecheck/test green; gradlew assembleDebug SUCCESS;
  backend ruff check/format + manage.py check + pytest 90 passed.
- Live verification on headless emulator (AVD elearning, Metro via adb
  reverse): register smoke_t15 → auto-login Home; force-stop + relaunch →
  session restored ("Welcome, smoke_t15"); logout → backend logged POST
  /auth/logout/ 200 (refresh blacklisted), UI back to login; re-login via
  username OK. Smoke user deleted, app uninstalled afterwards.

### TASK-014 — Implement logout (COMPLETED 2026-08-26)
- `rest_framework_simplejwt.token_blacklist` added to INSTALLED_APPS; its
  bundled migrations applied to dev Postgres automatically at compose backend
  boot (no project-level migration needed).
- `POST /api/v1/auth/logout/` in accounts app (name "logout"), authenticated
  via default IsAuthenticated (like MeView). Body {refresh}: LogoutSerializer
  parses the token with RefreshToken(token) during validation — garbage,
  wrong-type (access), expired, blank or already-blacklisted tokens all map to
  a clean 400 field error instead of an unhandled 500 (TokenError must be
  caught explicitly). View then calls token.blacklist() → 200 {"detail":
  "Logged out."}.
- Invalidation semantics: blacklisted refresh token fails /auth/refresh/ with
  401 (simplejwt verify() checks the blacklist); other sessions' refresh
  tokens unaffected; outstanding access tokens stay valid until their short
  expiry (no access-token denylist — documented MVP strategy).
- New tests backend/tests/test_logout.py (14): success + blacklist row
  persisted, refresh rejected afterwards, access token still authenticates
  /me, sibling session unaffected, anonymous → 401, missing/blank/garbage/
  access-as-refresh/expired/already-blacklisted → 400, GET → 405, full
  login→use→logout→refresh-rejected lifecycle.
- Gates: ruff check/format clean; pytest 90 passed (Postgres) / 87+3 skips
  (sqlite fallback); manage.py check clean.
- Live verification (compose backend restarted for migrations): register →
  login → refresh 200 → logout 200 → refresh 401 → anonymous logout 401.
  Throwaway smoke user deleted afterwards.

### TASK-013 — Implement JWT authentication (COMPLETED 2026-08-26)
- `djangorestframework-simplejwt` 5.5.1 (+ pyjwt) added via uv.
- settings.py: SIMPLE_JWT with ACCESS_TOKEN_LIFETIME / REFRESH_TOKEN_LIFETIME
  derived from existing env vars (JWT_ACCESS_TOKEN_MINUTES=15,
  JWT_REFRESH_TOKEN_DAYS=7). DRF DEFAULT_AUTHENTICATION_CLASSES →
  JWTAuthentication; DEFAULT_PERMISSION_CLASSES → IsAuthenticated (secure by
  default; register/login/refresh/health opt out via AllowAny, which they
  already declared).
- Endpoints in accounts app: `POST /api/v1/auth/login/` (LoginView),
  `POST /api/v1/auth/refresh/` (TokenRefreshView), `GET /api/v1/auth/me/`
  (MeView, IsAuthenticated → current user id/username/email).
- LoginSerializer subclasses TokenObtainPairSerializer: authenticate with the
  submitted identifier as username first; if it contains "@" and failed, resolve
  account by case-insensitive email and retry with its username. Returns
  {access, refresh, user}. Gotcha: raising ValidationError yields HTTP 400 for
  bad credentials; must raise InvalidToken to get proper 401 + Bearer header.
- No blacklist app yet — token invalidation is TASK-014 (logout).
- New tests backend/tests/test_auth.py (15): login via username/mixed-case
  email, tokens authenticate /me, no password echo; wrong password/unknown/
  inactive → 401; missing fields → 400; refresh happy path + garbage token +
  access-token-as-refresh → 401; expired AccessToken (set_exp backdated) → 401;
  tampered signature → 401; anonymous /me → 401 with WWW-Authenticate: Bearer
  (realm suffix asserted via startswith); public endpoints stay open;
  SIMPLE_JWT lifetimes derive from env settings.
- Gates: ruff check/format clean; pytest 76 passed (Postgres) / 73+3 skips
  (sqlite fallback); manage.py check clean.
- Live verification (rebuilt compose backend image for new dep): register 201 →
  login (username AND mixed-case email) → /me 200 with access, 401 without →
  refresh issues working new access. Throwaway smoke user deleted afterwards.

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
- Mobile emulator flow: start Metro with `CI=true pnpm exec react-native start`
  (interactive mode crashes headless) and `adb reverse tcp:8081 tcp:8081`;
  debug APK needs Metro. AVD `elearning` boots headless in ~2 min.
- Headless UI driving works well: RN testIDs appear as uiautomator
  resource-id; dump via `adb shell uiautomator dump /sdcard/ui.xml` + pull,
  then `adb shell input tap` on bounds centers.
- No open issues. Next task: TASK-024 — Implement LLM streaming service
  (Phase 4): application-service-layer streaming with normalized events,
  incremental consumption, clean error termination, and no falsely-complete
  assistant messages.
- Running `make quality` against Postgres from the host requires
  `POSTGRES_PASSWORD=change-me` (or a root .env) since compose owns credentials.
  Compose services up and healthy; backend restarted with token_blacklist
  migrations applied.
- Note: `make quality` output can render oddly in this shell (truncated);
  run gates individually if in doubt. README's compose path is the repo-root
  `docker-compose.yml` (not docker/docker-compose.yml).
- Local-only artifacts (not committed, not required by repo): `~/.jdks/jdk-21.0.12.1+1`,
  `~/Android/Sdk/cmdline-tools/latest`, system image android-35 google_apis x86_64,
  AVD `elearning`.
