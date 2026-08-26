/**
 * Main stack of the authenticated application (TASK-043): Chat, History and
 * Settings. Level is the learning-level editor pushed from Settings.
 */
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {ChatScreen} from '../screens/ChatScreen';
import {HistoryScreen} from '../screens/HistoryScreen';
import {LevelScreen} from '../screens/LevelScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import type {MainStackParamList} from './types';

const Stack = createNativeStackNavigator<MainStackParamList>();

export function MainNavigator() {
  return (
    <Stack.Navigator initialRouteName="Chat" screenOptions={{headerShown: false}}>
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="History" component={HistoryScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Level" component={LevelScreen} />
    </Stack.Navigator>
  );
}
