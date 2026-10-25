# English Learning Chat — Word Capture (Collected Words)

## 0. Purpose

This document is a focused **feature task list** for the English Learning Chat project.

It covers one deliverable:

1. **Word capture** — saving a word selected anywhere on Android (browser, any
   app with selectable text) straight into the word bank's permanent
   **Collected words** topic, plus AI generation of similar words from that
   collection.

It is the follow-up feature of the **word bank** (`WORD_BANK_V1.md`,
implemented) and reuses its infrastructure wherever possible: the dictionary
client, the insertion/dedup repository, `data_status='missing'`, the review
modal, the FSRS practice pipeline and the ContextMenu/guide conventions.

IMPORTANT:

- Do NOT restart or re-audit the word bank feature; read its code first.
- **Phase 1 is Android only.** The JS pipeline and schema are
  platform-neutral so an iOS Share Extension can be added later.
- Do NOT change the Django backend. Capture is serverless-only.
- Add or update regression tests for every task.

---

# 1. Product definition

## 1.1 The problem

The word bank fills topics with words the AI chooses from a *description* the
learner writes. But the most natural moment to want a word is the moment of
meeting it: mid-article, mid-email, mid-anything on the phone. Switching apps,
typing the word into a manual-add modal and returning to the page breaks
reading; nobody keeps that up.

## 1.2 The feature

The learner selects an English word anywhere on Android and taps **"Save to
Word Bank"** in the system text-selection menu (or shares the selection to the
app). A transparent native activity validates the selection, queues it, shows
a toast (`"word" saved to Word Bank` / `Single words only`) and finishes
immediately — the learner never leaves the page, no React Native boots, and
capture works offline. The next time the app becomes active, the queue is
drained: each word is looked up in the Free Dictionary API and inserted into
the seeded **Collected words** topic, which is pinned first in the topic list
and cannot be renamed, re-described, re-prompted or deleted (its practice
settings remain editable). Words the dictionary does not know are still saved
— as dataless words, exactly like a transient dictionary error in the word
bank — and can be fetched or AI-enriched from Word detail later. The topic's
⋯ menu offers **Generate similar words**, which prompts the AI with the
collection itself instead of a topic description.

## 1.3 User journey

1. Reading in Chrome, the learner long-presses "serendipity", taps
   *Save to Word Bank*, sees the toast, keeps reading.
2. Later they open the app. The captured words are already in *Collected
   words* with definitions and IPA; a typo'd capture sits dataless until they
   fetch/enrich/delete it.
3. They practice the topic like any other, tune its practice settings, and
   occasionally use *Generate similar words* to grow the collection.

## 1.4 Confirmed product decisions

- **Single words only.** Any selection containing internal whitespace is
  rejected at capture (toast) and re-validated in JS. Surrounding
  punctuation is stripped; case/whitespace normalize as everywhere
  (`normalizeWordText`).
- **Every entry path stores the canonical normalized form.** Capture,
  manual input and AI generation all persist the lowercased,
  punctuation-stripped form (`lookupAndPersist` in `wordGeneration.ts` is
  the shared tail for the latter two), so a word lands identically however
  it arrived. The lookup itself receives the word as typed, and
  `lookupDictionaryWord` retries a miss once with the lowercase form (the
  API is case-sensitive; selections and manual input arrive with sentence
  casing).
- **Never drop a capture.** Not-found and unavailable lookups both persist as
  `data_status='missing'` — the deliberate difference from generation's
  `lookupAndPersist`, which drops not-found words.
- **Dedupe inside the collected topic only.** The same word may exist in
  other topics; capture does not care.
- **The system topic is locked but not frozen.** Title/description/
  extra_prompt immutable, deletion rejected (repository-level guards), while
  learn-ahead/daily-limit settings stay editable.
- **Offline capture by design.** No network at selection time; definitions
  fetch on the next app open (max `MAX_CAPTURE_BATCH = 10` per activation).
- **Generation grows the collection.** `generateCollectedWords` prompts from
  the topic's existing words (untrusted `<learner_context>` block) and shares
  the generation persistence tail. An empty collection is a screen-level
  hint, not a crash.

---

# 2. Technical design

## 2.1 Schema (migration version 10)

`ALTER TABLE word_topics ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0`
plus one seed row (`is_system = 1`, title `Collected words`, description
"Words saved from text selection on your phone."). `WordTopicRecord` gains
`is_system: boolean`; `NewWordTopic` deliberately does not — app code cannot
create system topics. `listWordTopics` orders `is_system DESC` first so the
topic is pinned. `clearServerlessLocalData` deletes only non-system topics.

## 2.2 Native capture (`mobile/android/.../com/elearningmobile/`)

