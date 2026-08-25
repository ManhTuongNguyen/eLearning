/**
 * eLearning mobile app entry point.
 *
 * Root rendering is driven by authentication state restored from secure
 * storage on startup (SPEC TASK-015).
 */
import React, {useState} from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {AuthProvider, useAuth} from './src/auth/AuthContext';
import {HomeScreen} from './src/screens/HomeScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {RegisterScreen} from './src/screens/RegisterScreen';
import {SplashScreen} from './src/screens/SplashScreen';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const {status} = useAuth();
  const [showRegister, setShowRegister] = useState(false);

  if (status === 'loading') {
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return showRegister ? (
      <RegisterScreen onSwitchToLogin={() => setShowRegister(false)} />
    ) : (
      <LoginScreen onSwitchToRegister={() => setShowRegister(true)} />
    );
  }

  return <HomeScreen />;
}

export default App;
