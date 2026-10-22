/**
 * Practice-screen tests (listening-practice trainer): every new question is
 * spoken automatically through the shared engine registry seam (a fake
 * engine is installed via setSpeechEngine, so no native TTS is involved),
 * replay stays unlimited, every round offers exactly four options, scoring
 * counts correct/attempted live and reveals the spoken form, mode switches
 * load a fresh round while keeping the score, the recent-answer window is
 * handed back to the generator so items never repeat, and End practice
 * shows the summary that restart zeroes. Engine failures surface as an
 * inline error instead of crashing.
 *
 * The question generator is mocked so scoring cases are deterministic; the
 * generator itself (including the no-repeat guarantee) is covered by
 * practiceQuestionBank.test.ts against the real implementation.
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import type { PracticeScreenProps } from '../src/navigation/types';
import {
  createPracticeQuestion,
  type PracticeMode,
  type PracticeQuestion,
} from '../src/practice/questionBank';
import { PracticeScreen } from '../src/screens/PracticeScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { TextToSpeechEngine } from '../src/tts/textToSpeech';
import { setSpeechEngine, stubSpeechEngine } from '../src/tts/textToSpeech';

// React 19 concurrent root: mark this environment as act-enabled so
// render/fireEvent flush scheduled state updates synchronously — the same
// guarantee the other screen suites get from their explicit act() calls.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../src/practice/questionBank', () => ({
  ...jest.requireActual('../src/practice/questionBank'),
  createPracticeQuestion: jest.fn(),
}));

const mockedCreate = jest.mocked(createPracticeQuestion);

const fakeEngine = {
  speak: jest.fn(async () => undefined),
  stop: jest.fn(),
};

function numberQuestion(answer: string, distractors: [string, string, string]): PracticeQuestion {
  return {
    kind: 'number',
    answer,
    spoken: `spoken-${answer}`,
    options: [answer, ...distractors],
  };
}

function letterQuestion(answer: string, distractors: [string, string, string]): PracticeQuestion {
  return {
    kind: 'letter',
    answer,
    spoken: answer.toLowerCase(),
    options: [answer, ...distractors],
  };
}

/** Switches the answer-mode toggle into typed-answer mode and waits for the input. */
async function switchToTyping() {
  await fireEvent.press(screen.getByTestId('practice-answer-mode-toggle'));
  await waitFor(() => expect(screen.getByTestId('practice-answer-input')).toBeOnTheScreen());
}

