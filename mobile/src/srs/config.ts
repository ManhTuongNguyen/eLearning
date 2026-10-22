/**
 * FSRS scheduler configuration (TASK-SENT-015).
 *
 * These values mirror the knobs Anki exposes on a deck preset, plus the study
 * day rollover (Anki's "next day starts at"). They are stored once per local
 * collection in the `srs_config` table so an optimized weight set can be
 * written back without touching every sentence row.
 *
 * The pure scheduler receives this object; it never reads storage.
 */
import type { StepUnit } from 'ts-fsrs';

import { DEFAULT_ROLLOVER_HOUR } from './dayBoundary';

/** Where the model version used to train `weights` is recorded. */
export const DEFAULT_MODEL_VERSION = 'FSRS-6';

/**
 * Anki's defaults: 90% desired retention, 36500-day cap, fuzz on, FSRS-plus
 * learning steps (`1m 10m` for new cards, `10m` for relearning).
 */
export interface FsrsConfig {
  /** Optimized FSRS weights; `null` uses the package defaults for the model. */
  weights: readonly number[] | null;
  /** Target recall probability, in (0, 1]. Higher means more reviews. */
  desiredRetention: number;
  /** Hard cap on a review interval, in days (Anki default: 36500). */
  maximumInterval: number;
  /** Randomize long intervals by up to ±5%, as Anki does. */
  enableFuzz: boolean;
  /** Apply explicit (re)learning steps instead of pure FSRS short-term math. */
  enableShortTerm: boolean;
  /** Steps for a new card, e.g. `['1m', '10m']`. */
  learningSteps: readonly StepUnit[];
  /** Steps after a lapse, e.g. `['10m']`. */
  relearningSteps: readonly StepUnit[];
  /** Local hour at which a new study day starts (Anki default: 4). */
  rolloverHour: number;
}

export const DEFAULT_FSRS_CONFIG: FsrsConfig = {
  weights: null,
  desiredRetention: 0.9,
  maximumInterval: 36_500,
  enableFuzz: true,
  enableShortTerm: true,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  rolloverHour: DEFAULT_ROLLOVER_HOUR,
};

const STEP_PATTERN = /^\d+(?:\.\d+)?[mhd]$/;

/** Parse a whitespace/comma separated list of FSRS weights; invalid → null. */
export function parseWeights(value: string | null | undefined): number[] | null {
  if (!value) {
    return null;
  }
  const parts = value
    .split(/[\s,;]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const weights = parts.map(Number);
  return weights.every(weight => Number.isFinite(weight)) ? weights : null;
}

/** Serialize weights for the `srs_config.weights` text column. */
export function serializeWeights(weights: readonly number[] | null | undefined): string {
  return weights && weights.length > 0 ? weights.join(' ') : '';
}

/** Parse `'1m 10m'` into FSRS steps, falling back when the text is unusable. */
export function parseSteps(
  value: string | null | undefined,
  fallback: readonly StepUnit[],
): StepUnit[] {
  if (!value?.trim()) {
    return [...fallback];
  }
  const steps = value
    .split(/[\s,;]+/)
    .map(step => step.trim())
    .filter((step): step is StepUnit => STEP_PATTERN.test(step));
  return steps.length > 0 ? steps : [...fallback];
}

/** Serialize steps for the `srs_config` text columns. */
export function serializeSteps(steps: readonly StepUnit[]): string {
  return steps.join(' ');
}

/** Clamp a stored desired retention into the range FSRS accepts. */
export function clampRetention(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    return DEFAULT_FSRS_CONFIG.desiredRetention;
  }
  return value;
}

/** Clamp a stored maximum interval to a positive whole number of days. */
export function clampMaximumInterval(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_FSRS_CONFIG.maximumInterval;
  }
  return Math.round(value);
}

/** Clamp a stored rollover hour to a valid local hour. */
export function clampRolloverHour(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 23) {
    return DEFAULT_ROLLOVER_HOUR;
  }
  return Math.round(value);
}
