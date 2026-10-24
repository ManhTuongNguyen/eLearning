# English Learning Chat — Word Bank

## 0. Purpose

This document is a focused **feature task list** for the English Learning Chat project.

It covers one deliverable:

1. **Word bank** — a serverless-only vocabulary bank per topic where the AI generates
   the *words only* and the Free Dictionary API (`dictionaryapi.dev`) fills in the
   verified data (all meanings, IPA), followed by FSRS spaced-repetition
   practice with word masking.

It is the sibling feature of **Real-life sentences** (`SENTENCE_LIVE_V1.md`, already
implemented) and reuses its infrastructure wherever possible: the `ts-fsrs` scheduler,
the collection config, the session rules, the review-log shape and the practice-screen
conventions.

IMPORTANT:

- Do NOT restart or re-audit the original MVP or the sentences feature.
- Read the existing source code and current implementation first.
- Keep the scope limited to the tasks described in this file.
- Do not perform unrelated refactoring. The one allowed shared-code change is the
  narrow session-queue generalization described in §2.2 (behavior unchanged).
- **Do NOT change the Django backend.** This feature is serverless-only; the whole
  implementation lives in `mobile/`.
- Add or update regression tests for every task.

---

# 1. Product definition

## 1.1 The problem

The real-life sentences bank trains *chunks* — whole sentences retrieved in a
situation. It does not close vocabulary gaps: a learner with a domain of their own —
a profession, a hobby, a field they study — keeps meeting individual words they
cannot produce. Word lists are also the classic
spaced-repetition use case: an atomic item with a clean know / don't-know signal.

Hand-building a word list is tedious, and writing definitions, IPA and part of
speech by hand is error-prone. The AI is excellent at *choosing which words belong
to a domain* and unreliable at *dictionary facts* — so the AI must only choose the
words, and a real dictionary must supply every stored fact.

## 1.2 The feature

**Word bank**: user-created topics, each holding a bank of English words generated
by the learner's own AI provider and enriched with data from the Free Dictionary API
(`https://api.dictionaryapi.dev/api/v2/entries/en/{word}` — no key, no auth). Every
word keeps **all** of its dictionary senses (a learner also lives a life outside any
single topic: `bank` stays both "financial institution" and "river bank"), grouped
by part of
speech, with IPA when available. The learner practices the
topic with the same FSRS schedule as sentences: words they remember well come back
after longer and longer gaps, words they forget come back in ten minutes.

The topic description is free-form **learner context** — domain, habits and
self-described level in one text ("I'm a chef, I often read cooking blogs, I can
understand about 85 percent of simple texts") — and is passed verbatim to
both the generation and the enrichment prompts.

The **enrich** action lets the learner re-generate a word's meanings and examples
through the AI at any time. The AI receives the old data as *context* only; the app
merges locally, shows the proposed replacement in a **review modal**, and the learner
approves (replace all) or cancels (nothing written). Dictionary phonetics and audio
are never touched by enrichment.

On every practice card, **the target word is masked** wherever a meaning or example
containing it is displayed — including inflected forms — so context never leaks the
answer.

Topics are editable after creation — description and an optional additional AI
prompt included — and a word the dictionary API failed on can be kept without data
and completed later from its detail screen. Words can also be added manually —
comma-separated in a modal — and flow through the same dictionary enrichment and
review modal as AI generation.

There is **no Vietnamese anywhere in this feature**: meanings, examples and topic
descriptions are English.

## 1.3 User journey

```text
Home
  └── Word bank                        (topic list; due-count badge on the Home row)
        ├── New topic                  (title + learner-context description
        │                               + optional additional prompt for the AI)
        ├── Edit topic                 (title, description, additional prompt)
        ├── Delete topic               (confirm modal; cascades words + review log)
        └── Topic screen               (word list with search box; default empty)
              ├── Generate new words   (user-typed count, 1–30, default 10)
              │     └── AI picks words only
              │         → Free Dictionary API fills meanings / IPA
              │         → API error     (word kept WITHOUT data; fetch it later
              │                          from Word detail)
              │         → Review modal  (keep all / keep selected / discard; report:
              │                          kept with data X, kept without data Y,
              │                          not found in dictionary Z)
              ├── Search box           (client-side filter; delete works on filtered rows)
              ├── Per-word audio       (device TTS)
              ├── Add words manually   (comma-separated modal; same dictionary
              │                         enrichment + review modal as generation)
              ├── Word detail          (all senses, examples, IPA, FSRS schedule info)
              │     ├── Fetch dictionary data (only while the word has no data)
              │     ├── Enrich         (AI re-drafts meanings/examples; needs data)
              │     │     └── Change-review modal  (Apply = replace all / Cancel)
              │     └── Delete word
              └── Practice             (enabled at 5+ words)
                    └── Practice screen  (due cards only, max 20 per session)
                          ├── dictation card   (new / learning words: hear → type)
                          └── recall card      (review words: meanings + masked
                                               examples → type the word)
```

## 1.4 Confirmed product decisions

These decisions were confirmed by the product owner and are binding for this task list.

| Decision | Choice |
| --- | --- |
| AI role | **Words only.** The AI returns a list of word strings; it never writes definitions, IPA or part of speech |
| Dictionary data | `dictionaryapi.dev` fills meanings (all senses, grouped by POS, with their examples) and IPA; data is cached in SQLite at creation time and never re-fetched for practice |
| Sense policy | **Store all senses** the dictionary returns — polysemy is a feature, not noise; a learner's life is bigger than any single topic |
| Dictionary failures | 404 (the dictionary does not know the word) → **dropped**. A transient API error (429 / network / timeout) → the word is offered **without data**; if kept it shows a "Fetch dictionary data" action in Word detail and stays out of practice until the data exists. The summary reports kept-with-data / kept-without-data / not-found |
| Topic description | Free-form learner context (domain + self-described level in one text), passed verbatim to the generation and enrichment prompts; title required, description strongly encouraged |
| Additional prompt | Optional per-topic instruction for the AI ("focus on words about cooking"), persisted on the topic, appended to every generation and enrichment prompt, edited together with the topic |
| Topic editing | Title, description and additional prompt are editable after creation through the same form |
| Word count | **User-typed number, 1–30, default 10** (not the fixed 1 / 5 / 10 of sentence generation) |
| Manual input | "Add words" on the topic screen: one fixed-height, internally scrolling input, words separated by commas (split on commas, strip each); same dictionary enrichment, review modal and 30-word bound as generation |
| Word forms | Single English words only; multi-word phrases are excluded from generation (the dictionary API cannot resolve them reliably) |
| Enrich | One AI completion per word; old data goes in as context; AI proposes a full replacement in the stored schema; **change-review modal** shows old vs new; **Apply replaces all**, Cancel writes nothing; phonetics/audio untouched; `data_source` becomes `enriched` |
| Grading buttons | **Again / Hard / Good / Easy** (FSRS ratings 1–4), same `ts-fsrs` adapter and `srs_config` as sentences |
| Card mix | **Automatic**: dictation for `new`/`learning`/`relearning` words, meaning-recall for `review` words; a separate Settings toggle can force one mode |
| Word masking | Every meaning/example containing the target word (or a documented inflection of it) is **masked** on the recall card front (first letter + underscores); the reveal shows the unmasked text |
| Typing check | Single word, case-insensitive: exact or one typo-sized edit → grade **pre-suggested** (Good), otherwise Again — overridable by the learner |
| Session | **Due cards only**, maximum 20 per session; a word stays in the session until FSRS graduates it to `review` |
| Study day | Shared with sentences: new day at **4 a.m. local time** via the existing `srs_config` |
| Practice unlock | Topic needs **5 or more words** |
| Audio | **Device TTS only.** The dictionary's recordings (Wikimedia-hosted community files with patchy coverage, served through the API's media proxy) are deliberately not used; word audio therefore works offline with no remote player; shared one-playback contract |
| Multi-topic words | The same word may exist in several topics; inserting a duplicate across topics is allowed but the review modal row shows "already in <topic>" |
| Icons | Through the existing `Icon` seam (`react-native-svg` + `lucide-react-native`), one new semantic name (`words`) |
| Scope | Serverless only, local SQLite (migration v7), no Django changes |
| Language | No Vietnamese; all word data and UI copy in this feature is English |

