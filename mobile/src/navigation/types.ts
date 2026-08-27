/** Route parameter lists for the application navigators (SPEC TASK-043). */
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import type {SampleTurn} from '../api/sessions';

/** Stack shown to unauthenticated users. */
export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

/** Stack shown to authenticated users. */
export type MainStackParamList = {
  /**
   * Active conversation; absent until a session is opened/created.
   * `sampleTurns` carries the generated example conversation from session
   * creation (SPEC TASK-053) — it exists only in the creation response, so
   * it is handed over as a param instead of refetched. Absent for sessions
   * opened any other way, which hides the example entry point.
   */
  Chat: {sessionId?: number; sampleTurns?: SampleTurn[]} | undefined;
  /** New-conversation form (optional topic hint) — SPEC TASK-051. */
  NewConversation: undefined;
  History: undefined;
  Settings: undefined;
  /** Learning-level editor pushed from Settings (SPEC TASK-018). */
  Level: undefined;
  /** Saved-expression list pushed from Settings (SPEC TASK-072). */
  Vocabulary: undefined;
  /** Serverless OpenRouter editor pushed from Settings (SPEC TASK-092). */
  OpenRouterSettings: undefined;
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

export type OpenRouterSettingsScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'OpenRouterSettings'
>;

export type SettingsScreenProps = NativeStackScreenProps<MainStackParamList, 'Settings'>;
