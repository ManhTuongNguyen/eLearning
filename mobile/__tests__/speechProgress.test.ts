/**
 * Speech-progress seam tests: malformed bridge payloads are dropped,
 * well-formed {charStart, charEnd} ranges reach the listener, and the
 * unsubscribe function detaches the listener so late events are ignored.
 * The seam must never throw — engines without progress support simply
 * never emit, which subscribers tolerate as silence.
 */
import { DeviceEventEmitter } from 'react-native';

import {
  addSpeechProgressListener,
  parseSpeechProgress,
  SPEECH_PROGRESS_EVENT,
} from '../src/tts/speechProgress';

describe('parseSpeechProgress', () => {
  it('accepts a well-formed character range', () => {
    expect(parseSpeechProgress({ charStart: 0, charEnd: 12 })).toEqual({
      charStart: 0,
      charEnd: 12,
    });
  });

  it('drops malformed payloads instead of throwing', () => {
    expect(parseSpeechProgress(null)).toBeNull();
    expect(parseSpeechProgress('progress')).toBeNull();
    expect(parseSpeechProgress({ charStart: 1 })).toBeNull();
    expect(parseSpeechProgress({ charEnd: 2 })).toBeNull();
    expect(parseSpeechProgress({ charStart: 'a', charEnd: 'b' })).toBeNull();
    expect(parseSpeechProgress({ charStart: NaN, charEnd: 3 })).toBeNull();
    expect(parseSpeechProgress({ charStart: 1, charEnd: Infinity })).toBeNull();
  });
});

describe('addSpeechProgressListener', () => {
  it('delivers native progress events to the listener', () => {
    const seen: Array<{ charStart: number; charEnd: number }> = [];
    const unsubscribe = addSpeechProgressListener(progress => {
      seen.push(progress);
    });

    DeviceEventEmitter.emit(SPEECH_PROGRESS_EVENT, {
      charStart: 4,
      charEnd: 9,
    });

    expect(seen).toEqual([{ charStart: 4, charEnd: 9 }]);
    unsubscribe();
  });

  it('ignores malformed events without invoking the listener', () => {
    const listener = jest.fn();
    const unsubscribe = addSpeechProgressListener(listener);

    DeviceEventEmitter.emit(SPEECH_PROGRESS_EVENT, { bogus: true });
    DeviceEventEmitter.emit(SPEECH_PROGRESS_EVENT, null);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops delivering events after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = addSpeechProgressListener(listener);
    unsubscribe();

    DeviceEventEmitter.emit(SPEECH_PROGRESS_EVENT, {
      charStart: 0,
      charEnd: 5,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
