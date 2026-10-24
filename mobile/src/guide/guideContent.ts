/**
 * The guide's content: one entry per app feature (see guide/types.ts).
 *
 * Every claim here is bound to the code: request counts mirror the
 * serverless services in src/serverless/ and the backend views, prompt
 * notes mirror the system prompts' level/context sections, and the steps
 * name the controls each screen actually renders. When a feature changes,
 * update its entry in the same commit.
 */
import type { GuideEntry, GuideId, GuideSection } from './types';

export const guideEntries: Record<GuideId, GuideEntry> = {
  conversations: {
    id: 'conversations',
    title: 'Conversations & chat',
    icon: 'chat',
    summary:
      'Start topic-based conversations, chat with streaming replies and use the long-press helpers.',
    intro:
      'Conversations are the heart of the app: you pick a topic, then chat with the AI tutor in English. ' +
      'The tutor never corrects you inside the conversation — corrections live in the separate ' +
      "'Improve my English' helper, so the chat itself stays natural.",
    steps: [
      'Open Conversations from Home, then tap Start a new conversation.',
      'Type a topic hint — one idea ("ordering coffee in London") or one question per line; the AI weaves all lines into a single topic. Leave it blank to let the AI choose.',
      'Tap Start. The AI creates the topic and a short example dialogue — tap Show me an example to read it before you write.',
      'Send messages normally; replies stream in live. If a reply fails, tap Try again on the message.',
      "Long-press any message: the tutor's messages offer suggested replies (what you could say next), read aloud and copy; your own messages offer Improve my English.",
      'The chat header jumps home, opens a new conversation, your history and settings.',
    ],
    aiIntro: 'Every step that generates text talks to your AI provider:',
    aiUsage: [
      {
        action: 'Start a conversation (topic + example)',
        requests: '1 request',
        note: 'Serverless merges topic and example into one call; server mode makes two.',
      },
      {
        action: 'Send a message',
        requests: '1 request, streamed',
        note: 'The reply streams in token by token.',
      },
      {
        action: 'Retry a failed reply',
        requests: '1 request, streamed',
        note: 'Re-sends the same turn.',
      },
      { action: 'Suggested replies (long-press)', requests: '1 request' },
      {
        action: 'Improve my English (long-press)',
        requests: '1 request, cached',
        note: 'The result is stored with the message; opening it again never costs another request.',
      },
      {
        action: 'Conversation memory',
        requests: 'Background, rare',
        note: 'About one summary request per 40 messages, so long chats stay remembered.',
      },
    ],
    promptTips: [
      'Your English level is in every prompt: the tutor keeps vocabulary and grammar at that level. Set it under Settings > Learning level.',
      'With level AUTO the tutor infers an appropriate level from how you write.',
      'Your topic hint (or question list) becomes the topic the whole dialogue is built around.',
      'The tutor sees the topic, a rolling summary of the conversation and your last ~20 messages — you never need to repeat context.',
      "'Improve my English' corrects your message and extends it pitched one CEFR sub-level above yours (C2 caps at C2).",
    ],
    tips: [
      'Write topic hints as questions you actually want to ask.',
      'Turn on Grammar auto-check in Settings to check every message automatically — it costs one extra request per message.',
      'Scroll up freely: auto-scroll pauses while you read and a pill offers the way back down.',
    ],
    tryIt: { label: 'Start a new conversation', route: 'NewConversation' },
  },

  history: {
    id: 'history',
    title: 'History',
    icon: 'history',
    summary: 'Revisit, rename or delete your past conversations.',
    intro:
      'History lists every past conversation so you can continue any of them. The data source follows the ' +
      'active mode: server mode reads the backend, serverless mode reads the conversations stored on this device.',
    steps: [
      'Open History from Home (or from the chat header).',
      'Tap a row to continue that conversation.',
      "Use the row's rename action to retitle it.",
      "Delete a conversation with the row's delete action — an inline confirmation step asks before removing it.",
      'Older pages append through the Load more control.',
    ],
    aiIntro: 'Browsing history never calls the AI.',
    aiUsage: [
      {
        action: 'Everything in History',
        requests: 'No AI requests',
        note: 'Reads the server API or the on-device database, following the active mode.',
      },
    ],
    promptTips: [],
    tips: [
      'The list refreshes silently whenever you return to it, so it never shows stale rows.',
      "Deleting removes the conversation for the active mode only — the other mode's data is untouched.",
    ],
    tryIt: { label: 'Open History', route: 'History' },
  },

  listening: {
    id: 'listening',
    title: 'Listening practice',
    icon: 'listening',
    summary: 'Endless ear training for spoken numbers and letters.',
    intro:
      'The app speaks a word form through the device TTS engine ("nineteen ninety-seven", "b") and you either ' +
      'pick the matching digits or letter from four acoustically confusable options, or type what you heard. ' +
      'Feedback is instant and a running score keeps the session honest.',
    steps: [
      'Open Listening practice from Home.',
      'Tap the large replay control to hear the word form again as often as you need.',
      'Pick the matching option, or switch to typed mode and type what you heard, then Check.',
      'The next question is always ready — the loop is endless. End practice reveals your session summary.',
    ],
    aiIntro:
      "This trainer is fully on-device: questions come from the app's own generator and speech uses the Android TTS engine.",
    aiUsage: [{ action: 'Everything in Listening practice', requests: 'No AI requests' }],
    promptTips: [],
    tips: [
      'Voice, rate and pitch follow your text-to-speech settings — the trainer uses the same engine as chat.',
      'Use the round-mode controls to focus on the forms you keep missing.',
    ],
    tryIt: { label: 'Open Listening practice', route: 'Practice' },
  },

  speaking: {
    id: 'speaking',
    title: 'Speaking practice',
    icon: 'speaking',
    summary: 'Karaoke read-aloud trainer with AI-generated material.',
    intro:
      'You give the AI a topic, a list of questions or your own text plus a session length; it returns a ' +
      'read-aloud text sized to the minutes. The text then scrolls like a teleprompter while you read it aloud — ' +
      'finished sessions are saved to Speaking history, where they can be re-read or listened to.',
    steps: [
      'Open Speaking practice from Home.',
      'Enter a topic, a list of questions, or paste your own text.',
      'Pick the session length in minutes.',
      'Tap Generate practice text — one AI request returns the material.',
      'Read aloud while the text auto-scrolls; adjust the speed slider, pause, restart or end early.',
      'Reaching the end (or pressing End) shows a summary with your elapsed time and word count.',
      'In Speaking history, tap a row to read it again, or its Listen button to have the voice read it aloud.',
    ],
    aiIntro: 'One AI request generates the material; the practice itself runs on-device.',
    aiUsage: [
      {
        action: 'Generate practice text',
        requests: '1 request',
        note: 'Longer sessions produce longer texts — the prompt uses a word budget of about 140 words per minute.',
      },
      {
        action: 'Re-read or listen to a saved session',
        requests: 'No AI requests',
        note: 'Reuses the stored text; Listen mode speaks it with device TTS.',
      },
    ],
    promptTips: [
      'Your English level shapes the difficulty of the generated text.',
      'Questions you type are woven into the material; pasted text is used as-is.',
      'Minutes set the word budget: roughly 140 words per minute of practice.',
    ],
    tips: [
      'Serverless mode only — add your provider API key in Settings first.',
      "Use Speaking history's Listen mode to turn any saved text into listening practice.",
    ],
    mode: 'serverless',
    tryIt: { label: 'Open Speaking practice', route: 'SpeakingPractice' },
  },

  sentences: {
    id: 'sentences',
    title: 'Real-life sentences',
    icon: 'sentences',
    summary: 'Collect everyday English per topic and drill it with spaced repetition.',
    intro:
      'Each topic holds a bank of real-life sentences generated around a scenario you describe. Review a batch ' +
      'before it is saved, play any sentence aloud, and once a topic has at least five sentences, spaced-repetition ' +
      'practice unlocks — Anki-style, with intervals shown on every grade button.',
    steps: [
      'Open Real-life sentences from Home and create a topic — a title is required, the description is where you describe the scenario ("meeting someone new in a new city").',
      'Open the topic and tap Generate to fetch a batch; review the candidates before they are saved.',
      "Tap a sentence's speaker button to hear it; delete the ones you do not want.",
      'At 5+ sentences, Practice unlocks: new and relearning sentences are dictated for you to type, review sentences are recalled from their situation.',
      'Grade each card (Again / Hard / Good / Easy) — each button shows the interval it schedules, like Anki.',
    ],
    aiIntro: 'Only generation talks to the AI; review, grading and playback are on-device.',
    aiUsage: [
      {
        action: 'Generate a batch of sentences',
        requests: '1 request',
        note: 'Batch size is yours to choose; your existing sentences are sent along so the AI avoids repeats.',
      },
      {
        action: 'Practice and grading',
        requests: 'No AI requests',
        note: 'FSRS scheduling runs on-device; playback is device TTS.',
      },
    ],
    promptTips: [
      'Your English level controls the difficulty and vocabulary of generated sentences.',
      'The topic title and description shape the situation the sentences come from — write the scenario you want to master.',
      'An optional learner note steers the register (slang, workplace English, travel...).',
    ],
    tips: [
      'The due badges on Home and in the topic list show how many sentences are due today.',
      'A forced practice mode in Settings overrides the automatic dictation/recall mix.',
    ],
    mode: 'serverless',
    tryIt: { label: 'Open Real-life sentences', route: 'SentenceTopics' },
  },

  wordBank: {
    id: 'wordBank',
    title: 'Word bank',
    icon: 'words',
    summary:
      'Topic vocabulary: the AI picks words, a real dictionary fills the data, FSRS drills them.',
    intro:
      'Each topic builds vocabulary around a learner-context description you write. The AI only chooses WHICH ' +
      'words to include; definitions, phonetics and examples come from the Free Dictionary API, so the data you ' +
      'study is verified — never AI-invented. Practice is Anki-style spaced repetition with dictation and ' +
      'meaning-recall cards.',
    steps: [
      'Open Word bank from Home and create a topic: a title plus a learner-context description (your domain, habits, self-described level) and optionally an extra AI prompt.',
      'In the topic, tap the ⋯ menu and choose Generate new words; enter how many (1–30, default 10).',
      'The summary separates words kept with dictionary data, kept without data (fetch later from Word detail), and not-found words.',
      'Search the list, play pronunciations, tap a word for its full data, or add words manually through the ⋯ menu.',
      "On a word's detail screen, Fetch dictionary data fills missing senses; Enrich asks the AI to draft the learning data — you approve the proposal in a modal before anything is saved.",
      'Practice unlocks at 5+ words: type dictations, or recall the masked word from its meanings and examples. Checking shows a word-by-word diff of your answer — wrong words underlined, with the expected spelling after an arrow — like sentence dictation.',
    ],
    aiIntro:
      'Generation and enrichment each cost one request; dictionary data comes from the Free Dictionary API, not the AI.',
    aiUsage: [
      {
        action: 'Generate new words (1–30)',
        requests: '1 request',
        note: 'Followed by free dictionary lookups, which are not AI requests.',
      },
      {
        action: 'Enrich a word (detail screen)',
        requests: '1 request',
        note: 'Produces a proposal only — nothing is saved until you approve it.',
      },
      { action: 'Manual add, practice, grading', requests: 'No AI requests' },
    ],
    promptTips: [
      'Your English level shapes the definition and example the AI writes.',
      'The learner-context description is the strongest lever: "IT developer who reads docs all day" beats "technology".',
      "The optional extra prompt is appended to the AI's instructions.",
      'The AI never writes definitions — if the dictionary has nothing, only an approved Enrich proposal can complete the word.',
    ],
    tips: [
      "The due badges on Home and in the topic list show today's workload.",
      'Words without dictionary data stay out of practice until they are completed or enriched.',
      'Dictionary data is Wiktionary content under the CC BY-SA 4.0 license, served by the Free Dictionary API at freedictionaryapi.com.',
    ],
    mode: 'serverless',
    tryIt: { label: 'Open Word bank', route: 'WordTopics' },
  },

  aiUsage: {
    id: 'aiUsage',
    title: 'How the app uses AI',
    icon: 'generate',
    summary: 'What talks to the AI, what it costs, and where your key lives.',
    intro:
      'The app works in two isolated modes. Serverless (the default) calls your AI provider directly with your ' +
      "own API key, stored in this device's secure storage. Server mode talks to a backend that holds its own " +
      'key. In both, AI requests happen only when you act — plus one rare background summary — and everything ' +
      'else (practice, review scheduling, speech, dictionary data) is on-device or a free API.',
    steps: [
      'Pick the mode in Settings: serverless uses your own key on this device; server connects to a backend.',
      'In serverless, configure provider, key and models under AI provider.',
      'Set your English level — it is injected into every prompt.',
      'Generation features cost one request per tap; chat streams one request per message.',
    ],
    aiIntro: 'Requests per action, across the whole app:',
    aiUsage: [
      {
        action: 'New conversation (topic + example)',
        requests: '1 request',
        note: 'Two in server mode (topic, then example).',
      },
      { action: 'Chat message / retry', requests: '1 streamed request' },
      { action: 'Suggested replies', requests: '1 request' },
      {
        action: 'Improve my English',
        requests: '1 request, cached',
        note: 'Results are stored; repeats never re-bill.',
      },
      {
        action: 'Grammar auto-check',
        requests: '1 extra per message',
        note: 'Opt-in toggle in Settings.',
      },
      {
        action: 'Conversation memory',
        requests: 'Background',
        note: 'About one summary per 40 messages.',
      },
      { action: 'Word bank: generate / enrich', requests: '1 request each' },
      { action: 'Sentences: generate', requests: '1 request per batch' },
      { action: 'Speaking: generate', requests: '1 request per session' },
      {
        action: 'Practice, review, speech, dictionary',
        requests: 'No AI requests',
        note: 'On-device engines and the Free Dictionary API.',
      },
    ],
    promptTips: [
      'Every prompt carries your CEFR level (A1–C2 or AUTO); "Improve my English" targets one sub-level up.',
      'Prompts combine your level, the topic or scenario, your input and — in chat — the conversation summary plus recent messages.',
      'Learner-context notes are wrapped as untrusted data: text inside them is never followed as instructions.',
    ],
    tips: [
      'Tokens are billed by your provider — the app has no quotas of its own. Cached results never cost another request.',
      'Fallback models take over only when the primary model fails with a retryable error.',
      'Definitions are never AI-invented; the AI proposes learning data only when the dictionary has nothing.',
    ],
    tryIt: { label: 'Open Settings', route: 'Settings' },
  },

  level: {
    id: 'level',
    title: 'Your English level',
    icon: 'target',
    summary: 'The single most impactful setting: your CEFR level is part of every AI prompt.',
    intro:
      "The app asks for your CEFR level (A1–C2) or AUTO. It shapes the tutor's vocabulary, generated words, " +
      'sentences and reading texts, and how corrections are pitched. Set it once, change it anytime — the very ' +
      'next request uses the new level.',
    steps: [
      'Open Settings > Learning level (or tap Try it now below).',
      'Pick A1–C2 if you know your level; pick AUTO to let the AI infer it from how you write.',
      'The choice saves immediately in both modes.',
    ],
    aiIntro: 'How the level lands in prompts (at no extra request cost):',
    aiUsage: [
      {
        action: 'Chat, topics, suggested replies',
        requests: 'Level line in the prompt',
        note: '"Keep vocabulary, grammar and explanations at that level."',
      },
      {
        action: 'Improve my English',
        requests: 'Level line in the prompt',
        note: 'Corrections plus an extension pitched one CEFR sub-level up (C2 caps at C2); with AUTO it only corrects.',
      },
      {
        action: 'Generated words, sentences, reading texts',
        requests: 'Level line in the prompt',
        note: 'All pitched at your level.',
      },
    ],
    promptTips: [
      'Too low a level makes replies simplistic; too high makes them discouraging — be honest.',
      'The canonical prompt line is: "The learner\'s English level is {level} (CEFR); keep vocabulary, grammar and explanations at that level."',
      'With AUTO the prompt instead asks the AI to infer an appropriate level from how you write.',
    ],
    tips: [
      'Change it anytime — the next request uses the new level immediately.',
      'Not sure? Take a quick online CEFR test, or leave AUTO for the first week and see what the AI assumed.',
    ],
    tryIt: { label: 'Set your level', route: 'Level' },
  },

  provider: {
    id: 'provider',
    title: 'AI provider & models',
    icon: 'settings',
    summary:
      'Serverless only: pick OpenRouter, Gemini or OpenAI, store your key securely, order fallback models.',
    intro:
      'In serverless mode every AI request goes straight from this device to the provider you choose, with your ' +
      "own API key. The key lives in the device's secure storage, is never displayed or logged, and is sent only " +
      'to that provider. Each provider gets its own namespace, so switching never mixes keys or model ids.',
    steps: [
      'Open Settings > AI provider (serverless mode only).',
      'Pick a provider and paste its API key.',
      'Choose a primary model; add fallback models and order them with the move up/down controls.',
      "Tap Refresh on the model catalog to fetch the provider's model list — OpenRouter's is public; Gemini and OpenAI need your key.",
    ],
    aiIntro:
      "This screen itself makes no AI requests — the catalog refresh reads the provider's model list, not a completion.",
    aiUsage: [
      {
        action: 'Refresh model catalog',
        requests: 'No completion cost',
        note: "Hits the provider's /models endpoint; snapshots older than a day are labelled stale but stay usable.",
      },
      {
        action: 'Every AI feature in the app',
        requests: 'Billed by your provider',
        note: 'All requests use your key directly — check your provider dashboard for usage.',
      },
    ],
    promptTips: [
      'Only retryable failures move a request to the next fallback model.',
      'The model catalog is read from the locally cached snapshot; the network is only hit through the explicit Refresh control.',
    ],
    tips: [
      'OpenRouter lists free models — look for ":free" entries in the catalog.',
      'Generate features tell you when the key is missing: add it in Settings before generating.',
    ],
    mode: 'serverless',
    tryIt: { label: 'Open AI provider settings', route: 'AIProviderSettings' },
  },

  tts: {
    id: 'tts',
    title: 'Text to speech',
    icon: 'speaker',
    summary: 'Voice, rate and pitch for everything the app says aloud.',
    intro:
      'All spoken audio — chat read-aloud, listening training, practice playback and speaking Listen mode — comes ' +
      'from the Android TTS engine installed on your device. Settings apply immediately, with a preview to hear ' +
      'the result, and the Voice manager lists every English voice your device offers.',
    steps: [
      'Open Settings > Text to speech.',
      'Adjust the rate and pitch sliders; tap Preview to hear a sample sentence with the current configuration.',
      'Open Voice manager to search the installed English voices, audition them and filter to instantly available ones.',
      'Reset restores the system default voice.',
    ],
    aiIntro: 'Speech is rendered on-device — no AI requests, no network.',
    aiUsage: [{ action: 'Everything speech-related', requests: 'No AI requests' }],
    promptTips: [],
    tips: [
      'Changes apply live — chat picks them up without a restart.',
      'Non-English voices are hidden on purpose: the app speaks English only.',
    ],
    tryIt: { label: 'Open Text-to-speech settings', route: 'TTSSettings' },
  },

  vocabulary: {
    id: 'vocabulary',
    title: 'Vocabulary (server mode)',
    icon: 'list',
    summary: 'Saved expressions from chat, enriched in the background; export to Anki CSV.',
    intro:
      'In server mode you can select text in any chat message and save it as an expression. Each new expression ' +
      'is enriched in the background — exactly one AI request fills definition, plain-English gloss, ' +
      'pronunciation, part of speech and an example. Serverless users: the Word bank is the equivalent feature.',
    steps: [
      'In a conversation, long-press a message and choose Select text; select an expression and tap Save word.',
      'Open Settings > Vocabulary to see your saved expressions, newest first.',
      'Rows show their enrichment state: Enriching…, failed (with a retry action), or complete with its fields.',
      'Use Load more for older items.',
      'Tap Export CSV to hand an Anki-compatible file to the share sheet.',
    ],
    aiIntro: 'Saving is free; enrichment is exactly one background AI request per new expression.',
    aiUsage: [
      {
        action: 'Save word from chat',
        requests: 'No AI requests',
        note: 'The save itself is instant.',
      },
      {
        action: 'Enrichment of a new expression',
        requests: '1 background request',
        note: 'Runs on the server with up to 5 retries; duplicates never re-enrich.',
      },
      { action: 'Export CSV', requests: 'No AI requests' },
    ],
    promptTips: [
      'Enrichment uses the level of the conversation you saved from, falling back to your profile level, then AUTO.',
      'Definitions are kept at that level; the gloss field is a plain-English equivalent, not a translation to your native language.',
    ],
    tips: [
      'Server mode only — in serverless mode, use the Word bank instead.',
      'A failed enrichment can be retried right from its row.',
    ],
    mode: 'server',
    tryIt: { label: 'Open Vocabulary', route: 'Vocabulary' },
  },
};

/** Hub grouping, mirroring the Home hub's sections. */
export const guideSections: GuideSection[] = [
  { title: 'Conversations', ids: ['conversations', 'history'] },
  { title: 'Practice', ids: ['listening', 'speaking', 'sentences', 'wordBank'] },
  { title: 'AI & settings', ids: ['aiUsage', 'level', 'provider', 'tts', 'vocabulary'] },
];

/** Badge text for a mode-specific entry, shown on the hub and the guide page. */
export function guideModeBadge(mode: 'server' | 'serverless'): string {
  return mode === 'serverless' ? 'Serverless only' : 'Server only';
}
