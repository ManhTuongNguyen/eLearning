/**
 * Mapping from the active app palette to a React Navigation theme so stack
 * chrome (headers, backgrounds) stays consistent with SPEC TASK-044 tokens.
 */
import {DarkTheme, DefaultTheme} from '@react-navigation/native';
import type {Theme as NavigationTheme} from '@react-navigation/native';

import {darkColors, lightColors} from './colors';
import type {ResolvedScheme} from './ThemeContext';

export function navigationThemeFor(scheme: ResolvedScheme): NavigationTheme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const colors = scheme === 'dark' ? darkColors : lightColors;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
      notification: colors.danger,
    },
  };
}
