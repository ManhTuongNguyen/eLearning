/**
 * Sample conversation modal tests (SPEC TASK-053): ordered example turns
 * with role labels, separation note, accessible/dismissible overlay (Close
 * button + Android back), and per-line TTS controls wired through the
 * injected TextToSpeechEngine seam via the shared useSpeechPlayback hook
 * (TASK-079, same playback semantics as chat messages): speak/stop calls,
 * speaking-state transitions, overlap prevention between lines, failure
 * clearing without crashes, and halting playback on close/unmount.
 */
import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';

import type {SampleTurn} from '../src/api/sessions';
import {SampleConversationModal} from '../src/screens/SampleConversationModal';
import {ThemeProvider} from '../src/theme/ThemeContext';
import type {TextToSpeechEngine} from '../src/tts/textToSpeech';

/** Engine double whose speak() calls park on manually released promises. */
function makeDeferredEngine(): {
  engine: TextToSpeechEngine;
  spoken: {text: string; release: () => void}[];
  stopMock: jest.Mock;
} {
  const spoken: {text: string; release: () => void}[] = [];
  const stopMock = jest.fn();
  const engine: TextToSpeechEngine = {
    speak(text: string) {
      return new Promise<void>(resolve => {
        spoken.push({text, release: resolve});
      });
    },
    stop: stopMock,
  };
  return {engine, spoken, stopMock};
}

function makeTurn(overrides: Partial<SampleTurn> = {}): SampleTurn {
  return {role: 'assistant', content: 'Example line', ...overrides};
}

const TURNS: SampleTurn[] = [
  makeTurn({role: 'assistant', content: 'Hello! Ready to practice English?'}),
  makeTurn({role: 'user', content: 'Yes, let us talk about food.'}),
  makeTurn({role: 'assistant', content: 'Great topic. What did you eat today?'}),
];

interface ModalOverrides {
  visible?: boolean;
  turns?: SampleTurn[];
  onClose?: () => void;
  speech?: TextToSpeechEngine;
}

async function renderModal(overrides: ModalOverrides = {}) {
  return render(
    <ThemeProvider>
      <SampleConversationModal
        visible={overrides.visible ?? true}
        turns={overrides.turns ?? TURNS}
        onClose={overrides.onClose ?? (() => undefined)}
        speech={overrides.speech}
      />
    </ThemeProvider>,
  );
}