---

# 2. Technical specification

## 2.1 Local schema (migration version 7)

`MIGRATION_007` in `mobile/src/db/migrations.ts` (append-only, never edit shipped
migrations; current `SCHEMA_VERSION` is 6) adds three tables. `srs_config` is
**reused unchanged** — words and sentences share one collection config (retention,
steps, rollover, weights).

`word_topics`:

| Column | Meaning |
| --- | --- |
| `id`, `title`, `description` | topic identity; description is the learner-context text |
| `extra_prompt` | optional additional AI instruction ("focus on words about cooking"), appended verbatim to generation and enrichment prompts; `''` when absent |
| `created_at`, `updated_at` | timestamps |

`words` (v7):

| Column | Meaning |
| --- | --- |
| `topic_id` | FK → `word_topics`, cascade delete |
| `text` | the word as stored (dictionary headword casing) |
| `normalized_text` | duplicate key: lowercased, trimmed, whitespace-collapsed; unique per topic |
| `phonetics_json` | JSON array of IPA strings (e.g. `"/kəˈmɪt/"`) — may be empty; the API's audio URLs are deliberately not stored |
| `senses_json` | JSON array `{partOfSpeech, definitions: [{definition, example?}]}` — the **same shape the API returns**, so enrichment can replace it wholesale |
| `data_source` | `'dictionary'` or `'enriched'` |
| `enriched_at` | ISO instant of the last approved enrichment, null if never |
| `data_status` | `'complete'` or `'missing'`; `'missing'` words (API error at generation) have empty `senses_json`/`phonetics_json` and are excluded from sessions and due counts until the dictionary fetch fills them |
| `state` | FSRS card state: `new` / `learning` / `review` / `relearning` |
| `suspended` | Anki flag (0/1); excluded from sessions, memory state kept |
| `stability`, `difficulty` | FSRS memory state |
| `elapsed_days`, `scheduled_days`, `learning_steps` | remaining `ts-fsrs` `Card` fields |
| `reps`, `lapses` | review counters |
| `due_at` | ISO instant; review words due at the start of the target study day |
| `last_grade`, `last_reviewed_at` | last review |
| `created_at`, `updated_at` | timestamps |

`word_review_log` mirrors the sentence revlog so the history can train the FSRS
optimizer per feature: `grade`, `rating` (1–4), `state` **before** the review,
`mode` (`dictation`/`recall`), `due_at`, `stability`, `difficulty`, `elapsed_days`,
`last_elapsed_days`, `scheduled_days`, `learning_steps`, `review_duration_ms`,
`reviewed_at`.

Indexes: unique `(topic_id, normalized_text)`, plus topic, due and
`(topic_id, state)` indexes, and the review-log indexes mirroring the sentence log.

Notes:

- A newly inserted word is immediately due (`due_at` = now) so a fresh topic can be
  practiced at once.
- `normalized_text` for words is deliberately simpler than `normalizeSentenceText`:
  lowercase, trim, collapse internal whitespace, strip surrounding punctuation.
  No contraction expansion — that is sentence comparison logic, not a word identity.