- **`CaptureActivity.kt`** — translucent, `noHistory`, `excludeFromRecents`,
  `taskAffinity=""`; registered for `ACTION_PROCESS_TEXT` and `ACTION_SEND`
  (`text/plain`), label `@string/capture_menu_label`. Pre-checks the
  single-word rule (`MAX_CAPTURED_WORD_LENGTH = 64`, kept in sync with JS),
  appends the raw trimmed text to the `word_capture` SharedPreferences JSON
  queue (cap 500, synchronized), toasts, finishes.
- **`WordCaptureModule.kt` / `WordCapturePackage.kt`** — classic module
  (Speech pattern) exposing `getPendingCapturedWords()` (no clear) and
  `removeCapturedWords(words)`. Removal happens only after JS committed the
  inserts, so crashes replay idempotently through the topic-level duplicate
  filter.

## 2.3 JS pipeline (`mobile/src/serverless/wordCapture.ts`)

`validateCapturedWord` (pure) + `processCapturedWords(db, {lookup, getPending,
remove})`: drain ≤ 10 raws, validate, sequential lookup, keep-everything
insert via `insertWords`, remove processed raws on success. The **canonical
normalized form** (`normalizeWordText`: lowercased, surrounding punctuation
stripped) is what gets looked up and stored — the API is case-sensitive and
selections arrive with sentence casing (`Everything`) or trailing
punctuation. `lookupDictionaryWord` additionally retries a miss once with the
lowercase form, which also repairs fetching for pre-existing cased rows. The
native seam is a lazy `NativeModules.WordCapture` lookup that no-ops when
absent (iOS, tests). `CapturedWordSync` (`src/hooks/CapturedWordSync.tsx`)
mounts in `App.tsx` beside the root navigator and runs on mount + `AppState`
active, silently, mode-independent.

## 2.4 Similar-words generation (`mobile/src/serverless/wordGeneration.ts`)

`COLLECTED_WORD_GENERATION_SYSTEM_PROMPT` (same JSON-only/no-facts contract),
`buildCollectedWordsUserPrompt` (samples inside `<learner_context>`, cap 100,
sanitized; explicit exclusion line), `generateCollectedWords` (throws on an
empty collection; shares `parseGeneratedWords` + `lookupAndPersist`).

## 2.5 UI and guide

Topic-list ⋮ menu hides Edit/Delete for the system topic; topic screen
relabels Generate → *Generate similar words*, disables it with a hint on an
empty collection. Manual add and practice settings unchanged. New guide entry
`collectedWords` (Practice section) + pointer tip in `wordBank`.

---

## Rules

1. Serverless only, no backend changes.
2. Android only in phase 1; JS and schema stay platform-neutral.
3. Tests accompany implementation.
4. House style (Biome, doc comments, no Vietnamese in UI).
5. No new permissions beyond the existing manifest entries.

## TASK-WC-001 — Schema version 10 and repository guards

`migrations.ts` (`is_system` + seed), `types.ts`, `wordRepository.ts`
(`TOPIC_COLUMNS`, mapping, pinned ordering, update/delete guards,
`getSystemWordTopic`), `clearLocalData.ts` exemption. Tests: `wordSchema`,
`wordRepository`, `clearLocalData`.

## TASK-WC-002 — Native capture activity and queue module

`CaptureActivity.kt`, `WordCaptureModule.kt`, `WordCapturePackage.kt`,
`MainApplication.kt` registration, manifest intent-filters, `strings.xml`.
Manual verification (device/emulator):

```
adb shell am start -a android.intent.action.PROCESS_TEXT -t text/plain \
  --es android.intent.extra.PROCESS_TEXT serendipity \
  -n com.elearningmobile/.CaptureActivity
```

expect the toast, then open the app and confirm the word appears complete in
*Collected words*. Also verify the entry appears in Chrome's real selection
menu and the share sheet.

## TASK-WC-003 — Capture pipeline and startup sync

`src/serverless/wordCapture.ts` + `src/hooks/CapturedWordSync.tsx` + `App.tsx`
mount. Tests: `__tests__/wordCapture.test.ts`.

## TASK-WC-004 — Word bank UI integration

`WordTopicsScreen` menu filtering, `WordTopicScreen` generate variant +
empty-collection hint. Tests: `wordTopicsScreen.test.tsx`,
`wordTopicScreen.test.tsx`.

## TASK-WC-005 — Generate similar words

`wordGeneration.ts` additions. Tests: `wordGeneration.test.ts`.

## TASK-WC-006 — Guide entry

`guide/types.ts` + `guideContent.ts` (`collectedWords` + `wordBank` tip).
Enforced by the guide invariant tests.