describe('SampleConversationModal', () => {
  it('renders every example turn in order with role labels and content', async () => {
    await renderModal();

    expect(screen.getByTestId('sample-modal')).toBeOnTheScreen();
    expect(screen.getAllByTestId(/^sample-turn-/)).toHaveLength(TURNS.length);
    const overlay = screen.getByTestId('sample-modal');
    expect(
      within(overlay).getByText('Hello! Ready to practice English?'),
    ).toBeOnTheScreen();
    expect(within(overlay).getByText('Yes, let us talk about food.')).toBeOnTheScreen();
    expect(
      within(overlay).getByText('Great topic. What did you eat today?'),
    ).toBeOnTheScreen();

    // Roles surface as captions next to each line.
    expect(within(screen.getByTestId('sample-turn-0')).getByText('AI')).toBeOnTheScreen();
    expect(within(screen.getByTestId('sample-turn-1')).getByText('You')).toBeOnTheScreen();
    expect(within(screen.getByTestId('sample-turn-2')).getByText('AI')).toBeOnTheScreen();

    // Separation from the real conversation is stated explicitly.
    expect(screen.getByTestId('sample-note')).toHaveTextContent(/never becomes part/i);
  });

  it('renders nothing while closed', async () => {
    await renderModal({visible: false});

    expect(screen.queryByTestId('sample-modal')).toBeNull();
    expect(screen.queryAllByTestId(/^sample-turn-/)).toHaveLength(0);
  });

  it('dismisses through the Close button', async () => {
    const onClose = jest.fn();
    await renderModal({onClose});

    await fireEvent.press(screen.getByTestId('sample-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses through the Android back button', async () => {
    const onClose = jest.fn();
    await renderModal({onClose});

    const modal = screen.getByTestId('sample-modal');
    await act(async () => {
      modal.props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('plays a line through the speech seam and returns to idle when it ends', async () => {
    const {engine, spoken} = makeDeferredEngine();
    await renderModal({speech: engine});

    await fireEvent.press(screen.getByTestId('sample-tts-0'));

    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe('Hello! Ready to practice English?');
    expect(screen.getByTestId('sample-tts-0').props.accessibilityLabel).toBe(
      'Stop example line 1',
    );
    expect(
      (screen.getByTestId('sample-tts-0').props.accessibilityState ?? {}).busy,
    ).toBe(true);

    await act(async () => {
      spoken[0]?.release();
    });
    await waitFor(() =>
      expect(screen.getByTestId('sample-tts-0').props.accessibilityLabel).toBe(
        'Play example line 1',
      ),
    );
    expect(
      (screen.getByTestId('sample-tts-0').props.accessibilityState ?? {}).busy,
    ).toBe(false);
  });

  it('stops a playing line when its control is pressed again', async () => {
    const {engine, spoken, stopMock} = makeDeferredEngine();
    await renderModal({speech: engine});

    await fireEvent.press(screen.getByTestId('sample-tts-0'));
    expect(stopMock).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('sample-tts-0'));

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sample-tts-0').props.accessibilityLabel).toBe(
      'Play example line 1',
    );

    // A late natural end after an explicit stop does not resurrect state.
    await act(async () => {
      spoken[0]?.release();
    });
    expect(screen.getByTestId('sample-tts-0').props.accessibilityLabel).toBe(
      'Play example line 1',
    );
  });

  it('stops the previous line when another one starts', async () => {
    const {engine, spoken, stopMock} = makeDeferredEngine();
    await renderModal({speech: engine});

    await fireEvent.press(screen.getByTestId('sample-tts-0'));
    await fireEvent.press(screen.getByTestId('sample-tts-2'));

    expect(spoken.map(call => call.text)).toEqual([
      'Hello! Ready to practice English?',
      'Great topic. What did you eat today?',
    ]);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sample-tts-0').props.accessibilityLabel).toBe(
      'Play example line 1',
    );
    expect(screen.getByTestId('sample-tts-2').props.accessibilityLabel).toBe(
      'Stop example line 3',
    );
  });

  it('halts playback when the overlay closes while speaking', async () => {
    const {engine, spoken, stopMock} = makeDeferredEngine();
    const utils = await renderModal({speech: engine});

    await fireEvent.press(screen.getByTestId('sample-tts-1'));
    expect(stopMock).not.toHaveBeenCalled();

    await act(async () => {
      utils.rerender(
        <ThemeProvider>
          <SampleConversationModal
            visible={false}
            turns={TURNS}
            onClose={() => undefined}
            speech={engine}
          />
        </ThemeProvider>,
      );
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sample-modal')).toBeNull();

    // A late natural end after closure changes nothing.
    await act(async () => {
      spoken[0]?.release();
    });
  });

  it('clears the speaking state when an utterance fails instead of crashing', async () => {
    const stopMock = jest.fn();
    const failingEngine: TextToSpeechEngine = {
      speak: () => Promise.reject(new Error('E_TTS_LANGUAGE_UNAVAILABLE')),
      stop: stopMock,
    };
    const utils = await renderModal({speech: failingEngine});

    await fireEvent.press(screen.getByTestId('sample-tts-1'));

    await waitFor(() =>
      expect(screen.getByTestId('sample-tts-1').props.accessibilityLabel).toBe(
        'Play example line 2',
      ),
    );

    // The failure is contained: other lines still play normally afterwards.
    const {engine, spoken} = makeDeferredEngine();
    await act(async () => {
      utils.rerender(
        <ThemeProvider>
          <SampleConversationModal
            visible
            turns={TURNS}
            onClose={() => undefined}
            speech={engine}
          />
        </ThemeProvider>,
      );
    });
    await fireEvent.press(screen.getByTestId('sample-tts-0'));
    expect(spoken.map(call => call.text)).toEqual([
      'Hello! Ready to practice English?',
    ]);
  });

  it('halts playback when unmounted mid-line', async () => {
    const {engine, stopMock} = makeDeferredEngine();
    const utils = await renderModal({speech: engine});

    await fireEvent.press(screen.getByTestId('sample-tts-1'));
    expect(stopMock).not.toHaveBeenCalled();

    await act(async () => {
      utils.unmount();
    });

    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