- Storing the API's own JSON shape in `senses_json` is what makes enrichment safe:
  the AI proposes the same shape, the change-review modal can diff old vs new
  structurally, and "replace all" is one column write.
- `data_status='missing'` is the only state in which a word exists without
  dictionary data; it is created solely by the transient-error path of §2.4 and is
  resolved solely by the fetch action on Word detail (§2.8). Enrichment never runs
  on a missing word.

## 2.2 Spaced repetition — reuse, one narrow generalization

Scheduling reuses `mobile/src/srs/scheduler.ts` (`reviewSentence`, `previewSchedule`,
`schedulerStateFrom`) and `srs/dayBoundary.ts` **unchanged**. Words and sentences
share `srs_config`, the four ratings, the learning steps and the 4 a.m. study day.

The one shared-code change: `buildPracticeSession` / `createPracticeSessionState` /
`applyPracticeGrade` in `mobile/src/srs/session.ts` are generalized over a minimal
item shape

```ts
interface SchedulableItem {
  id: number;
  suspended: number;
  state: SentenceState;
  due_at: string;
}
```

so both `SentenceRecord` and the new `WordRecord` satisfy it. Behavior is unchanged;
every existing sentence test must keep passing without modification of its
expectations. The word feature imports the same functions (`canPractice` stays
shared — 5 items, either kind).

Words with `data_status='missing'` never enter a session: they have no meanings to
recall, and the one-tap dictionary fetch on Word detail (§2.8) is the way to make
them practiceable.

## 2.3 Word masking (pure module: `mobile/src/srs/wordMask.ts`)

The recall card shows the word's meanings and examples as retrieval context. Any
occurrence of the target word in that text would give the answer away, so it is
masked before display:

- `maskWordInText(text, word)` → ordered segments `{kind: 'plain' | 'masked', text}`.
- A token is masked when it **equals** the target word case-insensitively, or is a
  documented inflection of it: `-s`, `-es`, `-ed`, `-d`, `-ing` (including the
  doubled final consonant), `-ies` / `-ied`. Word boundaries only — a substring
  inside another word is never masked (`cat` does not mask `category`).
- A masked segment renders as the word's **first letter + underscores**
  (`bank` → `b___`), preserving surrounding punctuation and capitalization
  (`Bank` → `B___`).
- `displayMaskedText(segments)` joins segments for rendering; the screen owns styling.
- The reveal shows the unmasked text. Masking is presentation-only: nothing stored
  is rewritten.
- Deterministic and pure; no React, no storage. Tests cover every inflection rule,
  the boundary rule, capitalization and punctuation edges.

Known limitation, accepted for v1: irregular inflections (`ran` for `run`) are not
detected and stay visible. If the AI-generated examples use an irregular form, the
change-review modal is where the learner sees it before applying.

## 2.4 Dictionary client (`mobile/src/serverless/dictionaryApi.ts`)

- `GET https://api.dictionaryapi.dev/api/v2/entries/en/{word}` — no key, no auth,
  no backend. HTTP injected through a seam (`type FetchFn`) so tests never hit the
  network; per-word timeout.
- Response mapping is a pure function from the API JSON to the stored shape:
  `phonetics_json` (the IPA texts) and `senses_json` (POS groups with definitions
  and their examples). Malformed entries are skipped; an entry with zero usable
  senses is a not-found.
- Outcomes: `'found'` (rows to insert), `'not-found'` (404, empty body, unusable
  JSON) and `'unavailable'` (429, 5xx, network, timeout). A not-found **drops** the
  word; an unavailable error is **transient**, so the word survives as a candidate
  without data (`data_status='missing'`) and the learner can fetch the dictionary
  data later from Word detail (§2.8). No retry loop in v1.
- The client never logs request content beyond the word itself and never touches
  provider keys.
- Attribution: definitions originate from Wiktionary (CC BY-SA) via the Free
  Dictionary API. A credits line in Settings states this.
- **Audio policy — TTS only:** the API also exposes `audio` URLs (recordings
  contributed to Wiktionary and served from the API's media proxy — usually
  `.mp3`/`.ogg`, often missing entirely and of varying quality). The app
  deliberately ignores them: word audio always comes from the device TTS engine,
  which keeps playback offline-consistent, drops the remote-player dependency and
  sidesteps the patchy coverage.

## 2.5 AI generation contract (`mobile/src/serverless/wordGeneration.ts`)

One completion through the existing registry seam
(`loadServerlessConfig` + `createProviderClient`), the same way
`serverless/sentenceGeneration.ts` does it.

System instruction (essence):

```text
You choose English words for a vocabulary-learning app. The learner describes their
domain and level; pick common, useful, real-life words that fit it — including the
specialist words of the domain, not only everyday vocabulary. Respond with ONLY a
JSON array of strings: single English words in their base dictionary form
(no multi-word phrases, no inflected forms, no proper nouns that need outside
context, no duplicates). No markdown, no code fences, no commentary.
```

User instruction includes:

