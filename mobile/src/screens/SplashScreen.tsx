/** Full-screen loading state shown while restoring the session. */
import React, {useMemo} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';

import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.background,
    },
  });
}

export function SplashScreen() {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container} testID="splash">
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}
