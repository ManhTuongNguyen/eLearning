/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { installAndroidSpeechEngine } from './src/tts/androidSpeech';
import { name as appName } from './app.json';

// Android-native TTS (SPEC TASK-077): no-op on platforms without the native
// module, where the TASK-076 stub stays active.
installAndroidSpeechEngine();

AppRegistry.registerComponent(appName, () => App);