function practiceProps(): PracticeScreenProps {
  return {
    navigation: {
      goBack: jest.fn(),
      navigate: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: { key: 'practice-test', name: 'Practice', params: undefined },
  } as unknown as PracticeScreenProps;
}

// RNTL v14 render is promise-based under React 19: await it so the screen
// module's `screen` queries never race the mount.
async function renderPractice() {
  const props = practiceProps();
  const instance = await render(
    <ThemeProvider>
      <PracticeScreen {...props} />
    </ThemeProvider>,
  );
  return { props, instance };
}

/** Waits until the current round shows its four answer options. */
async function waitForOptions() {
  await waitFor(() => expect(screen.getAllByTestId(/^practice-option-/)).toHaveLength(4));
}

beforeEach(() => {
  mockedCreate.mockReset();
  fakeEngine.speak.mockClear();
  fakeEngine.stop.mockClear();
  setSpeechEngine(fakeEngine as unknown as TextToSpeechEngine);
  // Deterministic default: a year question in the screen's classic shape.
  mockedCreate.mockReturnValue(numberQuestion('1997', ['9719', '1998', '1897']));
});

afterEach(() => {
  setSpeechEngine(stubSpeechEngine);
});

describe('PracticeScreen', () => {
  it('auto-speaks the first question and always shows four options', async () => {
    await renderPractice();

    await waitForOptions();
    await waitFor(() => expect(fakeEngine.speak).toHaveBeenCalledTimes(1));
    expect(fakeEngine.speak).toHaveBeenCalledWith('spoken-1997');
    expect(screen.getAllByTestId(/^practice-option-/)).toHaveLength(4);
  });

  it('keeps the choose-mode actions outside the scrollable content', async () => {
    await renderPractice();
    await waitForOptions();

    const scroll = screen.getByTestId('practice-scroll');
    expect(within(scroll).queryByTestId('practice-next')).toBeNull();
    expect(within(scroll).queryByTestId('practice-end')).toBeNull();
    expect(screen.getByTestId('practice-next')).toBeOnTheScreen();
    expect(screen.getByTestId('practice-end')).toBeOnTheScreen();
    expect(screen.getByTestId('practice-next')).toHaveStyle({ flex: 1 });
    expect(screen.getByTestId('practice-end')).toHaveStyle({ flex: 1 });
  });

  it('disables Next until the choose-mode question is answered', async () => {
    await renderPractice();
    await waitForOptions();

    expect(screen.getByTestId('practice-next')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-1997'));
    });
    expect(screen.getByTestId('practice-next')).not.toBeDisabled();
  });

  it('allows unlimited replays of the same question', async () => {
    await renderPractice();
    await waitForOptions();
    await waitFor(() => expect(fakeEngine.speak).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByTestId('practice-play'));
    await waitFor(() => expect(fakeEngine.speak).toHaveBeenCalledTimes(2));

    fireEvent.press(screen.getByTestId('practice-play'));
    await waitFor(() => expect(fakeEngine.speak).toHaveBeenCalledTimes(3));

    // Every replay repeats the same spoken form.
    expect(fakeEngine.speak).toHaveBeenLastCalledWith('spoken-1997');
  });

  it('scores live, reveals the spoken form and locks the round', async () => {
    await renderPractice();
    await waitForOptions();

    // Wrong pick first.
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-9719'));
    });
    expect(screen.getByTestId('practice-feedback')).toHaveTextContent(
      /^Not quite — see the highlighted option\.$/,
    );
    expect(screen.getByTestId('practice-reveal')).toHaveTextContent('It was 1997 — "spoken-1997"');
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('0');
    expect(screen.getByTestId('practice-accuracy')).toHaveTextContent('0%');

    // The answered round is locked: further presses change nothing.
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-1997'));
    });
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('0');

    // Next round: a correct pick moves the live score.
    mockedCreate.mockReturnValueOnce(numberQuestion('42', ['24', '43', '32']));
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-next'));
    });
    await waitFor(() => expect(screen.getByTestId('practice-option-42')).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-42'));
    });
    expect(screen.getByTestId('practice-feedback')).toHaveTextContent('Correct!');
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('2');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('1');
    expect(screen.getByTestId('practice-accuracy')).toHaveTextContent('50%');
  });

  it('keeps the answer slot the same size before and after an answer', async () => {
    await renderPractice();
    await waitForOptions();

    // The prompt lives in a reserved slot, so swapping it for the reveal and
    // feedback never changes the listening card's height.
    expect(screen.getByTestId('practice-result-area')).toHaveStyle({ minHeight: 92 });
    expect(screen.queryByTestId('practice-reveal')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-1997'));
    });

    expect(screen.getByTestId('practice-result-area')).toHaveStyle({ minHeight: 92 });
    expect(screen.getByTestId('practice-reveal')).toBeOnTheScreen();
  });

  it('hands the recent answers back so items never repeat', async () => {
    const seenRecent: string[][] = [];
    const queue: PracticeQuestion[] = [
      numberQuestion('1997', ['9719', '1998', '1897']),
      numberQuestion('2005', ['2015', '2004', '2050']),
      numberQuestion('42', ['24', '43', '32']),
    ];
    mockedCreate.mockImplementation(((
      _mode: PracticeMode,
      _random: () => number,
      recent: readonly string[],
    ) => {
      seenRecent.push([...recent]);
      return queue.shift() as PracticeQuestion;
    }) as typeof createPracticeQuestion);

    await renderPractice();
    await waitForOptions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-1997'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-next'));
    });
    await waitFor(() => expect(screen.getByTestId('practice-option-2005')).toBeOnTheScreen());
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-2005'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-next'));
    });
    await waitFor(() => expect(screen.getByTestId('practice-option-42')).toBeOnTheScreen());

    // The window starts empty and grows with every completed question — exactly
    // what keeps consecutive answers different.
    expect(seenRecent[0]).toEqual([]);
    expect(seenRecent[1]).toEqual(['1997']);
    expect(seenRecent[2]).toEqual(['1997', '2005']);
  });

  it('switching mode loads a fresh round and keeps the score', async () => {
    await renderPractice();
    await waitForOptions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-9719'));
    });
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');

    mockedCreate.mockReturnValueOnce(numberQuestion('42', ['24', '43', '32']));
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-mode-letters'));
    });

    await waitFor(() => expect(screen.getByTestId('practice-option-42')).toBeOnTheScreen());
    // Fresh round: no reveal, nothing selected — but the score stays.
    expect(screen.queryByTestId('practice-reveal')).toBeNull();
    expect(screen.queryByTestId('practice-feedback')).toBeNull();
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
  });

  it('lists the Phones mode before Mixed, which comes last', async () => {
    await renderPractice();
    const order = screen.getAllByTestId(/^practice-mode-/).map(node => node.props.testID);
    expect(order).toEqual([
      'practice-mode-numbers',
      'practice-mode-letters',
      'practice-mode-phones',
      'practice-mode-mixed',
    ]);
  });

  it('phones mode loads a phone-number round and speaks it digit by digit', async () => {
    await renderPractice();
    await waitForOptions();

    mockedCreate.mockReturnValueOnce({
      kind: 'phone',
      answer: '07942 153 860',
      spoken: 'oh seven nine four two, one five three, eight six oh',
      options: ['07942 153 860', '07942 503 860', '07942 153 869', '07942 153 806'],
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-mode-phones'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('practice-option-07942 153 860')).toBeOnTheScreen(),
    );
    expect(mockedCreate).toHaveBeenLastCalledWith(
      'phones',
      expect.any(Function),
      expect.any(Array),
    );
    await waitFor(() =>
      expect(fakeEngine.speak).toHaveBeenLastCalledWith(
        'oh seven nine four two, one five three, eight six oh',
      ),
    );
  });

  it('end practice shows the summary and restart zeroes it', async () => {
    await renderPractice();
    await waitForOptions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-9719'));
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-end'));
    });
    expect(screen.getByTestId('practice-summary')).toBeOnTheScreen();
    expect(screen.getByTestId('practice-summary-score')).toHaveTextContent(/^0 of 1 correct · 0%$/);

    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-restart'));
    });
    await waitForOptions();
    expect(screen.queryByTestId('practice-summary')).toBeNull();
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('0');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('0');
  });

  it('surfaces speech failures inline without crashing', async () => {
    setSpeechEngine({
      speak: jest.fn(async () => {
        throw new Error('E_TTS_LANGUAGE_UNAVAILABLE');
      }),
      stop: jest.fn(),
    } as unknown as TextToSpeechEngine);

    await renderPractice();

    await waitFor(() => expect(screen.queryByTestId('practice-speech-error')).not.toBeNull());
    // The round is still fully playable — options stay interactive.
    expect(screen.getAllByTestId(/^practice-option-/)).toHaveLength(4);
    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-option-1997'));
    });
    expect(screen.getByTestId('practice-reveal')).toBeOnTheScreen();
  });

  it('silences the engine when leaving the screen', async () => {
    // Self-contained render: the unmount handle comes straight from RNTL,
    // independent of the shared renderPractice helper.
    // RNTL's render is promise-based under React 19: await it, then await
    // the unmount so cleanup effects (engine stop) flush before asserting.
    const instance = await render(
      <ThemeProvider>
        <PracticeScreen {...practiceProps()} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(fakeEngine.speak).toHaveBeenCalledTimes(1));

    await instance.unmount();

    expect(fakeEngine.stop).toHaveBeenCalled();
  });

  it('switches to typed answers from the answer controls and uses the digits keyboard', async () => {
    await renderPractice();
    await waitForOptions();

    await switchToTyping();

    // The four-choice grid is replaced by the answer box.
    expect(screen.queryAllByTestId(/^practice-option-/)).toHaveLength(0);
    expect(screen.getByTestId('practice-answer-input').props.keyboardType).toBe('number-pad');
  });

  it('uses a minimal listening card and inline actions while typing', async () => {
    await renderPractice();
    await waitForOptions();
    await switchToTyping();

    expect(screen.getByTestId('practice-minimal-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('practice-listening-card')).toBeNull();

    // Typed mode keeps Next/End directly under the answer controls instead of
    // parking them in the screen-level footer.
    const scroll = screen.getByTestId('practice-scroll');
    expect(within(scroll).getByTestId('practice-next')).toBeOnTheScreen();
    expect(within(scroll).getByTestId('practice-end')).toBeOnTheScreen();
    expect(within(scroll).getByTestId('practice-next')).toBeDisabled();
    expect(screen.getByTestId('practice-result-area')).toHaveStyle({ minHeight: 64 });
  });

  it('scores a typed answer, forgiving spaces and letter case', async () => {
    await renderPractice();
    await waitForOptions();
    await switchToTyping();

    const input = screen.getByTestId('practice-answer-input');
    await fireEvent.changeText(input, '1 997');
    await fireEvent.press(screen.getByTestId('practice-check'));

    expect(screen.getByTestId('practice-feedback')).toHaveTextContent('Correct!');
    expect(screen.getByTestId('practice-reveal')).toHaveTextContent('It was 1997 — "spoken-1997"');
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('1');
  });

  it('keeps the typed feedback slot stable and advances from the inline actions', async () => {
    await renderPractice();
    await waitForOptions();
    await switchToTyping();

    expect(screen.getByTestId('practice-result-area')).toHaveStyle({ minHeight: 64 });
    expect(
      within(screen.getByTestId('practice-scroll')).getByTestId('practice-next'),
    ).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('practice-answer-input'), '1997');
    await fireEvent.press(screen.getByTestId('practice-check'));

    expect(screen.getByTestId('practice-result-area')).toHaveStyle({ minHeight: 64 });
    expect(
      within(screen.getByTestId('practice-scroll')).getByTestId('practice-next'),
    ).not.toBeDisabled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('practice-next'));
    });

    expect(screen.getByTestId('practice-answer-input').props.value).toBe('');
    expect(screen.queryByTestId('practice-reveal')).toBeNull();
  });

  it('marks a wrong typed answer without highlighting options', async () => {
    await renderPractice();
    await waitForOptions();
    await switchToTyping();

    await fireEvent.changeText(screen.getByTestId('practice-answer-input'), '9719');
    await fireEvent.press(screen.getByTestId('practice-check'));

    expect(screen.getByTestId('practice-feedback')).toHaveTextContent(
      'Not quite — check the answer above.',
    );
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('0');
  });

  it('accepts a phone number typed without its grouping spaces', async () => {
    mockedCreate.mockReturnValue({
      kind: 'phone',
      answer: '07942 153 860',
      spoken: 'oh seven nine four two, one five three, eight six oh',
      options: ['07942 153 860', '07942 503 860', '07942 153 869', '07942 153 806'],
    });
    await renderPractice();
    await waitForOptions();
    await fireEvent.press(screen.getByTestId('practice-mode-phones'));
    await waitFor(() =>
      expect(screen.getByTestId('practice-option-07942 153 860')).toBeOnTheScreen(),
    );
    await switchToTyping();
    expect(screen.getByTestId('practice-answer-input').props.keyboardType).toBe('number-pad');

    await fireEvent.changeText(screen.getByTestId('practice-answer-input'), '07942153860');
    await fireEvent.press(screen.getByTestId('practice-check'));

    expect(screen.getByTestId('practice-feedback')).toHaveTextContent('Correct!');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('1');
  });

  it('uses the normal keyboard and case-insensitive matching for letters', async () => {
    mockedCreate.mockReturnValue(letterQuestion('B', ['D', 'P', 'T']));
    await renderPractice();
    await waitForOptions();
    await fireEvent.press(screen.getByTestId('practice-mode-letters'));
    await waitFor(() => expect(screen.getByTestId('practice-option-B')).toBeOnTheScreen());
    await switchToTyping();

    expect(screen.getByTestId('practice-answer-input').props.keyboardType).toBe('default');
    await fireEvent.changeText(screen.getByTestId('practice-answer-input'), 'b');
    await fireEvent.press(screen.getByTestId('practice-check'));

    expect(screen.getByTestId('practice-feedback')).toHaveTextContent('Correct!');
    expect(screen.getByTestId('practice-correct-count')).toHaveTextContent('1');
  });

  it('keeps taps on the play button from dismissing the keyboard', async () => {
    await renderPractice();
    await waitForOptions();
    await switchToTyping();

    // The scroll view must let handled taps (play, check, next) through
    // without the keyboard closing, so the answer box keeps its cursor.
    expect(screen.getByTestId('practice-scroll').props.keyboardShouldPersistTaps).toBe('handled');

    await fireEvent.press(screen.getByTestId('practice-play'));
    expect(screen.getByTestId('practice-answer-input')).toBeOnTheScreen();
  });

  it('switching answer mode starts a fresh round and keeps the score', async () => {
    await renderPractice();
    await waitForOptions();
    await fireEvent.press(screen.getByTestId('practice-option-9719'));
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');

    await switchToTyping();

    expect(screen.queryByTestId('practice-reveal')).toBeNull();
    expect(screen.queryByTestId('practice-feedback')).toBeNull();
    expect(screen.getByTestId('practice-attempted-count')).toHaveTextContent('1');
  });
});
