/**
 * eLearning mobile app entry point.
 *
 * Root rendering is driven by authentication state restored from secure
 * storage on startup (SPEC TASK-015); navigation structure per SPEC TASK-043:
 * an auth stack for unauthenticated users and a main stack (Chat, History,
 * Settings) for authenticated ones. Theming per SPEC TASK-044: the provider
 * resolves light/dark/system and both the status bar and the navigation
 * container follow the resolved scheme. Application mode per SPEC TASK-080:
 * ModeProvider restores SERVER/SERVERLESS before screens mount and its
 * runtime gate blocks backend traffic while serverless.
 *
 * Edge-to-edge (Android 15+ enforcement for targetSdk 35+): the window
 * draws under the system status/navigation bars on modern devices, so the
 * shell below pads the whole tree with the safe-area insets — restoring the
 * legacy look (content below the bars) everywhere while staying a no-op on
 * Android versions without enforcement, where the insets are zero.
 */
import {NavigationContainer} from '@react-navigation/native';
import React from 'react';
import {StatusBar, StyleSheet, View} from 'react-native';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';

import {AuthProvider} from './src/auth/AuthContext';
import {ModeProvider} from './src/mode/ModeContext';
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

const shellStyles = StyleSheet.create({
  insetShell: {flex: 1},
});

/** Pads the app out of the system status/navigation bars (edge-to-edge). */
function InsetShell({children}: {children: React.ReactNode}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        shellStyles.insetShell,
        {paddingTop: insets.top, paddingBottom: insets.bottom},
      ]}>
      {children}
    </View>
  );
}

function App() {
  return (
    <SafeAreaProvider>
      <InsetShell>
        <ModeProvider>
          <ThemeProvider>
            <AuthProvider>
              <ThemedChrome>
                <RootNavigator />
              </ThemedChrome>
            </AuthProvider>
          </ThemeProvider>
        </ModeProvider>
      </InsetShell>
    </SafeAreaProvider>
  );
}

export default App;
