# Application Mode Capability Matrix

Audited for `TASK-AUDIT-016`. Every screen, navigation route and feature is
classified for the two intentionally isolated application modes:

```text
SERVER      React Native → Django API → PostgreSQL / Redis / Celery → LLM provider
SERVERLESS  React Native → Local SQLite → LLM provider directly
```

The mode is persisted under the `app.applicationMode` AsyncStorage key,
restored by `ModeProvider` at startup, and mirrored into the process-wide
runtime gate (`src/mode/runtime.ts`) that blocks every server transport while
serverless is active.

## 1. Feature capability matrix

| Feature | Server | Serverless | Owner / seam |
|---|---:|---:|---|
| Account (sign in / register / profile) | Yes | No | `AuthContext`, `api/auth`, `AuthNavigator` |
| Server authentication (JWT + refresh) | Yes | No | `authedRequest`, `api/auth` |
| Server conversation history | Yes | No | `api/sessions` |
| Local conversation history | No | Yes | `db/sessionStore`, `db/messageStore` |
| Real-life sentences (topics, AI generation, SRS practice) | No | Yes | `db/sentenceRepository`, `srs/*`, `Sentence*Screen` |
| Word bank (topics, AI words + dictionary data, SRS practice, enrichment) | No | Yes | `db/wordRepository`, `serverless/wordGeneration`, `serverless/wordEnrichment`, `serverless/dictionaryApi`, `Word*Screen` |
| AI chat (turn + retry) | Yes (SSE via backend) | Yes (direct provider) | `useChatTurns` mode branch |
| Topic suggestions | Yes | Yes | `useMessageSuggestions` mode branch |
| Improve my English | Yes | Yes | `useMessageImprovement` mode branch |
| Grammar auto-check (badges, opt-in) | Yes | Yes | `useGrammarAutoCheck` mode branch |
| Learning level | Yes | Yes | `LevelScreen` mode branch (entry offered in both modes) |
| Example conversation ("Show me an example") | Yes | Yes | creation response (server) / provider generation (serverless TASK-093) |
| Saved vocabulary (save word) | Yes | No | `useVocabularySave` + runtime gate |
| Vocabulary enrichment | Yes | No | backend Celery only |
| Vocabulary screen / CSV export | Yes | No | `api/vocabulary` + runtime gate |
| Provider configuration (provider, key, model) | No | Yes | `AIProviderSettingsScreen`, `serverless/settings` |
| Direct provider request | No | Yes | `serverless/providerRegistry`, provider clients |
| Provider/model discovery | No | Yes | `serverless/modelCatalog` (keyless for OpenRouter/9Router) |
| Clear local data | No | Yes | `clearAllServerlessData` |
| Read aloud (TTS) | Yes | Yes | `tts/*` (device-local, mode-independent) |
| Copy / text selection surface | Yes | Copy only | clipboard + `MessageActionsMenu` |
| Application mode switcher | Yes | Yes | `SettingsScreen` |
| Theme switching (persisted, `app.themeMode`) | Yes | Yes | `ThemeContext` + `preferences/theme` (mode-independent) |

## 2. Route-by-route audit

`RootNavigator` is the mode-aware root: while serverless it mounts
`MainNavigator` unconditionally (auth-independent, TASK-AUDIT-003); in server
mode it mounts `AuthNavigator` until authenticated. Splash is shown until
both the mode and the auth restore have settled.

