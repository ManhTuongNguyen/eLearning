/** Route parameter lists for the application navigators (SPEC TASK-043). */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { SampleTurn } from '../api/sessions';
import type { GuideId } from '../guide/types';

/** Stack shown to unauthenticated users. */
export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

/** Stack shown to authenticated users. */
export type MainStackParamList = {
  /**
   * Homepage hub (TASK-HOME-001): the landing screen that routes to every
   * main destination — conversations, listening practice, speaking
   * practice, history and settings.
   */
  Home: undefined;
  /**
   * Active conversation; absent until a session is opened/created.
   * `sampleTurns` carries the generated example conversation from session
   * creation (SPEC TASK-053) — it exists only in the creation response, so
   * it is handed over as a param instead of refetched. Absent for sessions
   * opened any other way, which hides the example entry point.
   */
  Chat: { sessionId?: number; sampleTurns?: SampleTurn[] } | undefined;
  /** New-conversation form (optional topic hint) — SPEC TASK-051. */
  NewConversation: undefined;
  History: undefined;
  /**
   * conversation header opens Settings (the screen slides down over Chat and
   * retracts upwards on Back). Other entry points keep the standard stack
   * push from the right.
   */
  Settings: { configSaved?: boolean } | undefined;
  /** Learning-level editor pushed from Settings (SPEC TASK-018). */
  Level: undefined;
  /** Saved-expression list pushed from Settings (SPEC TASK-072). */
  Vocabulary: undefined;
  /**
   * Serverless AI provider editor pushed from Settings (SPEC TASK-092).
   * On a successful save it pops back to Settings with `configSaved` so
   * the status card can flash the success toast (TASK-IMPROVEMENT-005).
   */
  AIProviderSettings: undefined;
  /** Speech output configuration pushed from Settings (TASK-TTS-001). */
  TTSSettings: undefined;
  /** Voice manager (installed system voices) pushed from TTS settings (TASK-TTS-003). */
  VoiceManager: undefined;
  /** Endless listening-practice trainer for spoken numbers and letters. */
  Practice: undefined;
  /**
   * Karaoke-style speaking practice pushed from Home.
   * `text` (with optional `material`/`minutes`) resumes a saved session
   * from SpeakingHistory: the screen opens directly in the reading phase
   * with the stored text instead of regenerating.
   * `mode: 'listen'` turns that resume into a text-to-speech session: the
   * engine speaks the stored text aloud and the teleprompter scroll follows
   * the real playback pace (no Settings speed), instead of the learner
   * reading aloud themselves.
   */
  SpeakingPractice:
    | { text: string; material?: string; minutes?: number; mode?: 'read' | 'listen' }
    | undefined;
  /** History of completed speaking practice sessions. */
  SpeakingHistory: undefined;
  /** Real-life sentences: topic list, topic editor, practice (TASK-SENT-008+). */
  SentenceTopics: undefined;
  /** Separate form for creating a topic, pushed from the topics list. */
  SentenceTopicNew: undefined;
  /** A topic's sentence bank (TASK-SENT-009). */
  SentenceTopic: { topicId: number };
  /** Spaced-repetition practice for one topic (TASK-SENT-012). */
  SentencePractice: { topicId: number };
  /**
   * Word bank: topic list (WORD_BANK_V1 TASK-WB-008). Serverless-only; the
   * Home row that opens it is hidden in server mode.
   */
  WordTopics: undefined;
  /** A topic's word bank (WORD_BANK_V1 TASK-WB-009). */
  WordTopic: { topicId: number };
  /** One word's data and schedule (WORD_BANK_V1 TASK-WB-013). */
  WordDetail: { wordId: number };
  /** Spaced-repetition practice for one word topic (WORD_BANK_V1 TASK-WB-012). */
  WordPractice: { topicId: number };
  /**
   * Guide hub: explains every feature, the AI requests each action makes and
   * how prompts use the learner profile. Pushed from the Home row.
   */
  Guide: undefined;
  /** One guide entry rendered as a full screen; `guideId` selects the content. */
  GuideDetail: { guideId: GuideId };
};

export type LoginScreenProps = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export type RegisterScreenProps = NativeStackScreenProps<AuthStackParamList, 'Register'>;

export type ChatScreenProps = NativeStackScreenProps<MainStackParamList, 'Chat'>;

export type NewConversationScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'NewConversation'
>;

export type LevelScreenProps = NativeStackScreenProps<MainStackParamList, 'Level'>;

export type VocabularyScreenProps = NativeStackScreenProps<MainStackParamList, 'Vocabulary'>;

export type AIProviderSettingsScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'AIProviderSettings'
>;

export type TTSSettingsScreenProps = NativeStackScreenProps<MainStackParamList, 'TTSSettings'>;

export type VoiceManagerScreenProps = NativeStackScreenProps<MainStackParamList, 'VoiceManager'>;

export type PracticeScreenProps = NativeStackScreenProps<MainStackParamList, 'Practice'>;

export type SpeakingPracticeScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'SpeakingPractice'
>;

export type SpeakingHistoryScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'SpeakingHistory'
>;

export type SentenceTopicsScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'SentenceTopics'
>;

export type SentenceTopicNewScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'SentenceTopicNew'
>;

export type SentenceTopicScreenProps = NativeStackScreenProps<MainStackParamList, 'SentenceTopic'>;

export type SentencePracticeScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'SentencePractice'
>;

export type WordTopicsScreenProps = NativeStackScreenProps<MainStackParamList, 'WordTopics'>;

export type WordTopicScreenProps = NativeStackScreenProps<MainStackParamList, 'WordTopic'>;

export type WordDetailScreenProps = NativeStackScreenProps<MainStackParamList, 'WordDetail'>;

export type WordPracticeScreenProps = NativeStackScreenProps<MainStackParamList, 'WordPractice'>;

export type GuideScreenProps = NativeStackScreenProps<MainStackParamList, 'Guide'>;

export type GuideDetailScreenProps = NativeStackScreenProps<MainStackParamList, 'GuideDetail'>;

export type HomeScreenProps = NativeStackScreenProps<MainStackParamList, 'Home'>;

export type SettingsScreenProps = NativeStackScreenProps<MainStackParamList, 'Settings'>;
