/**
 * Speech settings persistence tests (TASK-TTS-001): preferences round-trip
 * through AsyncStorage, corrupted/absent values fall back to defaults, and
 * clamping keeps rate/pitch/latency inside their bounds.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearSpeechPreferences,
  loadSpeechPreferences,
  saveSpeechPreferences,
} from '../src/tts/speechSettings';
import {
  DEFAULT_SPEECH_PREFERENCES,
  clampWithStep,
  normalizeSpeechPreferences,
} from '../src/tts/types';

const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

describe('speechSettings persistence', () => {
  beforeEach(() => {
    asyncStorage.__resetAsyncStorageStore();
  });

  it('resolves defaults when nothing was stored', async () => {
    await expect(loadSpeechPreferences()).resolves.toEqual(
      DEFAULT_SPEECH_PREFERENCES,
    );
  });

  it('round-trips a saved preference set', async () => {
    const saved = {
      ...DEFAULT_SPEECH_PREFERENCES,
      systemVoiceId: 'en-us-x-iol-local',
      rate: 1.2,
      pitch: 0.85,
      maxLatencyMs: 800,
      instantOnly: false,
    };
    await saveSpeechPreferences(saved);
    await expect(loadSpeechPreferences()).resolves.toEqual(saved);
  });

  it('falls back to defaults for corrupted JSON', async () => {
    await AsyncStorage.setItem('app.speechPreferences', '{not json');
    await expect(loadSpeechPreferences()).resolves.toEqual(
      DEFAULT_SPEECH_PREFERENCES,
    );
  });

  it('normalizes corrupt fields of a stored record field by field', async () => {
    await AsyncStorage.setItem(
      'app.speechPreferences',
      JSON.stringify({
        engine: 'holographic',
        rate: 99,
        pitch: -5,
        maxLatencyMs: 99999,
        gender: 'robot',
      }),
    );
    const loaded = await loadSpeechPreferences();
    expect(loaded).toEqual({
      ...DEFAULT_SPEECH_PREFERENCES,
      rate: 2,
      pitch: 0.5,
      maxLatencyMs: 3000,
    });
  });

  it('clearing removes the stored entry', async () => {
    await saveSpeechPreferences({
      ...DEFAULT_SPEECH_PREFERENCES,
      rate: 0.5,
    });
    await clearSpeechPreferences();
    await expect(loadSpeechPreferences()).resolves.toEqual(
      DEFAULT_SPEECH_PREFERENCES,
    );
  });
});

describe('speech preference normalization helpers', () => {
  it('clamps rate onto its step grid', () => {
    expect(clampWithStep(1.234, 0.5, 2, 0.05)).toBe(1.25);
    expect(clampWithStep(9, 0.5, 2, 0.05)).toBe(2);
    expect(clampWithStep(0.1, 0.5, 2, 0.05)).toBe(0.5);
  });

  it('keeps unknown gender as any in normalized preferences', () => {
    expect(normalizeSpeechPreferences({gender: 'unknown'}).gender).toBe('any');
    expect(normalizeSpeechPreferences({gender: 'male'}).gender).toBe('male');
  });

  it('treats non-objects as defaults', () => {
    expect(normalizeSpeechPreferences(null)).toEqual(DEFAULT_SPEECH_PREFERENCES);
    expect(normalizeSpeechPreferences('oops')).toEqual(DEFAULT_SPEECH_PREFERENCES);
  });
});