- the topic title and the **full learner-context description verbatim**
  ("I'm a chef, I often read cooking blogs, I can understand about 85 percent of
  simple texts"),
- the topic's additional prompt verbatim when present ("focus on words about
  cooking"),
- the requested count (user-typed, 1–30),
- the topic's existing words (up to 100, one per line) with an explicit instruction
  not to repeat any of them.

Parsing (`parseGeneratedWords`):

- tolerate code fences and surrounding prose by extracting the first JSON array,
- keep string elements only; drop empty/whitespace entries,
- normalize each word (`normalized_text` rules from 2.1) and drop duplicates within
  the batch and against the topic's existing words,
- only zero valid candidates is fatal (`OpenRouterResponseError`).

Pipeline (`generateTopicWords`): parse → dictionary lookup per word (sequential,
2.4) → keep found rows as complete words and unavailable-error words as
`data_status='missing'` candidates; not-found words are dropped. The result
carries the kept words plus `requestedCount`, `keptWithData`, `keptWithoutData`
and `notFoundCount` for the summary message. AI-invented definitions are still
never persisted: a missing-data word simply has no senses until the dictionary
fetch fills them.

The same pipeline also serves **manual input** (TASK-WB-011):
`parseManualWordInput` turns a comma-separated string into candidates, and
everything after the parse step is shared with AI generation.

## 2.6 Enrichment contract (`mobile/src/serverless/wordEnrichment.ts`)

One completion per word, from the Word detail screen.

System instruction (essence):

```text
You improve the learning data for ONE English word for the described learner.
You receive the word's current data as context. Return the full replacement:
senses grouped by part of speech, each with definitions; give every definition a
natural example sentence where you can, and include examples across the common
real-world forms of the word (tenses for verbs, plural for nouns). Keep current
senses that are still worth learning; put the senses most relevant to the
learner's context first; definitions at most ~20 words, examples at most ~15
words. Respond with ONLY a JSON object: {"senses":[{"partOfSpeech":"...",
"definitions":[{"definition":"...","example":"..."}]}]}. No markdown, no
commentary.
```

User instruction includes: the word, the topic title, the learner-context
description and the topic's additional prompt (§2.1), and the word's current
`senses_json` as context.

Rules:

- The AI never rewrites phonetics or audio — the stored `phonetics_json` survives
  every enrichment.
- The **old data is context, not output**: the AI does not echo it back, and the
  app never trusts an echo. The merge decision is made by the learner in the
  change-review modal, and the replacement is a deterministic local write.
- Validation: extract the first JSON object, require a non-empty `senses` array of
  the stored shape, drop empty definitions; invalid output raises
  `OpenRouterResponseError` and nothing changes.
- The **change-review modal** (`WordEnrichModal`) renders old vs new side by side
  (POS groups, definitions, examples). **Apply** replaces `senses_json` wholesale
  in one repository transaction, sets `data_source='enriched'` and `enriched_at`,
  and keeps the word's FSRS memory state untouched. **Cancel** writes nothing.
- Enrichment never touches `state`, `due_at` or any review counter.
- Enrichment requires existing data: it is disabled while `data_status='missing'`;
  the dictionary fetch on Word detail (§2.8) is the only path that fills a
  dataless word.

## 2.7 Practice cards

`wordPracticeMode` preference (`'auto' | 'dictation' | 'recall'`, default `auto`),
stored exactly like `preferences/practiceMode.ts`, with its own Settings row
("Word practice mode", serverless mode only). `selectCardMode` from
`srs/cardMode.ts` is reused as-is.

| Mode | Card |
| --- | --- |
| `auto` | `new`/`learning` → dictation; `review` → recall |
| `dictation` | every card is dictation |
| `recall` | every card is recall |

**Dictation card**

- The word is spoken once automatically on card open through the device TTS
  engine, with a replay button.
- The learner types the word into a `TextInput`.
- `Check` compares case-insensitively: exact match or a single typo-sized edit
  (Levenshtein 1, reused from `srs/answerCheck.ts`) → suggested `Good`;
  anything else → `Again`. The suggestion is never `Easy` and is overridable.
- Reveal shows the correct spelling, IPA and the POS labels; the word replays.
- Grade buttons Again / Hard / Good / Easy with the interval each would schedule
  (same `previewSchedule` mechanism as sentences).

**Recall card**

- Front: the word's **meanings and examples with the target word masked** (§2.3),
  POS labels per group. The learner produces the word from the context and types it.
- Reveal plays the word through TTS, unmasks everything, and shows the full word,
  IPA and senses; then the grade buttons.
- The same one-active-playback TTS contract as the sentence practice screen applies
  to both cards (stop on card change, blur, unmount).

Both cards: grading goes through `reviewSentence`, persists the word state and an
Anki-shaped `word_review_log` row in one transaction, and requeues the card while
it is still `learning`/`relearning` (§2.2).

## 2.8 Search and word detail

**Topic screen search**: a `TextInput` above the list filters the words
client-side — normalized substring match (§2.1 rules) on `text`, case-insensitive.
The result count is shown; an empty result shows a "no words match" state. Delete
and detail navigation keep working on filtered rows. Clearing the input restores
the full list. Search is view-only state; nothing is persisted.

**Word detail screen**: the word in large type with phonetics and a play button
(device TTS), all senses grouped by POS with their examples, the
topic it belongs to, and the FSRS schedule info (state, due time, stability,
difficulty, reps, lapses, last grade/date) rendered from the row. Actions:
**Enrich** (§2.6 modal; disabled while the word has no data), **Fetch dictionary
data** (§2.4; shown **only while `data_status='missing'`** — one API call that
fills senses and phonetics, sets the word complete on success, and stays missing
with a "not found in the dictionary" message on 404), and **Delete** (confirm
modal; removes the row and its review log; the Practice button on the topic screen
disables again below 5 words).

## 2.9 Mode gating

The feature is serverless-only, enforced exactly like the sentences feature:

1. **Home row** ("Word bank", with a due-today badge hidden at zero) is hidden in
   server mode.
2. **Screen guard**: the topics screen renders the same serverless-only notice in
   server mode, waits for the persisted mode to be restored, and reads nothing from
   the database in that state.
3. `clearServerlessLocalData()` (in `mobile/src/db/clearLocalData.ts`) clears the
   three new tables.
4. `docs/MODE_CAPABILITY_MATRIX.md` gains the new rows.

---

# 3. Global rules

## Rule 1 — Serverless only, no backend changes

Do not modify anything under `backend/`. The only HTTP call the feature adds is the
Free Dictionary API request, made directly from the mobile app. The AI requests go
to the user's own configured provider.

## Rule 2 — Preserve the two application modes

Server mode behavior is unchanged except that the new Home row is hidden there. The
runtime gate (`assertServerApiAllowed`) is untouched — this feature never calls the
backend, in either mode.

## Rule 3 — Tests accompany implementation

Every task adds or updates Jest tests. Mobile tests run without a device; database
tests use the in-memory `sql.js` driver already wired in `mobile/__tests__`; the AI
calls are exercised through injected `complete` seams and the dictionary lookups
through an injected `fetch` seam — never real HTTP.

## Rule 4 — Style

- Strict TypeScript, explicit types, no `any`.
- Single quotes, no semicolons, 2-space indentation (existing Prettier config).
- JSDoc block at the top of every new module explaining its responsibility.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass at the end of every task.

## Rule 5 — No secrets, no new permissions

Never log or persist provider keys. The dictionary API needs no key. The keychain
usage stays exactly as it is now.

## Rule 6 — No Vietnamese

No Vietnamese string is added anywhere in this feature. Meanings, examples and
descriptions are English.

---

# 4. Tasks

Priority does not override dependencies: always take the first incomplete
dependency-safe task.

## TASK-WB-001 — Schema version 7 and row types

Status: `[x]`

Priority: `P1`

### Requirements

- Append `MIGRATION_007` to `mobile/src/db/migrations.ts` with the DDL from §2.1
  (including `word_topics.extra_prompt` and `words.data_status`).
- Add row types to `mobile/src/db/types.ts`: `WordTopicRecord` (title, description,
  `extra_prompt`, timestamps), `WordRecord`
  (including `senses_json`, `phonetics_json`, `data_source`, `data_status`,
  `enriched_at` and the
  review-state columns), `WordReviewLogRecord`, plus the `WordSense` structured
  type and its JSON parsing/validation helpers (phonetics are plain IPA strings).
- Keep the migration append-only and atomic (existing `migrateDatabase` contract).

### Acceptance criteria

- A fresh database reaches the new `SCHEMA_VERSION` with all three tables, the
  unique `(topic_id, normalized_text)` index and the documented indexes.
- A database created at version 6 migrates to 7 without data loss.
- Cascade delete works: deleting a word topic removes its words and review-log rows.
- `senses_json`/`phonetics_json`, `extra_prompt` and `data_status` round-trip
  through the typed helpers, and malformed JSON yields safe defaults instead of
  throwing.
- Tests cover fresh install, upgrade, cascade and JSON round-trip behaviour.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-002 — Word repository

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/db/wordRepository.ts` with typed functions, no SQL elsewhere,
  mirroring `sentenceRepository.ts`:
  - topics: `createWordTopic`, `listWordTopics` (with word count and due count per
    topic), `getWordTopicById`, `updateWordTopic` (title, description and
    `extra_prompt`), `deleteWordTopic`
  - words: `insertWords` (batch, single transaction, duplicate-safe against
    `normalized_text`, computes the normalization from §2.1, accepts
    `data_status='missing'` rows), `listWordsByTopic`, `getWordById`, `deleteWord`,
    `getWordByText` (cross-topic duplicate hint), `fillWordDictionaryData` (stores
    fetched senses/phonetics and flips `data_status` to `'complete'`)
  - review: `applyWordReviewState`, `logWordReview`, `listWordReviewLog`
  - due queries: `countDueWords(now)`, `countDueWordsForTopic(topicId, now)`,
    `listDueWords(now, limit)`

### Acceptance criteria

- Every function is typed and tested against the in-memory `sql.js` driver.
- Batch insert skips an existing duplicate within the same topic and keeps the
  existing row untouched.
- Due counts respect `due_at <= now` and exclude suspended words.
- `data_status='missing'` rows round-trip and are excluded from due counts and due
  lists.
- Deleting a topic cascades; deleting a word removes its review-log rows.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-003 — Free Dictionary API client

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/serverless/dictionaryApi.ts` per §2.4: an injected `fetch`
  seam, a per-word timeout, a pure response-mapping function to the stored
  `phonetics_json`/`senses_json` shapes, and the `found` / `not-found` /
  `unavailable` outcome union.
- Export the attribution constant for the Settings credits line.
- No API key handling; the client never touches provider configuration.

### Acceptance criteria

- Tests (injected fetch): a successful multi-entry response maps fully (two POS
  entries, definitions with and without examples, multiple IPA texts kept); 404
  and unusable JSON map to `not-found`; 429, 5xx, abort/timeout and network errors
  map to `unavailable`.
- Malformed individual entries are skipped without failing the whole lookup.
- No real HTTP is performed in any test.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-004 — Word generation service

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/serverless/wordGeneration.ts` per §2.5:
  `buildWordSystemPrompt`, `buildWordUserPrompt(topic, count, existingWords)`,
  `parseGeneratedWords(raw, existingNormalized)`, and the screen-facing
  `generateTopicWords(db, complete, lookup, input)` that runs the
  AI → dictionary → persist pipeline and returns the inserted rows plus the
  kept-with-data / kept-without-data / not-found summary.
- Reuse `serverless/errors.ts` and the `CompletionRequest`/`CompletionResult` types.
- The count input is validated at the screen boundary (integer 1–30); the service
  clamps defensively.

### Acceptance criteria

- Tests (fake `complete` + fake `lookup` seams): valid JSON array, JSON in code
  fences, JSON with prose around it, non-string elements dropped, empty entries
  dropped, duplicates within the batch and against existing words filtered, empty
  result raising `OpenRouterResponseError`.
- Pipeline tests: found words are inserted complete; not-found words are absent
  from the database; unavailable words are inserted as `data_status='missing'`
  candidates with empty senses/phonetics; a mixed batch reports all three counts
  correctly.
- The user prompt contains the topic title, the verbatim learner-context
  description, the requested count, the existing words and the additional prompt
  when present.
- No HTTP client is constructed inside the service.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-005 — Word masking module

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/srs/wordMask.ts` per §2.3: `maskWordInText(text, word)` and
  `displayMaskedText(segments)`, purely functional.
- Document the inflection set in the module JSDoc, including the doubled-consonant
  rule, and the boundary guarantee.

### Acceptance criteria

- Tests cover: exact case-insensitive match; `-s`, `-es`, `-ed`, `-d`, `-ing`,
  `-ies`, `-ied`; doubled final consonant (`plan` → `planned`, `running`);
  capitalization preserved (`Bank` → `B___`); punctuation preserved
  (trailing comma/period stays outside the mask); the boundary rule
  (`cat` does not mask `category`); text with no occurrence returns one plain
  segment; multiple occurrences each masked.
- The masked rendering shows exactly the first letter + underscores of the
  matched surface form.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-006 — Shared session rules for words

Status: `[x]`

Priority: `P1`

### Requirements

- Generalize `mobile/src/srs/session.ts` over the minimal `SchedulableItem` shape
  (§2.2) so `SentenceRecord` and `WordRecord` both satisfy it; export the shape.
- Export the word entry points the practice screen needs (`buildPracticeSession`
  works for words as-is; add whatever thin typed aliases keep call sites readable).
- `canPractice` is reused unchanged (5 items).
- No behavior change for sentences; no changes to sentence tests' expectations.

### Acceptance criteria

- Existing sentence session tests pass unmodified.
- New tests exercise the queue with `WordRecord` fixtures: due-only selection,
  oldest-due order, cap 20, learn-ahead requeue until graduation, suspended
  exclusion and `data_status='missing'` exclusion.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-007 — Word practice mode preference

Status: `[x]`

Priority: `P2`

### Requirements

- Add `preferences/wordPracticeMode.ts` (`'auto' | 'dictation' | 'recall'`,
  default `auto`) mirroring `preferences/practiceMode.ts`, with load/save helpers
  and AsyncStorage persistence; invalid persisted values fall back to `auto`.
- Reuse `selectCardMode` from `srs/cardMode.ts` — no new mapping logic.
- Add a "Word practice mode" row to `mobile/src/screens/SettingsScreen.tsx`
  (serverless mode only), following the existing segmented-control conventions,
  visually distinct from the sentence practice mode row.

### Acceptance criteria

- The setting persists across a remount and takes effect on the next word card.
- Invalid values fall back to `auto`.
- The row is hidden in server mode.
- Tests cover default, change, persistence and mode visibility.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-008 — Routes and the word topics screens

Status: `[x]`

Priority: `P1`

### Requirements

- Add route types to `mobile/src/navigation/types.ts`:
  `WordTopics`, `WordTopic: {topicId: number}`, `WordDetail: {wordId: number}`,
  `WordPractice: {topicId: number}`; register the screens in `MainNavigator`.
- Create `mobile/src/screens/WordTopicsScreen.tsx`:
  - lists topics with title, description preview, word count and due count,
  - "New topic" action opening a small form (title required; description optional
    with the learner-context placeholder, e.g. "I'm a chef, I often read
    cooking blogs, I can understand about 85 percent of simple texts";
    additional prompt optional),
  - an "Edit topic" action reusing the same form pre-filled, saving title,
    description and the additional prompt,
  - creating a topic navigates straight to the topic screen (empty word list),
  - a delete action per topic that opens a themed in-app confirmation modal before
    removing the topic,
  - empty state when no topic exists yet.
- Serverless-only guard per §2.9 (notice in server mode, no database reads, waits
  for the mode restore to settle).

### Acceptance criteria

- Creating a topic persists it and navigates to the new topic screen.
- Editing a topic persists the new description/additional prompt, and the next
  generation prompt contains them.
- A blank title cannot be submitted.
- Deleting a topic is confirmed first and cascades its words and review log.
- Lists render counts from the repository and refresh when the screen regains focus.
- Server mode shows the notice and performs zero database reads (asserted in tests).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-009 — Word topic screen: list, search, generate

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/screens/WordTopicScreen.tsx`:
  - Header: topic title and the learner-context description (collapsible if long).
  - **Search box** above the list: client-side normalized substring filter
    (§2.8), live result count, "no words match" empty state; delete and detail
    navigation work on filtered rows.
  - Word list: the word, its primary POS label, a due/status hint, an audio play
    button (device TTS) and a delete action (confirm modal) per row; tapping the
    row opens Word detail.
  - "+ Generate" action opening a small form with a **numeric input for the word
    count (1–30, default 10)** and validation feedback, running TASK-WB-004 and
    opening the review modal (TASK-WB-010).
  - Practice button, enabled at 5+ words via `canPractice`; when disabled it
    explains how many more words are needed.
  - Empty state when the topic has no words yet.
  - Loading, provider-not-configured and failure states with actionable messages,
    including the kept / not-found summary after generation.
- TTS/audio follows the one-playback contract; playback stops on blur/unmount.

### Acceptance criteria

- Search filters correctly (case-insensitive substring on `normalized_text`), shows
  the count, and restores the full list when cleared.
- Deleting a word from a filtered view removes it from the database and the
  underlying list (not just the filtered view).
- Generation with count N requests N words, inserts verified words plus dataless
  candidates when the API errors, and the summary distinguishes kept-with-data vs
  kept-without-data vs not-found.
- Audio plays one utterance at a time and stops on screen blur/unmount.
- The Practice button disables again below 5 words after deletions.
- Tests cover the list, search, delete, the count input validation, the generation
  summary and the disabled-Practice explanation.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-010 — Generation review modal

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/screens/WordReviewModal.tsx`: one row per candidate showing
  the word, POS labels and the first sense, with a keep toggle (default: keep);
  a row whose word already exists in **another** topic shows "already in <topic>"
  (§1.4) without blocking, and a row kept despite a dictionary error shows
  "dictionary unavailable — fetch its data later from Word detail" (§2.4).
- Actions: "Keep all", "Keep selected" (disabled when nothing is selected), and a
  "Discard all" escape that closes without writing.
- Kept candidates are persisted in one repository transaction; duplicates within
  the topic are skipped silently.
- The summary states the kept-with-data, kept-without-data and not-found counts.

### Acceptance criteria

- Keep-all persists every candidate; keep-selected persists exactly the toggled
  rows; discard writes nothing.
- The modal never persists a candidate the learner removed.
- A cross-topic duplicate insert succeeds and the next generation no longer
  suggests the same word (existing-words list).
- A kept dataless candidate is inserted with `data_status='missing'` and empty
  senses/phonetics.
- Tests cover keep-all, keep-selected, discard, and the cross-topic hint.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-011 — Manual word input on the topic screen

Status: `[x]`

Priority: `P1`

### Requirements

- Add an "Add words" action to `WordTopicScreen` (TASK-WB-009), beside
  "+ Generate". Tapping it opens a themed modal with:
  - one multiline `TextInput` with a **fixed height** (about 140px,
    `textAlignVertical: 'top'`) that **scrolls internally** when the text
    overflows,
  - a placeholder ("type, words, separated, by, commas") and a hint line
    ("Separate words with commas; a word cannot contain a comma"),
  - a live word counter and a submit button disabled while the parsed input is
    empty or exceeds the 30-word bound.
- Add a pure helper `parseManualWordInput(raw, existingNormalized)` in
  `mobile/src/serverless/wordGeneration.ts`: split on commas, trim each token,
  drop empty tokens, normalize (§2.1), drop duplicates within the input and
  against the topic's existing words, and enforce the same 1–30 bound as
  generation.
- On submit, the parsed candidates run through the **same pipeline as
  generation** (TASK-WB-004): sequential dictionary lookup, found words inserted
  complete, transient errors inserted as `data_status='missing'` candidates,
  not-found words dropped — then the same review modal (TASK-WB-010) with the
  same summary counts.
- Known limitation, accepted: a word containing a comma cannot be entered (it
  splits); the modal hint says so.

### Acceptance criteria

- Parsing tests: commas split, whitespace stripped, empty tokens dropped,
  within-input and existing-word duplicates dropped, the 30-word bound enforced.
- A manual submission inserts words exactly like generation, and the summary
  reports kept-with-data / kept-without-data / not-found.
- The modal input keeps a fixed height and scrolls internally instead of growing.
- An input of only commas and whitespace cannot be submitted.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-012 — Word practice screen

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/screens/WordPracticeScreen.tsx`, mirroring the sentence
  practice screen's structure and quality bar:
  - build the session with the shared queue functions (due only, max 20) and show
    progress (`3 / 12`), plus the "All caught up" empty state naming the next due
    time;
  - **dictation card** per §2.7: auto-play the word once (device TTS), replay,
    `TextInput`, `Check` with the pre-suggested grade
    (exact or one edit → Good, else Again), then Again / Hard / Good / Easy with
    the interval each would schedule;
  - **recall card** per §2.7: meanings and examples with the target word masked
    through `wordMask`, POS labels, typed answer, then the reveal (audio, unmasked
    word, IPA, senses) and the grade buttons;
  - on grade: persist through the FSRS scheduler and the word repository, log the
    review row with the mode, requeue while still `learning`/`relearning`, then
    advance;
  - session summary at the end: words reviewed and the Again/Hard/Good/Easy
    breakdown, with actions to review again (if still due) or go back to the topic;
  - the same TTS one-playback contract as the sentence screen.

### Acceptance criteria

- Only due, non-suspended, non-missing words enter the session, ordered by due
  date, capped at 20.
- Grading writes the new FSRS schedule and appends a review-log row with the correct
  mode, rating and memory state.
- A learning/relearning word reappears later in the same session; it leaves the
  queue once FSRS graduates it to `review`.
- The recall card front never displays the unmasked target word or an irregular
  inflection leak the masking rules cover (asserted with `wordMask` fixtures).
- The pre-suggested grade reflects the single-word check and the learner's override
  wins.
- `auto` shows dictation for `new`/`learning`/`relearning` and recall for `review`;
  forced modes override.
- Audio: one playback at a time, silenced on unmount/card change, replay works.
- Tests cover the session build, both card types, grading persistence,
  requeue-until-review, masking on the recall front and the empty state.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-013 — Word detail screen

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/screens/WordDetailScreen.tsx` per §2.8:
  - the word in large type, phonetics text, a play button (device TTS;
    one-playback contract),
  - all senses grouped by POS with their examples,
  - the FSRS schedule info block (state, due time, stability, difficulty, reps,
    lapses, last grade/date) rendered from the stored row,
  - **Fetch dictionary data** action, shown **only while `data_status='missing'`**:
    one dictionary call (TASK-WB-003); success stores senses/phonetics through
    `fillWordDictionaryData` and flips the word to complete; a 404 keeps it missing
    with a "not found in the dictionary" message,
  - **Enrich** action (TASK-WB-014; disabled while the word has no data) and
    **Delete** action (confirm modal; removes the word and its review log, then
    navigates back),
  - the topic link back to the topic screen.
- The screen reads from the repository on focus; no in-memory guesses.

### Acceptance criteria

- All stored data renders, including multiple POS groups and definitions with and
  without examples.
- Enrich and delete mutate only through the repository; after delete the topic
  screen reflects the new count and the Practice button state.
- The fetch action is absent for complete words, visible for missing words, fills
  the data on success and leaves the word missing with a message on 404; enrich
  stays disabled until the data exists.
- The schedule block matches the row (testable via the in-memory driver).
- Tests cover rendering, the TTS play button, delete confirmation and the FSRS
  block.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-014 — Word enrichment service and change-review modal

Status: `[x]`

Priority: `P1`

### Requirements

- Create `mobile/src/serverless/wordEnrichment.ts` per §2.6:
  `buildEnrichSystemPrompt`, `buildEnrichUserPrompt(word, topic, current)`,
  `parseEnrichedSenses(raw)`, and `enrichWord(db, complete, input)` that returns
  the proposed replacement **without writing**.
- Create the change-review modal UI inside `WordDetailScreen` flow:
  old vs new side by side (POS groups, definitions, examples), **Apply** and
  **Cancel**.
- On Apply: replace `senses_json` wholesale in one transaction, set
  `data_source='enriched'` and `enriched_at`; never touch `phonetics_json`, the
  FSRS state or any review counter. On Cancel: no write.
- Validation failures (empty senses, wrong shape) surface an actionable error and
  write nothing.

### Acceptance criteria

- The prompts contain the word, the topic title, the verbatim learner-context
  description, the additional prompt and the current senses as context.
- Apply persists exactly the proposed senses and the two metadata fields; a
  subsequent detail read shows the new data; the schedule block is unchanged.
- Cancel leaves the row byte-identical.
- Invalid AI output raises `OpenRouterResponseError` and writes nothing.
- Tests cover prompt building, parsing, apply, cancel and the failure path.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-015 — Home row, due badge, gating and data clearing

Status: `[ ]`

Priority: `P1`

### Requirements

- Add the "Word bank" row to the Home "Practice" section with a new `words` icon in
  the `Icon` seam, a due-today badge (hidden at zero, count from
  `countDueWords(now)`) and a description.
- The row is hidden in server mode.
- Add the three new tables to `clearServerlessLocalData()` in
  `mobile/src/db/clearLocalData.ts` (without touching auth tokens, theme, the mode
  flag or the sentence tables).
- Add the Wiktionary / Free Dictionary API attribution line to the Settings
  screen's serverless section.
- Update `docs/MODE_CAPABILITY_MATRIX.md` with the feature and its screens.

### Acceptance criteria

- The badge count equals `countDueWords(now)` and disappears at zero.
- The row is absent in server mode and present in serverless mode.
- Clearing local data empties word topics, words and the word review log, and
  leaves sentence data untouched.
- The matrix documents the mode behavior of the new screens.
- Tests cover the badge, row visibility per mode and the clear-data wipe.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

---

## TASK-WB-016 — Documentation and final quality gates

Status: `[ ]`

Priority: `P1`

### Requirements

- `mobile/README.md`: a "Word bank" section (topics with learner-context
  description, AI words + dictionary enrichment, manual comma-separated input,
  all-senses storage, the FSRS schedule shared with sentences, the practice
  modes, word masking, the enrich change-review modal, TTS-only audio,
  serverless-only note).
- `docs/ARCHITECTURE.md`: extend the serverless subsection with the word store,
  the dictionary client and the shared session rules.
- Root `README.md` and `README.vi.md`: add the feature to the Features list and to
  the mode table where relevant (keep the bilingual pairing intact).
- Run the full mobile gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Run the backend gates unchanged to prove the backend is untouched:
  `git status --porcelain backend/` must be empty, and `uv run pytest` must still
  pass (or the documented SQLite fallback when Docker is unavailable).
- Verify the acceptance criteria of every task in this file and record the final
  state in `docs/tasks/STATE.md`.

### Acceptance criteria

- Documentation matches the implemented behavior (no aspirational statements).
- Every new file path referenced exists.
- Mobile: lint, typecheck and the whole Jest suite pass.
- `backend/` has no diff.
- All tasks in this file are `Status: `[x]``.
- `docs/tasks/STATE.md` names the completed feature and leaves the next-task
  fields empty.
- Any remaining known limitation is written down explicitly rather than left
  implicit (e.g., irregular inflections are not masked; the dictionary API has no
  retry logic in v1; a word containing a comma cannot be entered manually).

---

# 5. Completion condition

The feature is complete when a learner can:

1. See a "Word bank" icon row on Home with a due badge (serverless mode only).
2. Create a topic whose description describes their domain and self-described
   level ("I'm a chef, I often read cooking blogs, …") with an optional
   additional prompt that shapes every AI call for that topic — and edit all of it
   later.
3. Type how many words they want (1–30) and get AI-chosen words with **verified**
   meanings (all senses) and IPA from the dictionary — never AI-invented
   definitions — keeping all or a selection through the review modal, or add
   words manually (comma-separated) through the same flow; when the dictionary
   API errors, keep the word anyway and fetch its data later from the detail
   screen.
4. Search the word list and delete words, including from filtered views.
5. Open any word and see every sense, example, phonetic and its FSRS schedule.
6. Enrich a word, review the AI's proposed replacement side by side with the old
   data, and apply it only on approval — with phonetics and schedule untouched.
7. Practice the topic once it holds 5 words: hear-and-type for new words, and for
   review words recall from meanings/examples in which **the target word and its
   inflections are masked**.
8. Grade every card Again / Hard / Good / Easy with the interval each button will
   schedule, and see the same word come back later when answered well and in ten
   minutes when forgotten.
9. Close and reopen the app and keep every topic, word and schedule.
10. Use all of it offline after creation, in serverless mode only, with no Django
    backend change.
