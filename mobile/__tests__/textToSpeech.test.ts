/**
 * TTS abstraction tests (SPEC TASK-076): the TextToSpeechEngine contract
 * defines play/stop behavior, the registry hands out the active engine to
 * UI code, and setSpeechEngine() swaps implementations behind the seam —
 * exactly how the Android-native engine will be installed (TASK-077)
 * without any consumer changes. The stub resolves immediately without
 * producing audio and stop is a safe no-op when nothing plays.
 */
import {
  getSpeechEngine,
  setSpeechEngine,
  stubSpeechEngine,
  type TextToSpeechEngine,
} from '../src/tts/textToSpeech';

function makeRecordingEngine(): {engine: TextToSpeechEngine; spoken: string[]} {
  const spoken: string[] = [];
  return {
    engine: {
      async speak(text: string) {
        spoken.push(text);
      },
      stop() {},
    },
    spoken,
  };
}

describe('textToSpeech abstraction', () => {
  afterEach(() => {
    // Restore the default so other suites observe stock registry state.
    setSpeechEngine(stubSpeechEngine);
  });

  it('exposes the stub as the active engine until a platform one is installed', () => {
    expect(getSpeechEngine()).toBe(stubSpeechEngine);
  });

  it('resolves speak() without producing audio and tolerates idle stop()', async () => {
    await expect(stubSpeechEngine.speak('Hello there')).resolves.toBeUndefined();
    expect(() => stubSpeechEngine.stop()).not.toThrow();
  });

  it('serves whatever engine was installed last through getSpeechEngine()', () => {
    const first = makeRecordingEngine();
    setSpeechEngine(first.engine);
    expect(getSpeechEngine()).toBe(first.engine);

    const second = makeRecordingEngine();
    setSpeechEngine(second.engine);
    expect(getSpeechEngine()).toBe(second.engine);
  });

  it('keeps consumers on the seam while the installed engine speaks', async () => {
    const {engine, spoken} = makeRecordingEngine();
    setSpeechEngine(engine);

    const current = getSpeechEngine();
    await current.speak('Practice makes perfect');
    current.stop();

    expect(spoken).toEqual(['Practice makes perfect']);
  });
});
