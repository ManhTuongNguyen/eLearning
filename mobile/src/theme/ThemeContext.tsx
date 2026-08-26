/**
 * Theme state (SPEC TASK-044): light/dark/system modes with the system
 * preference respected while mode is 'system'. Screens consume the resolved
 * palette through `useTheme()` and never hard-code colors.
 */
import React, {createContext, useCallback, useContext, useMemo, useState} from 'react';

import {darkColors, lightColors} from './colors';
import type {ThemeColors} from './colors';
import {useSystemColorScheme} from './system';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';

export interface ThemeContextValue {
  /** User-selected mode; 'system' tracks the OS preference. */
  mode: ThemeMode;
  /** Concrete scheme after applying the mode to the system preference. */
  resolvedScheme: ResolvedScheme;
  /** Active palette; changes identity when the resolved scheme flips. */
  colors: ThemeColors;
  setMode(mode: ThemeMode): void;
}

const FALLBACK_SYSTEM_SCHEME: ResolvedScheme = 'light';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function resolveScheme(mode: ThemeMode, systemScheme: 'light' | 'dark' | null | undefined): ResolvedScheme {
  if (mode === 'system') {
    if (systemScheme === 'dark') {
      return 'dark';
    }
    return FALLBACK_SYSTEM_SCHEME;
  }
  return mode;
}

export function ThemeProvider({children}: {children: React.ReactNode}) {
  const [mode, setMode] = useState<ThemeMode>('system');
  const systemScheme = useSystemColorScheme();
  const resolvedScheme = resolveScheme(mode, systemScheme);

  const setModeStable = useCallback((next: ThemeMode) => {
    setMode(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedScheme,
      colors: resolvedScheme === 'dark' ? darkColors : lightColors,
      setMode: setModeStable,
    }),
    [mode, resolvedScheme, setModeStable],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
