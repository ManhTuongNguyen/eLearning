/**
 * Android speech adapter tests (SPEC TASK-077, TASK-TTS-001): the adapter
 * installs the native Speech module behind the TASK-076 seam only when the
 * module exists, delegates play/stop to it, applies the persisted speech
 * preferences to every utterance (voice, rate, pitch), and lets normalized
 * native failures — such as missing English voice data — surface as promise
 * rejections rather than crashes. When the native module is absent the stub
 * stays active.
 */
import {NativeModules} from 'react-native';

import {
  androidSpeechEngine,
  applySpeechPreferences,
  installAndroidSpeechEngine,
  isAndroidSpeechAvailable,
  listSystemEngines,
  listSystemVoices,
} from '../src/tts/androidSpeech';
import {
  getSpeechEngine,
  setSpeechEngine,
  stubSpeechEngine,
} from '../src/tts/textToSpeech';
import {DEFAULT_SPEECH_PREFERENCES} from '../src/tts/types';
import type {SpeechPreferences} from '../src/tts/types';

type SpeakOptions = {voiceId: string | null; rate: number; pitch: number} | null;

type SpeechMock = {
  speak: jest.Mock<Promise<void>, [string]>;
  speakWith: jest.Mock<Promise<void>, [string, SpeakOptions]>;
  stop: jest.Mock;
  getVoices: jest.Mock<Promise<unknown[]>, []>;
  getEngines: jest.Mock<Promise<unknown[]>, []>;
  getDefaultEngine: jest.Mock<Promise<string | null>, []>;
  setDefaultEngine: jest.Mock<Promise<void>, [string]>;
};

function speechMock(): SpeechMock {
  return {
    speak: jest.fn(async (_text: string) => undefined),
    speakWith: jest.fn(async (_text: string, _options: SpeakOptions) => undefined),
    stop: jest.fn(),
    getVoices: jest.fn(async () => []),
    getEngines: jest.fn(async () => []),
    getDefaultEngine: jest.fn(async () => null),
    setDefaultEngine: jest.fn(async (_engineId: string) => undefined),
  };
}

function installNative(mock: SpeechMock | null): void {
  (NativeModules as Record<string, unknown>).Speech = mock;
}

describe('androidSpeech adapter', () => {
  afterEach(() => {
    installNative(null);
    setSpeechEngine(stubSpeechEngine);
    applySpeechPreferences(DEFAULT_SPEECH_PREFERENCES);
  });

  it('reports unavailability while no native module exists', () => {
    expect(isAndroidSpeechAvailable()).toBe(false);
    expect(installAndroidSpeechEngine()).toBe(false);
    // Registry keeps the stub so existing UI controls stay wired.
    expect(getSpeechEngine()).toBe(stubSpeechEngine);
    expect(() => androidSpeechEngine()).toThrow(
      'Android speech module is not available',
    );
  });

  it('ignores native modules lacking the expected play/stop surface', () => {
    installNative({speak: 'not-a-function'} as unknown as SpeechMock);
    expect(isAndroidSpeechAvailable()).toBe(false);
    expect(installAndroidSpeechEngine()).toBe(false);
  });

  it('installs the native engine into the registry', () => {
    const mock = speechMock();
    installNative(mock);

    expect(installAndroidSpeechEngine()).toBe(true);

    const engine = getSpeechEngine();
    expect(engine).not.toBe(stubSpeechEngine);
  });

  it('renders speech through speakWith with the default preferences', async () => {
    const mock = speechMock();
    installNative(mock);
    installAndroidSpeechEngine();

    await getSpeechEngine().speak('Good morning');

    expect(mock.speakWith).toHaveBeenCalledTimes(1);
    const [text, options] = mock.speakWith.mock.calls[0];
    expect(text).toBe('Good morning');
    expect(options).toEqual({voiceId: null, rate: 1, pitch: 1});
  });

  it('applies applied preferences (voice, rate, pitch) to utterances', async () => {
    const mock = speechMock();
    installNative(mock);
    installAndroidSpeechEngine();

    const preferences: SpeechPreferences = {
      ...DEFAULT_SPEECH_PREFERENCES,
      engine: 'system',
      systemVoiceId: 'en-us-x-iol',
      rate: 1.25,
      pitch: 0.9,
    };
    applySpeechPreferences(preferences);

    await getSpeechEngine().speak('Slow down');

    expect(mock.speakWith).toHaveBeenCalledWith('Slow down', {
      voiceId: 'en-us-x-iol',
      rate: 1.25,
      pitch: 0.9,
    });
  });

  it('delegates stop() to the native module', () => {
    const mock = speechMock();
    installNative(mock);
    const engine = androidSpeechEngine();

    expect(() => engine.stop()).not.toThrow();
    expect(mock.stop).toHaveBeenCalledTimes(1);
  });

  it('propagates language-unavailability as a rejected speak()', async () => {
    const mock = speechMock();
    mock.speakWith.mockRejectedValueOnce(
      new Error('E_TTS_LANGUAGE_UNAVAILABLE: No English voice data'),
    );
    installNative(mock);
    const engine = androidSpeechEngine();

    await expect(engine.speak('Hello')).rejects.toThrow(
      'E_TTS_LANGUAGE_UNAVAILABLE',
    );
    expect(mock.speakWith).toHaveBeenCalledWith('Hello', {
      voiceId: null,
      rate: 1,
      pitch: 1,
    });
  });

  it('lists installed voices as normalized SpeechVoiceInfo rows', async () => {
    const mock = speechMock();
    mock.getVoices.mockResolvedValueOnce([
      {
        id: 'en-us-x-iol-local',
        name: 'en-us-x-iol-local',
        language: 'en_US',
        quality: 'high',
        latency: 'low',
        network: false,
        gender: 'female',
      },
      {broken: true},
    ]);
    installNative(mock);

    const voices = await listSystemVoices();

    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({
      id: 'en-us-x-iol-local',
      language: 'en_US',
      quality: 'high',
      latency: 'low',
      network: false,
      gender: 'female',
    });
  });

  it('rejects listSystemVoices when the native module is absent', async () => {
    await expect(listSystemVoices()).rejects.toThrow(
      'Android speech module is not available',
    );
    await expect(listSystemEngines()).rejects.toThrow(
      'Android speech module is not available',
    );
  });
});
