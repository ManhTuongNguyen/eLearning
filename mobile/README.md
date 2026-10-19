# eLearning Mobile

React Native (TypeScript) application for the English Learning Chat project.

- **React Native 0.81** with the **New Architecture** enabled (`newArchEnabled=true` in `android/gradle.properties`)
- **Hermes** JS engine
- **pnpm** with `node-linker=hoisted` (`.npmrc`) for React Native compatibility
- No Expo dependency
- Android module name: `com.elearningmobile`, display name: `eLearning`

## Requirements

- Node.js >= 20 and pnpm
- JDK 17+ (`JAVA_HOME`)
- Android SDK (`ANDROID_HOME`), e.g. `~/Android/Sdk`
- `local.properties` in `android/` (or `ANDROID_HOME`) pointing at the SDK — not committed

## Getting started

```bash
pnpm install
pnpm start          # Metro dev server
```

In a second terminal:

```bash
pnpm android        # build + install + launch on a connected device/emulator
```

Debug builds fetch JS from Metro. For an emulator on the same machine, Metro is reachable via `adb reverse tcp:8081 tcp:8081` (done automatically by `run-android`).

## Native dependencies (icons)

`react-native-svg` and `lucide-react-native` provide the icon set used by the Home hub and the Real-life sentences screens (TASK-SENT-001). Every icon is rendered through the single seam `src/components/Icon.tsx` — screens never import the icon library directly.

`react-native-svg` contains native Android code, so an existing checkout must be rebuilt after pulling these dependencies; reloading Metro is not enough:

```bash
pnpm install
pnpm android                      # or: cd android && ./gradlew assembleRelease
```

Under Jest the library is mapped to its published CommonJS entry in `jest.config.js`, so the ~3800 icon modules are not transformed on every suite.

## Configuration (backend server URL)

The backend base URL is environment-driven (`src/config.ts` reads it from the virtual `@env` module via the `react-native-dotenv` babel plugin) — it is never hard-coded in application source.

```bash
cp .env.example .env   # one-time setup; .env is gitignored
```

