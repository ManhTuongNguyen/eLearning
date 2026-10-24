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
  list. Each topic row has a delete action that opens an in-app confirmation
  modal and then removes the topic together with its sentences and review
  history.
- Every sentence stores the English `text`, an English-only `meaning` paraphrase
  and a short real-life `situation`. Generation leans on everyday spoken English,
  including common slang and abbreviations, and spells out any slang in full in
  the `meaning`. There is no Vietnamese anywhere in this feature.
- The topic screen shows the sentence, its meaning and situation, a due/status
  hint, a speaker button for TTS and a delete action.
- **Generate** offers 1 / 5 / 10 sentences (default 5) through the learner's own
  serverless provider. The request carries the topic, the learner's CEFR level
  and up to 50 existing sentences. A review modal then keeps all candidates, a
  selection, or discards the batch; kept candidates are written in one
  transaction and normalized duplicates are skipped.
- **Practice** unlocks at 5 sentences. A session contains only due, non-suspended
  cards, oldest due first, capped at 20. A card stays in the session while it is
  in an FSRS learning/relearning step, so the first `Good` on a new card and any
  `Again` bring it back; it leaves once FSRS graduates it to review.

### FSRS schedule (Anki-compatible, 4 a.m. day)

Scheduling is delegated to [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs),
the TypeScript port of the FSRS-6 model Anki ships. The practice screen has Anki's
four buttons, each labelled with the interval it would schedule:

| Button | Rating | New card (default steps `1m 10m`) | Review card |
| --- | --- | --- | --- |
| **Again** | 1 | 1-minute step; card stays in learning | lapse → relearning at `10m`, lapses +1 |
| **Hard** | 2 | 6-minute step | shorter review interval from FSRS stability |
| **Good** | 3 | 10-minute step (a second Good graduates) | next review interval from FSRS stability |
| **Easy** | 4 | graduates straight to review (~8 days) | longest review interval |

Defaults mirror Anki: 90% desired retention, a 36500-day interval cap, fuzz on
(seeded per card so the button preview matches the saved schedule), and a new
study day starting at **4 a.m. local time**. `elapsed_days` counts local study
days, and a graduated card becomes due at the start of its target study day, so
reviewing at 1 a.m. still belongs to the previous day. The pure adapter lives in
`src/srs/scheduler.ts`, the rollover math in `src/srs/dayBoundary.ts`, the
defaults in `src/srs/config.ts`, and the persisted result in
`src/db/sentenceRepository.ts`.

Collection settings — optimized weights, desired retention, interval cap, fuzz,
learning steps and rollover hour — live in the single-row `srs_config` table
(`src/db/srsConfigStore.ts`). The same store exports the Anki-shaped revlog rows
(`card_id`, `review_time`, `rating`, state, elapsed/scheduled days, stability,
difficulty, duration) that the offline FSRS optimizer trains on; write the
optimized vector back with `saveSrsConfig({ weights })`.

### Practice modes

Settings → **Sentence practice mode** (serverless only, persisted in AsyncStorage,
default `auto`):

- **Auto** — `new` / `learning` / `relearning` sentences are dictation cards;
  `review` sentences are situation-recall cards.
- **Dictation** — every card is a dictation: the sentence is spoken once, the
  learner types it, and a word-level diff pre-selects `Good` or `Again`. The
  learner can always override with Again / Hard / Good / Easy.
- **Recall** — every card shows the situation and an optional English meaning
  hint; revealing the answer plays TTS, then the grade buttons appear.

Both card types allow one playback at a time and silence it on card change or
unmount.

### Storage and icons

