/**
 * Seam over React Native's system color-scheme detection so tests can
 * simulate OS preference changes without touching native Appearance plumbing.
 */
import {useColorScheme} from 'react-native';

import type {ColorSchemeName} from 'react-native';

export function useSystemColorScheme(): ColorSchemeName {
  return useColorScheme();
}
