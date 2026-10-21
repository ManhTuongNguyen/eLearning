/**
 * Seam over React Native's system color-scheme detection so tests can
 * simulate OS preference changes without touching native Appearance plumbing.
 */

import type { ColorSchemeName } from 'react-native';
import { useColorScheme } from 'react-native';

export function useSystemColorScheme(): ColorSchemeName {
  return useColorScheme();
}
