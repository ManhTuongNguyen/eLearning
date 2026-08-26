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

## Release build

```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/`.
