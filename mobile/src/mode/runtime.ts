/**
 * Process-wide application-mode holder and the server-API gate
 * (SPEC TASK-080).
 *
 * Kept as a dependency-free leaf module so transport code (api/client,
 * api/chatStream) can consult the active mode without importing React
 * context and risking import cycles. ModeContext mirrors every restore and
 * transition into this holder; until the first restore completes the
 * process behaves as the default (server) mode.
 */
import {DEFAULT_APPLICATION_MODE} from './types';
import type {ApplicationMode} from './types';

/** Raised when serverless mode prevents a backend API call. */
export class ServerApiBlockedError extends Error {
  constructor() {
    super(
      'Serverless mode is active: your data stays on this device and server APIs are unavailable.',
    );
    this.name = 'ServerApiBlockedError';
  }
}

let currentMode: ApplicationMode = DEFAULT_APPLICATION_MODE;

export function getRuntimeApplicationMode(): ApplicationMode {
  return currentMode;
}

export function setRuntimeApplicationMode(mode: ApplicationMode): void {
  currentMode = mode;
}

/**
 * Throw unless backend traffic is currently permitted. Every transport that
 * can carry user data to the server must call this before opening a request,
 * guaranteeing serverless-local data is never accidentally sent to server
 * APIs.
 */
export function assertServerApiAllowed(): void {
  if (currentMode === 'serverless') {
    throw new ServerApiBlockedError();
  }
}
