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

## Release build

```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/`.
