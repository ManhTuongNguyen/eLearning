/**
 * Main stack of the authenticated application (TASK-043): Home is the
 * homepage hub routing to every destination; Chat, History and Settings
 * remain direct stack entries. NewConversation is the topic-hint/questions
 * form pushed from Chat (TASK-051); Level and Vocabulary are pushed from
 * Settings (TASK-018, TASK-072); AIProviderSettings is the serverless AI
 * configuration editor pushed from Settings (TASK-092); Practice is the
 * listening trainer and SpeakingPractice the karaoke read-aloud screen.
 */
import {createNativeStackNavigator} from '@react-navigation/native-stack';

import {AIProviderSettingsScreen} from '../screens/AIProviderSettingsScreen';
import {ChatScreen} from '../screens/ChatScreen';
import {HistoryScreen} from '../screens/HistoryScreen';
import {HomeScreen} from '../screens/HomeScreen';
import {LevelScreen} from '../screens/LevelScreen';
import {NewConversationScreen} from '../screens/NewConversationScreen';
import {PracticeScreen} from '../screens/PracticeScreen';
import {SentenceTopicsScreen} from '../screens/SentenceTopicsScreen';
import {SentenceTopicScreen} from '../screens/SentenceTopicScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {SpeakingHistoryScreen} from '../screens/SpeakingHistoryScreen';
import {SpeakingPracticeScreen} from '../screens/SpeakingPracticeScreen';
import {TTSSettingsScreen} from '../screens/TTSSettingsScreen';
import {VoiceManagerScreen} from '../screens/VoiceManagerScreen';
import {VocabularyScreen} from '../screens/VocabularyScreen';
import type {MainStackParamList} from './types';

const Stack = createNativeStackNavigator<MainStackParamList>();

export function MainNavigator() {
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{headerShown: false}}>
      <Stack.Screen name="Home" component={HomeScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="NewConversation" component={NewConversationScreen} />
      <Stack.Screen name="History" component={HistoryScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Level" component={LevelScreen} />
      <Stack.Screen name="Vocabulary" component={VocabularyScreen} />
      <Stack.Screen name="AIProviderSettings" component={AIProviderSettingsScreen} />
      <Stack.Screen name="TTSSettings" component={TTSSettingsScreen} />
      <Stack.Screen name="VoiceManager" component={VoiceManagerScreen} />
      <Stack.Screen name="Practice" component={PracticeScreen} />
      <Stack.Screen name="SpeakingPractice" component={SpeakingPracticeScreen} />
      <Stack.Screen name="SpeakingHistory" component={SpeakingHistoryScreen} />
      <Stack.Screen name="SentenceTopics" component={SentenceTopicsScreen} />
      <Stack.Screen name="SentenceTopic" component={SentenceTopicScreen} />
    </Stack.Navigator>
  );
}
