/**
 * useSpeechPlayback tests (SPEC TASK-078): single-playback contract over
 * the TextToSpeechEngine seam — speak exposes the active item id, settling
 * or failing an utterance clears the visible state, starting another item
 * stops the current one first, stop()/unmount silence the engine and a
 * stale interrupted settlement never clobbers newer playback state. The
 * hook also sanitizes utterance text through the shared speech filter, so
 * markdown delimiters and emoji/icons never reach the engine, and
 * decoration-only content is a no-op. The hook is exercised through a
 * small harness component so the state flows through real renders exactly
 * like the chat screen consumes it.
 */
import React from 'react';
import {Pressable, Text, View} from 'react-native';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import type {TextToSpeechEngine} from '../src/tts/textToSpeech';
import {useSpeechPlayback} from '../src/tts/useSpeechPlayback';

/** Engine double whose speak() calls park on manually settled promises. */
function makeScriptedEngine(): {
  engine: TextToSpeechEngine;
  spoken: {text: string; release: () => void; fail: (reason?: unknown) => void}[];
  stopMock: jest.Mock;
} {
  const spoken: {text: string; release: () => void; fail: (reason?: unknown) => void}[] = [];
  const stopMock = jest.fn();
  const engine: TextToSpeechEngine = {
    speak(text: string) {
      return new Promise<void>((resolve, reject) => {
        spoken.push({
          text,
          release: resolve,
          fail: reason => reject(reason ?? new Error('E_TTS_ENGINE')),
        });
      });
    },
    stop: stopMock,
  };
  return {engine, spoken, stopMock};
}

const ITEMS = ['a', 'b', 'c'];

/**
 * Minimal consumer mirroring the chat screen: one trigger per item plus a
 * global stop, and the visible playback state rendered from speakingId.
 */
function SpeechHarness({engine}: {engine: TextToSpeechEngine}) {
  const {speakingId, speak, stop} = useSpeechPlayback(engine);
  return (
    <View>
      <Text testID="speech-state">{speakingId === null ? 'idle' : String(speakingId)}</Text>
      {ITEMS.map(id => (
        <Pressable
          key={id}
          testID={`speak-${id}`}
          onPress={() => {
            speak(id, `text for ${id}`);
          }}>
          <Text>{`speak ${id}`}</Text>
        </Pressable>
      ))}
      <Pressable
        testID="do-stop"
        onPress={stop}>
        <Text>stop</Text>
      </Pressable>
    </View>
  );
}

describe('useSpeechPlayback', () => {
  it('speaks text for the pressed item and exposes it as the speaking id', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));

    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('text for a');
    expect(screen.getByTestId('speech-state')).toHaveTextContent('a');
  });

  it('clears the visible state when playback finishes naturally', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));
    await act(async () => {
      spoken[0]?.release();
    });

    await waitFor(() =>
      expect(screen.getByTestId('speech-state')).toHaveTextContent('idle'),
    );
  });

  it('clears the visible state when playback fails instead of crashing', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-b'));
    expect(screen.getByTestId('speech-state')).toHaveTextContent('b');

    await act(async () => {
      spoken[0]?.fail(new Error('E_TTS_LANGUAGE_UNAVAILABLE'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('speech-state')).toHaveTextContent('idle'),
    );
    // The harness is still interactive afterwards.
    expect(screen.getByTestId('speak-b')).toBeOnTheScreen();
  });

  it('stops current playback before starting another item', async () => {
    const {engine, spoken, stopMock} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));
    expect(stopMock).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('speak-c'));

    expect(spoken.map(call => call.text)).toEqual(['text for a', 'text for c']);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('speech-state')).toHaveTextContent('c');
  });

  it('stop() halts the engine immediately and resets the state', async () => {
    const {engine, stopMock} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));
    expect(screen.getByTestId('speech-state')).toHaveTextContent('a');

    await fireEvent.press(screen.getByTestId('do-stop'));

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('speech-state')).toHaveTextContent('idle');
  });

  it('ignores a stale settlement from a superseded utterance with the same id', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    // Re-speaking the SAME id replaces its first in-flight utterance.
    await fireEvent.press(screen.getByTestId('speak-b'));
    await fireEvent.press(screen.getByTestId('speak-b'));

    await act(async () => {
      spoken[0]?.release(); // first utterance ends late
    });
    expect(screen.getByTestId('speech-state')).toHaveTextContent('b');

    await act(async () => {
      spoken[1]?.release(); // replacement finishes
    });
    await waitFor(() =>
      expect(screen.getByTestId('speech-state')).toHaveTextContent('idle'),
    );
  });

  it('ignores a late natural end after an explicit stop', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));
    await fireEvent.press(screen.getByTestId('do-stop'));

    await act(async () => {
      spoken[0]?.release();
    });

    expect(screen.getByTestId('speech-state')).toHaveTextContent('idle');
  });

  it('silences the engine when unmounted mid-playback', async () => {
    const {engine, stopMock} = makeScriptedEngine();
    const utils = await render(<SpeechHarness engine={engine} />);

    await fireEvent.press(screen.getByTestId('speak-a'));
    expect(stopMock).not.toHaveBeenCalled();

    await act(async () => {
      utils.unmount();
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('strips markdown markers and icons from the spoken text', async () => {
    const {engine, spoken} = makeScriptedEngine();
    await render(<SpeechHarnessWithText engine={engine} text={'**Great!** 🎉 Well done *now*.'} />);

    await fireEvent.press(screen.getByTestId('speak-trigger'));

    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('Great! Well done now.');
  });

  it('treats decoration-only content as a no-op without stopping current playback', async () => {
    const {engine, spoken, stopMock} = makeScriptedEngine();
    await render(
      <View>
        <SpeechHarness engine={engine} />
        <SpeechHarnessWithText engine={engine} text="🎉 ⏹ ★" />
      </View>,
    );

    await fireEvent.press(screen.getByTestId('speak-a'));
    expect(spoken).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('speak-trigger'));

    expect(spoken).toHaveLength(1);
    expect(stopMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('speech-state')).toHaveTextContent('a');
  });
});

/**
 * Harness variant whose trigger speaks caller-provided text, for exercising
 * the sanitizer path directly.
 */
function SpeechHarnessWithText({engine, text}: {engine: TextToSpeechEngine; text: string}) {
  const {speak} = useSpeechPlayback(engine);
  return (
    <Pressable
      testID="speak-trigger"
      onPress={() => {
        speak('custom', text);
      }}>
      <Text>speak custom</Text>
    </Pressable>
  );
}
