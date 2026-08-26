/**
 * Explicit application modes (SPEC TASK-080).
 *
 * SERVER routes every conversation through the authenticated backend.
 * SERVERLESS keeps data on-device and talks to OpenRouter directly. The two
 * stores are intentionally isolated (ROADMAP §15): switching modes never
 * merges or synchronizes them.
 */
export const APPLICATION_MODES = ['server', 'serverless'] as const;

export type ApplicationMode = (typeof APPLICATION_MODES)[number];

/** Fresh installs start in the authenticated server mode. */
export const DEFAULT_APPLICATION_MODE: ApplicationMode = 'server';

/**
 * Deterministically validate an untrusted value (persisted storage, deep
 * links) into an application mode; null when it is not one.
 */
export function parseApplicationMode(value: unknown): ApplicationMode | null {
  if (typeof value === 'string' && (APPLICATION_MODES as readonly string[]).includes(value)) {
    return value as ApplicationMode;
  }
  return null;
}