- **`API_BASE_URL`** — base URL of the Django backend. The Android emulator uses `http://10.0.2.2:8000` (the emulator's alias for the host loopback, where Docker Compose publishes the backend); a physical device on the same network needs the host's LAN IP.
- File selection follows the build mode: `.env` is the base, `.env.development` applies to debug bundles, `.env.test` (committed, mock values only) applies to jest runs, and `.env.production` applies to release bundles. A missing `API_BASE_URL` fails the bundle instead of producing `undefined` URLs.
- `.env` values are inlined into the JS bundle at build time, so only public configuration belongs there — never API keys or other secrets. Changes to `.env` files require a Metro cache reset (`pnpm start -- --reset-cache`) to take effect.

## Commands

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # jest + React Native Testing Library
pnpm android        # run-android
```

## Quality gates

- **TypeScript strict mode** is inherited from `@react-native/typescript-config` (`strict: true`); enforced via `tsc --noEmit`.
- **ESLint** uses `@react-native/eslint-config` (`.eslintrc.js`) with Jest globals enabled.
- **Tests** use Jest with the `react-native` preset and React Native Testing Library.
  `jest.setup.js` mocks native-module-dependent libraries (currently `react-native-safe-area-context`)
  so components render deterministically in the Node test environment.

## Application modes

The app runs in exactly one of two explicit modes (SPEC Phase 13):

- **Server mode** (default) — authenticated; conversations go through the Django backend.
- **Serverless mode** — data stays on-device and AI requests go directly to OpenRouter.

State lives in `src/mode/`:

- `types.ts` — the `ApplicationMode` union (`'server' | 'serverless'`) plus deterministic parsing of untrusted values.
- `modeStorage.ts` — persists the selection in AsyncStorage so it survives app restarts; missing/corrupt values fall back to server mode.
- `ModeContext.tsx` — restores the mode at startup and switches deterministically via `useApplicationMode()`.
- `runtime.ts` — process-wide mode holder and the server-API gate: while serverless, `apiRequest` (REST) and SSE streaming fail fast with `ServerApiBlockedError` without opening a connection, so serverless-local data can never be sent to server APIs.

The two modes are intentionally isolated; switching never merges or synchronizes their data (ROADMAP §15).

## Real-life sentences (serverless)

A local bank of the everyday English a native speaker actually uses, drilled with
spaced repetition. The feature is **serverless-only**: it never calls the Django
backend. Its Home row is hidden in server mode, the topics screen shows a mode
notice there instead of reading SQLite, and the practice-mode setting is hidden as
well.

### Topics and generation

- Home → **Real-life sentences** lists topics newest first with each topic's
  sentence count and how many sentences are due now. The Home row carries a due
  badge that disappears at zero.
- A topic has a required title and an optional English description, for example
  "meeting someone new in a new city". Creating one opens its (empty) sentence
  list.
- Every sentence stores the English `text`, an English-only `meaning` paraphrase
  and a short real-life `situation`. There is no Vietnamese anywhere in this
  feature.
- The topic screen shows the sentence, its meaning and situation, a due/status
  hint, a speaker button for TTS and a delete action.
- **Generate** offers 1 / 5 / 10 sentences (default 5) through the learner's own
  serverless provider. The request carries the topic, the learner's CEFR level
  and up to 50 existing sentences. A review modal then keeps all candidates, a
  selection, or discards the batch; kept candidates are written in one
  transaction and normalized duplicates are skipped.
- **Practice** unlocks at 5 sentences. A session contains only due, non-suspended
  cards, oldest due first, capped at 20. A sentence graded `Again` returns once
  later in the same session; a second `Again` does not requeue it.

### Again / Good / Easy schedule

| Grade | New / learning card | Review card |
| --- | --- | --- |
| **Again** | learning step, due in 10 minutes; lapses +1, ease −0.20 | same 10-minute learning step |
| **Good** | review, due in 1 day | due in `interval × ease` (never shorter) |
| **Easy** | review, due in 4 days; ease +0.15 | due in `interval × ease × 1.3`; ease +0.15 |

Ease starts at 2.5, is clamped to `[1.3, 3.0]`, and intervals are capped at 365
days. Repeated `Good` on a fresh sentence grows the gap 1 day → 2.5 days → 6.25
days → about 15.6 days → about 39 days. The schedule is computed by the pure
`src/srs/scheduler.ts` and persisted by `src/db/sentenceRepository.ts`.

### Practice modes

Settings → **Sentence practice mode** (serverless only, persisted in AsyncStorage,
default `auto`):

- **Auto** — `new` / `learning` sentences are dictation cards; `review` sentences
  are situation-recall cards.
- **Dictation** — every card is a dictation: the sentence is spoken once, the
  learner types it, and a word-level diff pre-selects `Good` or `Again`. The
  learner can always override with Again / Good / Easy.
- **Recall** — every card shows the situation and an optional English meaning
  hint; revealing the answer plays TTS, then the grade buttons appear.

Both card types allow one playback at a time and silence it on card change or
unmount.

### Storage and icons

The bank lives in schema version 4 of the local SQLite database
(`sentence_topics`, `sentences`, `sentence_review_log`).
`src/db/sentenceRepository.ts` owns every statement, and **Clear local data**
empties all three tables in the same transaction. The screens use the shared
`src/components/Icon.tsx` seam, so the native dependency and rebuild requirement
in [Native dependencies (icons)](#native-dependencies-icons) applies.

## Grammar auto-check (opt-in)

An opt-in learning aid (default off) built on the improvement pipeline of
both modes. When enabled in Settings → Grammar (below Text to speech), every
user message sent during the current chat visit is checked by one LLM
request — server mode through the backend improve endpoint, serverless mode
through the user's own provider key — and the response's `severity`
classifies the original: `none` (already correct, nothing shown), `minor`
(small warning badge) or `critical` (error badge) under the user's message.
Pressing a badge opens the improvement sheet with the already-fetched
result, so viewing a suggestion never performs a second API call. The
toggle carries an explicit token-usage warning (one extra AI request per
sent message), the loaded history is never retro-checked, and messages that
arrive while the feature is off stay unchecked forever.

Results are **persisted**: serverless mode stores each improvement on the
local message row (schema v2); server mode stores it on the backend and the
message payloads embed it. Reopening the conversation — or the app —
restores badges and suggestions from the store with zero provider calls,
and the manual "Improve my English" action reuses the stored suggestion for
already-checked messages.

State lives in `src/preferences/grammarCheck.ts` (AsyncStorage flag,
default off) and `src/hooks/useGrammarAutoCheck.ts` (check pipeline, cache
and stale-result guards); the badge renders inside `MessageRow` and reuses
the `ImprovementSheet` of the manual "Improve my English" action.

## Local database (serverless)

Serverless mode persists conversations on-device in SQLite (`src/db/`, SPEC TASK-081):

- `driver.ts` — the small SQL seam (`execute` / `transaction` / `close`) all stores depend on.
- `nativeDriver.ts` — adapter over `react-native-sqlite-storage`; enables foreign keys so deleting a session cascades to its messages and summary.
- `migrations.ts` — append-only, ordered migration list; the applied version is stored in SQLite's `user_version`. Each migration runs in a transaction and a failure leaves the recorded version untouched.
- `database.ts` — `getLocalDatabase()` opens and migrates the database automatically on first use.
- Entity stores (`sessionStore`, `messageStore`, `summaryStore`, `profileStore`, `settingsStore`, `sentenceRepository`) expose typed CRUD mirroring the backend serializers. The OpenRouter API key must not be stored here (secure storage only).

Tests run against real SQL via a sql.js-backed driver (`testing/sqlJsDriver.ts`, dev-only, never bundled); `react-native-sqlite-storage` is mocked globally in `jest.setup.js`.

## Release build

```bash
cd android && ./gradlew assembleRelease

./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a  # for a single architecture (faster, smaller)
```

Output: `android/app/build/outputs/apk/release/`.
