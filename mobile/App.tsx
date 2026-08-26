/**
 * eLearning mobile app entry point.
 *
 * Root rendering is driven by authentication state restored from secure
 * storage on startup (SPEC TASK-015); navigation structure per SPEC TASK-043:
 * an auth stack for unauthenticated users and a main stack (Chat, History,
 * Settings) for authenticated ones. Theming per SPEC TASK-044: the provider
 * resolves light/dark/system and both the status bar and the navigation
 * container follow the resolved scheme.
 */
import {NavigationContainer} from '@react-navigation/native';
import React from 'react';
import {StatusBar} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {AuthProvider} from './src/auth/AuthContext';
import {RootNavigator} from './src/navigation/RootNavigator';
import {navigationThemeFor} from './src/theme/navigationTheme';
import {ThemeProvider, useTheme} from './src/theme/ThemeContext';

function ThemedChrome({children}: {children: React.ReactNode}) {
  const {resolvedScheme, colors} = useTheme();
  return (
    <>
      <StatusBar
        barStyle={resolvedScheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      <NavigationContainer theme={navigationThemeFor(resolvedScheme)}>
        {children}
      </NavigationContainer>
    </>
  );
}

function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ThemedChrome>
            <RootNavigator />
          </ThemedChrome>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

export default App;
