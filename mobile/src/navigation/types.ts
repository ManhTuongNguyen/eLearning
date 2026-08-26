/** Route parameter lists for the application navigators (SPEC TASK-043). */
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

/** Stack shown to unauthenticated users. */
export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

/** Stack shown to authenticated users. */
export type MainStackParamList = {
  /** Active conversation; absent until a session is opened/created. */
  Chat: {sessionId?: number} | undefined;
  /** New-conversation form (optional topic hint) — SPEC TASK-051. */
  NewConversation: undefined;
  History: undefined;
  Settings: undefined;
  /** Learning-level editor pushed from Settings (SPEC TASK-018). */
  Level: undefined;
};

export type LoginScreenProps = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export type RegisterScreenProps = NativeStackScreenProps<AuthStackParamList, 'Register'>;

export type ChatScreenProps = NativeStackScreenProps<MainStackParamList, 'Chat'>;

export type NewConversationScreenProps = NativeStackScreenProps<
  MainStackParamList,
  'NewConversation'
>;

export type LevelScreenProps = NativeStackScreenProps<MainStackParamList, 'Level'>;

export type SettingsScreenProps = NativeStackScreenProps<MainStackParamList, 'Settings'>;
