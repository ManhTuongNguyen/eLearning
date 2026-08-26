/**
 * eLearning mobile app entry point.
 *
 * Root rendering is driven by authentication state restored from secure
 * storage on startup (SPEC TASK-015); navigation structure per SPEC TASK-043:
 * an auth stack for unauthenticated users and a main stack (Chat, History,
 * Settings) for authenticated ones.
 */
import {NavigationContainer} from '@react-navigation/native';
import React from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {AuthProvider} from './src/auth/AuthContext';
import {RootNavigator} from './src/navigation/RootNavigator';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AuthProvider>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

export default App;