| Route | Navigator | Server behavior | Serverless behavior | Mode safety |
|---|---|---|---|---|
| `Login` | Auth | Login form + serverless entry | Unreachable | Root gate |
| `Register` | Auth | Registration form | Unreachable | Root gate |
| `Chat` | Main | Server sessions + SSE | Local SQLite + direct provider | Mode-branched (`conversationSource`, `useChatTurns`) |
| `NewConversation` | Main | `POST /sessions` (includes sample) | Local session + topic/sample completions | Mode-branched |
| `History` | Main | Server list + pagination | Local one-shot list | Mode-branched |
| `Settings` | Main | Account card, learning rows, logout | Learning level row, provider card, clear-local, switcher | Conditioned rendering |
| `Level` | Main | `GET/PATCH /profile` | Local `learning_profile` | Mode-branched, waits for mode-ready |
| `Vocabulary` | Main | List + enrichment + CSV export | Server-only notice, zero API calls | In-screen guard (TASK-AUDIT-016) |
| `SentenceTopics` | Main | Hidden from Home; server-only notice if pushed, zero local reads | Topic list, create and due counts | Home row + in-screen guard (TASK-SENT-008/014) |
| `SentenceTopic` | Main | Reachable only through `SentenceTopics`; local sentence bank UI | Sentence bank, generation, TTS, delete, Practice | Serverless-only parent route (TASK-SENT-009) |
| `SentencePractice` | Main | Reachable only through `SentenceTopics`; local SRS session | Due-only dictation/recall session (max 20) | Serverless-only parent route (TASK-SENT-012) |
| `WordTopics` | Main | Hidden from Home; server-only notice if pushed, zero local reads | Topic list, create/edit/delete and due counts | Home row + in-screen guard (WORD_BANK_V1 TASK-WB-008) |
| `WordTopic` | Main | Reachable only through `WordTopics`; local word bank UI | Word list, search, generation, manual input, TTS, delete, Practice | Serverless-only parent route (WORD_BANK_V1 TASK-WB-009) |
| `WordDetail` | Main | Reachable only through `WordTopic` | All senses, schedule, dictionary fetch, enrich change-review, delete | Serverless-only parent route (WORD_BANK_V1 TASK-WB-013) |
| `WordPractice` | Main | Reachable only through `WordTopic` | Due-only dictation/recall session (max 20) | Serverless-only parent route (WORD_BANK_V1 TASK-WB-012) |
| `AIProviderSettings` | Main | Serverless-only notice, no config reads | Full provider editor | In-screen guard (TASK-AUDIT-016) |

## 3. Enforcement layers

1. **Navigation** — `RootNavigator` never mounts `AuthNavigator` in
   serverless mode, so no auth route exists there.
2. **Runtime gate** — `assertServerApiAllowed()` guards `api/client.ts`,
   `api/chatStream.ts` and `auth/authedRequest.ts`; any server transport
   attempted in serverless throws `ServerApiBlockedError` before any
   transport work, so nothing is ever transmitted.
3. **Screen guards** — server-only (`Vocabulary`) and serverless-only
   (`AIProviderSettings`) screens render an explicit mode notice and skip
   their data effects when mounted in the wrong mode (TASK-AUDIT-016), and
   both wait for the persisted mode to be restored before deciding.
4. **Conditioned UI** — `SettingsScreen` keeps the learning-level row in both
   modes (serverless backs it with the local SQLite profile, TASK-091) and
   hides the vocabulary row / account / logout in serverless plus the
   provider card / clear-local in server mode; `MessageActionsMenu` hides
   the server-only `Select text` entry in serverless (TASK-AUDIT-016); the
   Home "Real-life sentences" and "Word bank" rows exist only in serverless
   and carry the due-today badge (TASK-SENT-014, WORD_BANK_V1 TASK-WB-015).
5. **Auth restore isolation** — `AuthProvider` skips keychain reads and
   `/auth/me` entirely while serverless; stored server credentials are
   neither used nor removed by serverless usage.

## 4. Mode-dependent test coverage

| Area | Test file |
|---|---|
| Mode parsing/persistence/switching + transport gates | `applicationMode.test.tsx` |
| Cold-start routing per mode | `navigation.test.tsx` |
| Serverless journey end-to-end (zero server traffic) | `serverlessJourney.test.tsx` |
| Settings conditioning per mode | `SettingsScreen.test.tsx` |
| History per mode + disjoint stores | `HistoryScreen.test.tsx` |
| Level per mode | `LevelScreen.test.tsx` |
| Vocabulary server mode + serverless notice/no-fetch | `VocabularyScreen.test.tsx` |
| AI provider editor serverless + server-mode notice/no-reads | `AIProviderSettingsScreen.test.tsx`, `aiProviderSettingsLayout.test.tsx` |
| Menu action gating (`vocabularyEnabled`) | `MessageActionsMenu.test.tsx` |
| Home sentence row visibility, due badge and clear-data wipe | `homeSentenceRow.test.tsx`, `clearLocalData.test.ts` |
| Home word-bank row visibility, due badge, clear-data wipe and word screens' mode gating | `wordHomeRow.test.tsx`, `clearLocalData.test.ts`, `wordTopicsScreen.test.tsx` |
| Serverless entry from login | `LoginScreen.test.tsx` |
