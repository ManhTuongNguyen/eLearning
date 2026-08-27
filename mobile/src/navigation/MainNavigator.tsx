/**
 * Main stack of the authenticated application (TASK-043): Chat, History and
 * Settings. NewConversation is the topic-hint form pushed from Chat
 * (TASK-051); Level and Vocabulary are pushed from Settings (TASK-018,
 * TASK-072); OpenRouterSettings is the serverless AI configuration editor
 * pushed from Settings (TASK-092).
 */
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {ChatScreen} from '../screens/ChatScreen';
import {HistoryScreen} from '../screens/HistoryScreen';
import {LevelScreen} from '../screens/LevelScreen';
import {NewConversationScreen} from '../screens/NewConversationScreen';
import {OpenRouterSettingsScreen} from '../screens/OpenRouterSettingsScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {VocabularyScreen} from '../screens/VocabularyScreen';
import type {MainStackParamList} from './types';

const Stack = createNativeStackNavigator<MainStackParamList>();

export function MainNavigator() {
  return (
    <Stack.Navigator initialRouteName="Chat" screenOptions={{headerShown: false}}>
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="NewConversation" component={NewConversationScreen} />
      <Stack.Screen name="History" component={HistoryScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Level" component={LevelScreen} />
      <Stack.Screen name="Vocabulary" component={VocabularyScreen} />
      <Stack.Screen name="OpenRouterSettings" component={OpenRouterSettingsScreen} />
    </Stack.Navigator>
  );
}
