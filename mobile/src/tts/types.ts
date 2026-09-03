/**
 * Shared text-to-speech types and normalization helpers (SPEC TASK-076
 * extension). Everything the TTS settings surfaces, the engine adapter and
 * the persistence layer exchange flows through these shapes: the system
 * Android Speech module is the one engine behind the TextToSpeechEngine
 * seam, configured by voice/rate/pitch/latency preferences.
 */

/** Stable id of the (single) speech engine. */
export type SpeechEngineId = 'system';

export const SPEECH_ENGINE_IDS: readonly SpeechEngineId[] = ['system'];

export function isSpeechEngineId(value: unknown): value is SpeechEngineId {
  return value === 'system';
}

/** Voice gender bucket; `unknown` when the engine does not report it. */
export type SpeechGender = 'female' | 'male' | 'unknown';

/** Google-style quality bucket reported by the Android voice metadata. */
export type SpeechVoiceQuality =
  | 'very_low'
  | 'low'
  | 'normal'
  | 'high'
  | 'very_high'
  | 'unknown';

/** Google-style latency bucket reported by the Android voice metadata. */
export type SpeechVoiceLatency =
  | 'very_low'
  | 'low'
  | 'normal'
  | 'high'
  | 'very_high'
  | 'unknown';

/** One installed system-engine voice (Android Speech.getVoices row). */
export interface SpeechVoiceInfo {
  /** Stable voice id passed back to speakWith({voiceId}). */
  readonly id: string;
  /** Display name; usually equals the id on Android. */
  readonly name: string;
  /** Voice locale as reported by the engine (e.g. "en_US"). */
  readonly language: string;
  readonly quality: SpeechVoiceQuality;
  readonly latency: SpeechVoiceLatency;
  /** True when the voice needs a network fetch before it can speak. */
  readonly network: boolean;
  /** Heuristic gender from the voice name; unknown when undetectable. */
  readonly gender: SpeechGender;
}

/** One installed system TTS engine (e.g. Google TTS vs Samsung TTS). */
export interface SpeechEngineInfo {
  /** Engine package id passed back to setDefaultEngine(). */
  readonly id: string;
  /** Human label for display. */
  readonly label: string;
  /** True when this engine currently backs the system Speech module. */
  readonly isDefault: boolean;
}

/** Boundaries kept in one place so clamping stays consistent everywhere. */
export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 2.0;
export const SPEECH_RATE_STEP = 0.05;
export const SPEECH_PITCH_MIN = 0.5;
export const SPEECH_PITCH_MAX = 2.0;
export const SPEECH_PITCH_STEP = 0.05;
export const SPEECH_LATENCY_MAX_MS = 3000;
export const SPEECH_LATENCY_MIN_MS = 300;

/** User-facing TTS preferences persisted across launches. */
export interface SpeechPreferences {
  /** Which engine renders speech (only 'system' exists). */
  readonly engine: SpeechEngineId;
  /** Selected system voice id; null = engine default voice. */
  readonly systemVoiceId: string | null;
  /** System engine package; null = platform default engine. */
  readonly systemEngineId: string | null;
  /** Preferred gender used to highlight/filter voices in pickers. */
  readonly gender: 'any' | SpeechGender;
  /** Speech rate multiplier (1.0 = normal). */
  readonly rate: number;
  /** Voice pitch multiplier (1.0 = normal). */
  readonly pitch: number;
  /**
   * Latency/quality trade-off. True = instant speech with on-device voices
   * only (network voices filtered out of the system picker). False = allow
   * higher-quality network voices that may fetch data on first use.
   */
  readonly instantOnly: boolean;
  /** Maximum tolerated synthesis latency budget (ms, informational). */
  readonly maxLatencyMs: number;
}

/** Preference defaults: the previous app behavior (system default voice). */
export const DEFAULT_SPEECH_PREFERENCES: SpeechPreferences = {
  engine: 'system',
  systemVoiceId: null,
  systemEngineId: null,
  gender: 'any',
  rate: 1.0,
  pitch: 1.0,
  instantOnly: true,
  maxLatencyMs: 1500,
};

/** True when the value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Clamps `value` into [min, max] and snaps it onto multiples of `step`. */
export function clampWithStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = Math.round(clamped / step) * step;
  const snappedClamped = Math.min(max, Math.max(min, snapped));
  // Avoid binary-float dust like 0.8500000000000001 in stored values.
  return Math.round(snappedClamped * 100) / 100;
}