The bank lives in schema version 6 of the local SQLite database
(`sentence_topics`, `sentences`, `sentence_review_log`, `srs_config`).
`src/db/sentenceRepository.ts` owns every statement, and **Clear local data**
empties all four tables in the same transaction. The screens use the shared
`src/components/Icon.tsx` seam, so the native dependency and rebuild requirement
in [Native dependencies (icons)](#native-dependencies-icons) applies.

## Word bank (serverless)

A vocabulary bank per learner-created topic, the sibling of the Real-life
sentences feature (WORD_BANK_V1). It is **serverless-only**: the AI only *chooses
which words* belong to the learner's domain, and every stored dictionary fact
(meanings, IPA) comes from the Free Dictionary API (`dictionaryapi.dev` — no key,
no auth, definitions originate from Wiktionary, CC BY-SA). The Django backend is
never called; the Home row is hidden in server mode and the topics screen shows a
mode notice there instead of reading SQLite.

### Topics, generation and manual input

- Home → **Word bank** lists topics newest first with word count, due count and
  a due badge that disappears at zero.
- A topic has a required title, a free-form **learner-context description**
  (domain, habits and self-described level in one text, e.g. "I'm a chef, I
  often read cooking blogs, I can understand about 85 percent of simple texts")
  and an optional **additional prompt** ("focus on words about cooking"). All
  three are editable later and are passed verbatim to every generation and
  enrichment prompt (wrapped as untrusted learner context).
- **Generate** takes a user-typed count (1–30, default 10). The model returns
  ONLY a JSON array of single English words in their base dictionary form; the
  dictionary API then fills the verified data. The client
  (`src/serverless/dictionaryApi.ts`) calls `freedictionaryapi.com/api/v1`
  (no key, no auth; definitions originate from Wiktionary, CC BY-SA 4.0) and
  stores every sense per part of speech — subsenses flattened — with up to
  three examples per sense, usage tags ("informal", "UK", …) and up to eight
  synonyms/antonyms at sense and definition level, plus up to six deduplicated
  IPA pronunciations. A 404 — or the API's "HTTP 200 with empty entries" —
  drops the word; a transient API error (429, network, timeout) keeps it as a
  `data_status='missing'` candidate that stays out of practice until **Word
  detail** fills it — either **Fetch dictionary data** (dictionary first) or,
  when the dictionary cannot provide it, the approved **Enrich** proposal from
  the AI. The summary reports kept-with-data / kept-without-data / not-found.
- **Add words** accepts comma-separated input in a fixed-height, internally
  scrolling field and runs the same dictionary pipeline and review modal.
- The review modal shows one row per candidate (word, POS, first sense) with a
  keep toggle, an "already in \<topic\>" hint for cross-topic duplicates and a
  "dictionary unavailable — fetch its data later" hint for dataless rows. The
  generation pipeline persists the candidates before review, so keep-all just
  confirms, keep-selected removes the unticked rows in one transaction, and
  discard closes without writing.
- The topic screen has a client-side search box (normalized substring match,
  live count), per-word TTS playback and confirmed deletes that work on
  filtered rows. Practice unlocks at 5 words.

### Word detail, masking and enrichment

- **Word detail** renders the word in large type with phonetics and a play
  button (device TTS), every sense grouped by POS with usage-tag chips, all
  examples, and synonyms/antonyms lines at sense and definition level, plus
  the FSRS schedule block (state, due, stability, difficulty, reps, lapses,
  last grade/date). **Fetch dictionary data** appears only while the word has
  no data; **Delete** cascades the review log.
- **Enrich** sends one completion per word: the current senses go in as
  context and the AI proposes a full replacement in the stored JSON shape. For
  a dataless word the AI drafts the whole entry from scratch, and applying it
  flips the word to complete — the only path that completes a word the
  dictionary could not. The change-review modal diffs old vs new side by
  side; **Apply** replaces the senses in one transaction and stamps
  `data_source='enriched'`/`enriched_at`, while the FSRS schedule is never
  touched. **Cancel** writes nothing.
- Recall cards mask the target word wherever a meaning or example shows it —
  the word and its documented regular inflections (-s, -es, -ed, -d, -ing,
  doubled final consonant, -ies/-ied), first letter + underscores, word
  boundaries only. Masking is presentation-only (see `src/srs/wordMask.ts`).

### Word practice

Practice mirrors the sentence bank: due-only sessions capped at 20 through the
shared `srs/session.ts` queue, Again / Hard / Good / Easy with the interval
each button would schedule, and the same `srs_config` collection (90% retention,
4 a.m. study day). **Dictation** cards (new/learning/relearning words) speak the
word once automatically and pre-suggest `Good` for an exact or one-typo answer
(never `Easy`). **Recall** cards (review words) show the meanings and masked
examples and reveal with audio. Settings → **Word practice mode** (serverless
only, default `auto`) can force either card shape.

Known limitations, accepted for v1: irregular inflections (`ran` for `run`) are
not masked; the dictionary client has no retry loop; a word containing a comma
cannot be entered manually; dictionary quotes and inflection forms are fetched
but not stored, and word audio is device TTS only (the API's recordings are
ignored).

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
- Entity stores (`sessionStore`, `messageStore`, `summaryStore`, `profileStore`, `settingsStore`, `sentenceRepository`, `wordRepository`, `srsConfigStore`) expose typed CRUD mirroring the backend serializers. The OpenRouter API key must not be stored here (secure storage only).

Tests run against real SQL via a sql.js-backed driver (`testing/sqlJsDriver.ts`, dev-only, never bundled); `react-native-sqlite-storage` is mocked globally in `jest.setup.js`.

## Release build

```bash
cd android && ./gradlew assembleRelease

./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a  # for a single architecture (faster, smaller)
```

Output: `android/app/build/outputs/apk/release/`.
