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
  History: undefined;
  Settings: undefined;
  /** Learning-level editor pushed from Settings (SPEC TASK-018). */
  Level: undefined;
};

export type LoginScreenProps = NativeStackScreenProps<AuthStackParamList, 'Login'>;

export type RegisterScreenProps = NativeStackScreenProps<AuthStackParamList, 'Register'>;

export type ChatScreenProps = NativeStackScreenProps<MainStackParamList, 'Chat'>;

export type LevelScreenProps = NativeStackScreenProps<MainStackParamList, 'Level'>;

export type SettingsScreenProps = NativeStackScreenProps<MainStackParamList, 'Settings'>;
