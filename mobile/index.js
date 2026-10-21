/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { installAndroidSpeechEngine } from './src/tts/androidSpeech';

// Android-native TTS (SPEC TASK-077): no-op on platforms without the native
// module, where the TASK-076 stub stays active.
installAndroidSpeechEngine();

AppRegistry.registerComponent(appName, () => App);
