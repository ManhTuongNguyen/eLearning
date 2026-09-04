/**
 * Theme state (SPEC TASK-044): light/dark/system modes with the system
 * preference respected while mode is 'system'. Screens consume the resolved
 * palette through `useTheme()` and never hard-code colors.
 *
 * The selected mode persists through AsyncStorage (preferences/theme): it is
 * restored once at startup — 'system' until then, exactly like a fresh
 * install — and every switch is saved best-effort, mirroring the
 * application-mode context's restore/persist pattern (TASK-080).
 */
import React, {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';

import {DEFAULT_THEME_MODE, loadThemeMode, saveThemeMode} from '../preferences/theme';
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
  const [mode, setMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const systemScheme = useSystemColorScheme();
  const resolvedScheme = resolveScheme(mode, systemScheme);

  // A theme switch landing before storage resolves must not be clobbered by
  // the restore: only apply the persisted value while no explicit choice has
  // been made yet.
  const switchedRef = useRef(false);

  // Restore the persisted mode once at mount. Until it lands the state stays
  // at the 'system' default, so the first frame always renders something
  // consistent with a fresh install.
  useEffect(() => {
    let cancelled = false;
    loadThemeMode().then(restoredMode => {
      if (!cancelled && !switchedRef.current) {
        setMode(restoredMode);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setModeStable = useCallback((next: ThemeMode) => {
    switchedRef.current = true;
    setMode(next);
    // Persistence is best-effort; the in-memory mode stays authoritative.
    saveThemeMode(next).catch(() => {
      // Storage failures never roll back an accepted theme switch.
    });
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