/** Parses an unknown value into a speech engine id, or null when invalid. */
export function parseSpeechEngineId(value: unknown): SpeechEngineId | null {
  return isSpeechEngineId(value) ? value : null;
}

/** Parses an unknown value into a gender bucket, or null when invalid. */
export function parseSpeechGender(value: unknown): SpeechGender | null {
  return value === 'female' || value === 'male' || value === 'unknown'
    ? value
    : null;
}

/**
 * Normalizes a parsed-or-corrupt preferences record into a fully valid
 * SpeechPreferences object. Unknown/corrupt fields fall back to the defaults
 * instead of failing, mirroring the app's other preference stores.
 */
export function normalizeSpeechPreferences(raw: unknown): SpeechPreferences {
  const source =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const gender = parseSpeechGender(source.gender);
  const engine = parseSpeechEngineId(source.engine);
  const rate = isFiniteNumber(source.rate)
    ? clampWithStep(source.rate, SPEECH_RATE_MIN, SPEECH_RATE_MAX, SPEECH_RATE_STEP)
    : DEFAULT_SPEECH_PREFERENCES.rate;
  const pitch = isFiniteNumber(source.pitch)
    ? clampWithStep(source.pitch, SPEECH_PITCH_MIN, SPEECH_PITCH_MAX, SPEECH_PITCH_STEP)
    : DEFAULT_SPEECH_PREFERENCES.pitch;
  const maxLatencyMs = isFiniteNumber(source.maxLatencyMs)
    ? Math.min(
        SPEECH_LATENCY_MAX_MS,
        Math.max(SPEECH_LATENCY_MIN_MS, Math.round(source.maxLatencyMs)),
      )
    : DEFAULT_SPEECH_PREFERENCES.maxLatencyMs;
  return {
    engine: engine ?? DEFAULT_SPEECH_PREFERENCES.engine,
    systemVoiceId:
      typeof source.systemVoiceId === 'string' && source.systemVoiceId
        ? source.systemVoiceId
        : null,
    systemEngineId:
      typeof source.systemEngineId === 'string' && source.systemEngineId
        ? source.systemEngineId
        : null,
    gender:
      gender === 'unknown' ? 'any' : (gender ?? DEFAULT_SPEECH_PREFERENCES.gender),
    rate,
    pitch,
    instantOnly:
      typeof source.instantOnly === 'boolean'
        ? source.instantOnly
        : DEFAULT_SPEECH_PREFERENCES.instantOnly,
    maxLatencyMs,
  };
}

/** Builds a SpeechVoiceInfo from the raw native map, degrading gracefully. */
export function voiceInfoFromNative(raw: Record<string, unknown>): SpeechVoiceInfo {
  const id = typeof raw.id === 'string' ? raw.id : '';
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    language: typeof raw.language === 'string' ? raw.language : '',
    quality: parseVoiceQuality(raw.quality),
    latency: parseVoiceLatency(raw.latency),
    network: raw.network === true,
    gender: parseSpeechGender(raw.gender) ?? 'unknown',
  };
}

/**
 * True when the voice's locale is an English variant (en, en_US, en-GB…).
 * Android engines expose every installed locale; the app converses in
 * English, so non-English voices only add noise to the picker.
 */
export function isEnglishVoice(voice: SpeechVoiceInfo): boolean {
  const language = voice.language.toLowerCase().replace('_', '-');
  return language === 'en' || language.startsWith('en-');
}

function parseVoiceQuality(value: unknown): SpeechVoiceQuality {
  return value === 'very_low' ||
    value === 'low' ||
    value === 'normal' ||
    value === 'high' ||
    value === 'very_high'
    ? value
    : 'unknown';
}

function parseVoiceLatency(value: unknown): SpeechVoiceLatency {
  return value === 'very_low' ||
    value === 'low' ||
    value === 'normal' ||
    value === 'high' ||
    value === 'very_high'
    ? value
    : 'unknown';
}

/** Builds a SpeechEngineInfo from the raw native map, degrading gracefully. */
export function engineInfoFromNative(raw: Record<string, unknown>): SpeechEngineInfo {
  const id = typeof raw.id === 'string' ? raw.id : '';
  return {
    id,
    label: typeof raw.label === 'string' && raw.label ? raw.label : id,
    isDefault: raw.isDefault === true,
  };
}
