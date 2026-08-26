/**
 * Android speech adapter tests (SPEC TASK-077): the adapter installs the
 * native Speech module behind the TASK-076 seam only when the module exists,
 * delegates play/stop to it, and lets normalized native failures — such as
 * missing English voice data — surface as promise rejections rather than
 * crashes. When the native module is absent the stub stays active.
 */
import {NativeModules} from 'react-native';

import {
  androidSpeechEngine,
  installAndroidSpeechEngine,
  isAndroidSpeechAvailable,
} from '../src/tts/androidSpeech';
import {
  getSpeechEngine,
  setSpeechEngine,
  stubSpeechEngine,
} from '../src/tts/textToSpeech';

type SpeechMock = {speak: jest.Mock; stop: jest.Mock};

function speechMock(): SpeechMock {
  return {speak: jest.fn(async () => undefined), stop: jest.fn()};
}

function installNative(mock: SpeechMock | null): void {
  (NativeModules as Record<string, unknown>).Speech = mock;
}

describe('androidSpeech adapter', () => {
  afterEach(() => {
    installNative(null);
    setSpeechEngine(stubSpeechEngine);
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

  it('delegates speak() with the requested text', async () => {
    const mock = speechMock();
    installNative(mock);
    installAndroidSpeechEngine();

    await getSpeechEngine().speak('Good morning');

    expect(mock.speak).toHaveBeenCalledTimes(1);
    expect(mock.speak).toHaveBeenCalledWith('Good morning');
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
    mock.speak.mockRejectedValueOnce(
      new Error('E_TTS_LANGUAGE_UNAVAILABLE: No English voice data'),
    );
    installNative(mock);
    const engine = androidSpeechEngine();

    await expect(engine.speak('Hello')).rejects.toThrow(
      'E_TTS_LANGUAGE_UNAVAILABLE',
    );
    expect(mock.speak).toHaveBeenCalledWith('Hello');
  });
});
