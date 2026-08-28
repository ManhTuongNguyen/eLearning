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

## Local database (serverless)

Serverless mode persists conversations on-device in SQLite (`src/db/`, SPEC TASK-081):

- `driver.ts` — the small SQL seam (`execute` / `transaction` / `close`) all stores depend on.
- `nativeDriver.ts` — adapter over `react-native-sqlite-storage`; enables foreign keys so deleting a session cascades to its messages and summary.
- `migrations.ts` — append-only, ordered migration list; the applied version is stored in SQLite's `user_version`. Each migration runs in a transaction and a failure leaves the recorded version untouched.
- `database.ts` — `getLocalDatabase()` opens and migrates the database automatically on first use.
- Entity stores (`sessionStore`, `messageStore`, `summaryStore`, `profileStore`, `settingsStore`) expose typed CRUD mirroring the backend serializers. The OpenRouter API key must not be stored here (secure storage only).

Tests run against real SQL via a sql.js-backed driver (`testing/sqlJsDriver.ts`, dev-only, never bundled); `react-native-sqlite-storage` is mocked globally in `jest.setup.js`.

## Release build

```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/`.
