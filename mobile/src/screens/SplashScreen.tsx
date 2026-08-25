/** Full-screen loading state shown while restoring the session. */
import React from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';

export function SplashScreen() {
  return (
    <View style={styles.container} testID="splash">
      <ActivityIndicator size="large" color="#2563eb" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f6f8',
  },
});
