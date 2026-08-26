/**
 * Application mode state (SPEC TASK-080): SERVER vs SERVERLESS.
 *
 * Restores the persisted mode once at startup, exposes deterministic
 * switching, and mirrors every transition into the process-wide runtime
 * holder (`mode/runtime`) whose gate blocks backend traffic while
 * serverless — so serverless-local data can never accidentally reach server
 * APIs.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {loadApplicationMode, saveApplicationMode} from './modeStorage';
import {setRuntimeApplicationMode} from './runtime';
import {DEFAULT_APPLICATION_MODE, parseApplicationMode} from './types';
import type {ApplicationMode} from './types';

export type ModeStatus = 'loading' | 'ready';

export interface ModeContextValue {
  /** 'loading' until the persisted mode has been restored from storage. */
  status: ModeStatus;
  mode: ApplicationMode;
  /**
   * Switch modes deterministically: the runtime gate flips first, then the
   * React state, then the choice is persisted. Setting the same mode again
   * is an idempotent no-op.
   */
  setMode(mode: ApplicationMode): void;
}

const ModeContext = createContext<ModeContextValue | undefined>(undefined);

export function ModeProvider({children}: {children: React.ReactNode}) {
  const [status, setStatus] = useState<ModeStatus>('loading');
  const [mode, setModeState] = useState<ApplicationMode>(DEFAULT_APPLICATION_MODE);

  useEffect(() => {
    let cancelled = false;
    loadApplicationMode().then(restored => {
      if (!cancelled) {
        // Gate before render state so no request can slip through mid-restore.
        setRuntimeApplicationMode(restored);
        setModeState(restored);
        setStatus('ready');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ApplicationMode) => {
    // Normalize untrusted callers to a valid mode; TS makes this unreachable
    // from typed code but keeps switching deterministic for JS consumers.
    const valid = parseApplicationMode(next) ?? DEFAULT_APPLICATION_MODE;
    setRuntimeApplicationMode(valid);
    setModeState(valid);
    // Persistence is best-effort; the in-memory mode stays authoritative.
    saveApplicationMode(valid).catch(() => {
      // Storage failures never roll back an accepted mode switch.
    });
  }, []);

  const value = useMemo<ModeContextValue>(
    () => ({status, mode, setMode}),
    [status, mode, setMode],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useApplicationMode(): ModeContextValue {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error('useApplicationMode must be used within a ModeProvider');
  }
  return context;
}
