/**
 * Speaking-practice screen tests: the form renders topic/minutes inputs,
 * a missing provider key surfaces the Settings hint without leaving the
 * form, a successful generation routes through the configured provider and
 * opens the karaoke view with the generated paragraphs centered, the
 * pause/resume control flips, the elapsed timer ticks with the session,
 * End shows the summary with the elapsed time and word count, and Practice
 * again returns to a reset form. Provider failures surface inline.
 *
 * Listen mode (mode: 'listen' from SpeakingHistory) opens directly in the
 * reading phase, speaks the stored text through the TTS engine, ignores the
 * Settings scroll speed, re-speaks from the last spoken word on resume, and
 * completes WITHOUT saving a new history record.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Animated, PanResponder } from 'react-native';
import type { SpeakingPracticeScreenProps } from '../src/navigation/types';
import { SpeakingPracticeScreen } from '../src/screens/SpeakingPracticeScreen';
import type { LLMClient } from '../src/serverless/types';
import { ThemeProvider } from '../src/theme/ThemeContext';

const mockLoadConfig = jest.fn();
const mockCreateProviderClient = jest.fn();
jest.mock('../src/serverless/settings', () => ({
  loadServerlessConfig: () => mockLoadConfig(),
}));
jest.mock('../src/serverless/providerRegistry', () => ({
  createProviderClient: (config: unknown) => mockCreateProviderClient(config),
}));
jest.mock('../src/db/profileStore', () => ({
  getLearningProfile: jest.fn(async () => ({ level: 'B1', updated_at: '' })),
}));
// Controllable TTS engine: every speak() call is recorded with its
// progress callback and a manual settlement handle.
const mockSpeak = jest.fn();
const mockEngineStop = jest.fn();
jest.mock('../src/tts/textToSpeech', () => ({
  getSpeechEngine: () => ({ speak: mockSpeak, stop: mockEngineStop }),
  stubSpeechEngine: { speak: jest.fn(), stop: jest.fn() },
  setSpeechEngine: jest.fn(),
}));
const mockLoadSpeed = jest.fn();
jest.mock('../src/preferences/speakingScrollSpeed', () => ({
  SPEED_DEFAULT_PX_PER_S: 15,
  loadSpeakingScrollSpeed: () => mockLoadSpeed(),
  saveSpeakingScrollSpeed: jest.fn(),
}));
const mockCreateRecord = jest.fn();
jest.mock('../src/db/speakingPracticeRepository', () => ({
  createSpeakingPracticeRecord: (...args: unknown[]) => mockCreateRecord(...args),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fakeClient: LLMClient = {
  complete: jest.fn(async () => ({
    text: 'The quiet morning at the lake.\n\nBy noon the town was wide awake.',
    model: 'vendor/model-a',
    finishReason: 'stop',
    requestId: null,
  })),
  streamCompletion: jest.fn(),
  listModels: jest.fn(async () => []),
};
const PROVIDER_CONFIG = {
  provider: 'openrouter' as const,
  apiKey: 'test-key',
  primaryModel: 'vendor/model-a',
  fallbackModels: [],
};
type ResumeParams = {
  text: string;
  material?: string;
  minutes?: number;
  mode?: 'read' | 'listen';
};

/** One recorded engine.speak() call with its manual settlement handle. */
type SpeakCall = {
  text: string;
  onProgress?: (progress: { charStart: number; charEnd: number }) => void;
  resolve: () => void;
};

let speakCalls: SpeakCall[] = [];

function speakingProps(params?: ResumeParams): SpeakingPracticeScreenProps {
  return {
    navigation: {
      goBack: jest.fn(),
      navigate: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: { key: 'speaking-test', name: 'SpeakingPractice', params },
  } as unknown as SpeakingPracticeScreenProps;
}
async function renderSpeaking(params?: ResumeParams) {
  const props = speakingProps(params);
  // ThemeColors fallback: ThemeProvider expects a color palette from its own
  // context when nesting is absent, so wrap in the real provider instead.
  const instance = await render(
    <ThemeProvider>
      <SpeakingPracticeScreen {...props} />
    </ThemeProvider>,
  );
  return { props, instance };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockLoadConfig.mockResolvedValue(PROVIDER_CONFIG);
  mockCreateProviderClient.mockReturnValue(fakeClient);
  mockLoadSpeed.mockResolvedValue(15);
  mockCreateRecord.mockResolvedValue(undefined);
  speakCalls = [];
  mockSpeak.mockImplementation(
    (text: string, onProgress?: SpeakCall['onProgress']) =>
      new Promise<void>(resolve => {
        speakCalls.push({ text, onProgress, resolve });
      }),
  );
  mockEngineStop.mockReset();
});
describe('SpeakingPracticeScreen', () => {
  it('renders the form with the material input, minutes chips and generate action', async () => {
    await renderSpeaking();
    expect(await screen.findByTestId('speaking-practice-screen')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-input')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-minutes-3')).toBeOnTheScreen();
    expect(screen.getByText('3 min')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-generate')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-back')).toBeOnTheScreen();
  });
  it('selecting a minutes chip updates the generated word budget', async () => {
    await renderSpeaking();
    await screen.findByTestId('speaking-practice-screen');
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-minutes-5'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-generate'));
    });
    await waitFor(() => expect(screen.getByTestId('speaking-karaoke')).toBeOnTheScreen());
    const [, request] = (fakeClient.complete as jest.Mock).mock.calls[0][0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(request.role).toBe('user');
    expect(request.content).toContain('roughly 700 words');
  });
  it('shows the Settings hint when no provider key is configured', async () => {
    mockLoadConfig.mockResolvedValue(null);
    await renderSpeaking();
    await screen.findByTestId('speaking-practice-screen');
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-generate'));
    });
    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'Add your provider API key in Settings to generate practice text.',
    );
    // The form stays ready for a retry.
    expect(screen.getByTestId('speaking-input')).toBeEnabled();
    expect(screen.queryByTestId('speaking-karaoke')).toBeNull();
  });
  it('surfaces provider failures inline and stays on the form', async () => {
    (fakeClient.complete as jest.Mock).mockRejectedValueOnce(new Error('Provider is down.'));
    await renderSpeaking();
    await screen.findByTestId('speaking-practice-screen');
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-generate'));
    });
    expect(await screen.findByTestId('form-error')).toHaveTextContent('Provider is down.');
    expect(screen.queryByTestId('speaking-karaoke')).toBeNull();
  });
  it('opens the karaoke view with centered generated paragraphs', async () => {
    await renderSpeaking();
    await screen.findByTestId('speaking-practice-screen');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('speaking-input'), 'A day at the lake');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-generate'));
    });
    expect(await screen.findByTestId('speaking-karaoke')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-text-block')).toBeOnTheScreen();
    expect(screen.getByText('The quiet morning at the lake.')).toBeOnTheScreen();
    expect(screen.getByText('By noon the town was wide awake.')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:00');
    expect(screen.getByTestId('speaking-pause')).toBeOnTheScreen();
    // The scroll speed slider lives on the Settings screen now; the practice
    // view only reads the persisted value.
    expect(screen.queryByTestId('speaking-speed')).toBeNull();
    const [, userTurn] = (fakeClient.complete as jest.Mock).mock.calls[0][0].messages as Array<{
      content: string;
    }>;
    expect(userTurn.content).toContain('A day at the lake');
  });
  it('pauses and resumes the session timer', async () => {
    jest.useFakeTimers();
    // Keep the native-driven teleprompter glide pending: Jest completes
    // Animated animations instantly, which would end the read session.
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    try {
      await renderSpeaking();
      await screen.findByTestId('speaking-practice-screen');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-generate'));
      });
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:02');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      expect(screen.getByTestId('speaking-pause')).toHaveTextContent('Resume');
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:02');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      expect(screen.getByTestId('speaking-pause')).toHaveTextContent('Pause');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:03');
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });
  it('read mode resumes the scroll from the position reached before pause', async () => {
    jest.useFakeTimers();
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    try {
      await renderSpeaking();
      await screen.findByTestId('speaking-practice-screen');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-generate'));
      });
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        screen.getByTestId('speaking-karaoke').props.onLayout({
          nativeEvent: { layout: { height: 300, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-text-block'), 'layout', {
          nativeEvent: { layout: { height: 1000, y: 0, x: 0, width: 300 } },
        });
      });
      // maxOffset = 1000 + 2 * 48 - 300 = 796 px, speed 15 px/s.
      const glideTargets = () =>
        timing.mock.calls.map(([, config]) => config as { toValue: number; duration: number });
      expect(glideTargets().at(-1)?.toValue).toBe(796);
      expect(glideTargets().at(-1)?.duration).toBeCloseTo(53067, 0);

      // Let the glide run for 28 s: 28 * 15 = 420 px down the text.
      await act(async () => {
        jest.advanceTimersByTime(28_000);
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      expect(screen.getByTestId('speaking-pause')).toHaveTextContent('Resume');

      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      // Resume glides the remaining 376 px (796 - 420) at 15 px/s, not the full range.
      expect(glideTargets().at(-1)?.toValue).toBe(796);
      expect(glideTargets().at(-1)?.duration).toBeCloseTo(25067, 0);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('read mode resumes from the position the user dragged the text to', async () => {
    jest.useFakeTimers();
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    const create = jest.spyOn(PanResponder, 'create');
    try {
      await renderSpeaking();
      await screen.findByTestId('speaking-practice-screen');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-generate'));
      });
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        screen.getByTestId('speaking-karaoke').props.onLayout({
          nativeEvent: { layout: { height: 300, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-text-block'), 'layout', {
          nativeEvent: { layout: { height: 1000, y: 0, x: 0, width: 300 } },
        });
      });
      const glideTargets = () =>
        timing.mock.calls.map(([, config]) => config as { toValue: number; duration: number });

      // Play for 10 s (150 px down), then pause.
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });

      // The learner drags the paused text back toward the top by 100 px.
      const pan = create.mock.calls.at(-1)?.[0] as unknown as {
        onPanResponderGrant: (event: unknown, gesture: unknown) => void;
        onPanResponderMove: (event: unknown, gesture: unknown) => void;
      };
      await act(async () => {
        pan.onPanResponderGrant({}, { dy: 0, dx: 0 });
        pan.onPanResponderMove({}, { dy: 100, dx: 0 });
      });

      // Resume: the remaining distance is measured from the dragged position.
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      const resumed = glideTargets().at(-1) as { toValue: number; duration: number };
      expect(resumed.toValue).toBe(796);
      // Dragged from 150 px to 50 px, so resume covers 796 - 50 px at 15 px/s.
      expect(resumed.duration).toBeCloseTo(((796 - 50) / 15) * 1000, 0);
    } finally {
      create.mockRestore();
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('read mode keeps running 30 seconds after the glide arrives, then ends itself', async () => {
    jest.useFakeTimers();
    const timing = jest.spyOn(Animated, 'timing').mockImplementation(
      () =>
        ({
          start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
          stop: jest.fn(),
          reset: jest.fn(),
        }) as never,
    );
    try {
      await renderSpeaking();
      await screen.findByTestId('speaking-practice-screen');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-generate'));
      });
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-karaoke'), 'layout', {
          nativeEvent: { layout: { height: 300, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-text-block'), 'layout', {
          nativeEvent: { layout: { height: 1000, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        jest.advanceTimersByTime(29_000);
      });
      expect(screen.queryByTestId('speaking-summary')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(await screen.findByTestId('speaking-summary')).toBeOnTheScreen();
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('saves exactly one history record per generated text, never on End or replay', async () => {
    await renderSpeaking();
    await screen.findByTestId('speaking-practice-screen');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('speaking-input'), 'A day at the lake');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-generate'));
    });
    await screen.findByTestId('speaking-karaoke');
    expect(mockCreateRecord).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-end'));
    });
    await screen.findByTestId('speaking-summary');
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-practice-again'));
    });
    await screen.findByTestId('speaking-karaoke');
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-end'));
    });
    await screen.findByTestId('speaking-summary');
    expect(mockCreateRecord).toHaveBeenCalledTimes(1);
  });

  it('End shows the summary and Practice again resets to the form', async () => {
    jest.useFakeTimers();
    // Keep the native-driven teleprompter glide pending: Jest completes
    // Animated animations instantly, which would end the read session.
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    try {
      await renderSpeaking();
      await screen.findByTestId('speaking-practice-screen');
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-generate'));
      });
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-end'));
      });
      expect(await screen.findByTestId('speaking-summary')).toBeOnTheScreen();
      expect(screen.getByTestId('speaking-summary-detail')).toHaveTextContent(
        '00:01 of reading · 13 words',
      );
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-practice-again'));
      });
      expect(screen.getByTestId('speaking-karaoke')).toBeOnTheScreen();
      expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:00');
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('reopens a saved session from history directly in the reading phase', async () => {
    await renderSpeaking({
      text: 'The quiet morning at the lake.\n\nBy noon the town was wide awake.',
      material: 'A day at the lake',
      minutes: 3,
    });

    expect(await screen.findByTestId('speaking-karaoke')).toBeOnTheScreen();
    expect(screen.getByText('The quiet morning at the lake.')).toBeOnTheScreen();
    expect(screen.getByText('By noon the town was wide awake.')).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-elapsed')).toHaveTextContent('00:00');
    // No form and no provider call: the stored text is reused as-is.
    expect(screen.queryByTestId('speaking-input')).toBeNull();
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });
});

describe('SpeakingPracticeScreen — listen mode', () => {
  const SAVED_TEXT = 'The quiet morning at the lake.\n\nBy noon the town was wide awake.';

  function listenParams(): ResumeParams {
    return {
      text: SAVED_TEXT,
      material: 'A day at the lake',
      minutes: 3,
      mode: 'listen',
    };
  }

  it('opens in the reading phase, speaks the stored text and skips the Settings speed', async () => {
    await renderSpeaking(listenParams());

    expect(await screen.findByTestId('speaking-karaoke')).toBeOnTheScreen();
    expect(screen.queryByTestId('speaking-input')).toBeNull();
    // The engine reads the WHOLE stored text aloud.
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].text).toBe(SAVED_TEXT);
    // The scroll follows TTS progress; the Settings speed is never read.
    expect(mockLoadSpeed).not.toHaveBeenCalled();
    // Listening replays a saved session — no provider traffic.
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it('drives the scroll from progress events and resumes from the last spoken word', async () => {
    await renderSpeaking(listenParams());
    await screen.findByTestId('speaking-karaoke');

    // The engine reports a spoken range; the teleprompter target follows.
    await act(async () => {
      speakCalls[0].onProgress?.({ charStart: 0, charEnd: 10 });
    });

    // Pause silences the engine and flips the control.
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-pause'));
    });
    expect(mockEngineStop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('speaking-pause')).toHaveTextContent('Resume');

    // Resume re-speaks from where the engine stopped (Android TTS cannot
    // continue a stopped utterance).
    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-pause'));
    });
    expect(speakCalls).toHaveLength(2);
    expect(speakCalls[1].text).toBe(SAVED_TEXT.slice(10));
  });

  it('resumes the teleprompter from the position reached before pause', async () => {
    jest.useFakeTimers();
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    try {
      await renderSpeaking(listenParams());
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        screen.getByTestId('speaking-karaoke').props.onLayout({
          nativeEvent: { layout: { height: 300, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-text-block'), 'layout', {
          nativeEvent: { layout: { height: 1000, y: 0, x: 0, width: 300 } },
        });
      });
      // The engine speaks the first half of the text, the glide follows it.
      const halfway = Math.floor(SAVED_TEXT.length / 2);
      await act(async () => {
        speakCalls[0].onProgress?.({ charStart: 0, charEnd: halfway });
      });
      const glideBeforePause = timing.mock.calls.at(-1)?.[1] as { toValue: number };
      expect(glideBeforePause.toValue).toBeGreaterThan(0);

      // Pause mid-glide: a little time has passed, so the text sits partway.
      await act(async () => {
        jest.advanceTimersByTime(300);
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      expect(speakCalls).toHaveLength(2);

      // The resumed utterance reports its first word near the start of the
      // remaining text; the teleprompter must continue from where it stopped
      // and never glide back up to the top.
      await act(async () => {
        speakCalls[1].onProgress?.({ charStart: 0, charEnd: 5 });
      });
      const resumedGlide = timing.mock.calls.at(-1)?.[1] as { toValue: number };
      expect(resumedGlide.toValue).toBeGreaterThanOrEqual(glideBeforePause.toValue);
    } finally {
      timing.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps following the spoken words after the learner drags the paused text further down', async () => {
    const timing = jest
      .spyOn(Animated, 'timing')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() } as never);
    const create = jest.spyOn(PanResponder, 'create');
    try {
      await renderSpeaking(listenParams());
      await screen.findByTestId('speaking-karaoke');
      await act(async () => {
        screen.getByTestId('speaking-karaoke').props.onLayout({
          nativeEvent: { layout: { height: 300, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent(screen.getByTestId('speaking-text-block'), 'layout', {
          nativeEvent: { layout: { height: 1000, y: 0, x: 0, width: 300 } },
        });
      });
      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });

      // Drag the paused text down the page to offset 700 (max 796 px).
      const pan = create.mock.calls.at(-1)?.[0] as unknown as {
        onPanResponderGrant: (event: unknown, gesture: unknown) => void;
        onPanResponderMove: (event: unknown, gesture: unknown) => void;
      };
      await act(async () => {
        pan.onPanResponderGrant({}, { dy: 0, dx: 0 });
        pan.onPanResponderMove({}, { dy: -700, dx: 0 });
      });

      await act(async () => {
        fireEvent.press(screen.getByTestId('speaking-pause'));
      });
      // The engine speaks the middle of the text: the text must scroll to
      // where the words are, not stall at the dragged position.
      const halfway = Math.floor(SAVED_TEXT.length / 2);
      await act(async () => {
        speakCalls[1].onProgress?.({ charStart: 0, charEnd: halfway });
      });
      const lastGlide = timing.mock.calls.at(-1)?.[1] as { toValue: number };
      const expected = (halfway / SAVED_TEXT.length) * 796;
      expect(lastGlide.toValue).toBeCloseTo(expected, 0);
    } finally {
      create.mockRestore();
      timing.mockRestore();
    }
  });

  it('completes when playback ends without saving a new history record', async () => {
    await renderSpeaking(listenParams());
    await screen.findByTestId('speaking-karaoke');

    await act(async () => {
      speakCalls[0].resolve();
    });

    // The session closes only after the teleprompter glides to the end of the
    // text, so the summary waits for the scroll rather than the speech alone.
    expect(await screen.findByTestId('speaking-summary', {}, { timeout: 5000 })).toBeOnTheScreen();
    expect(screen.getByTestId('speaking-summary-detail')).toHaveTextContent(/of listening/);
    // The session replays an EXISTING history record — never duplicated.
    expect(mockCreateRecord).not.toHaveBeenCalled();
  });

  it('End silences the engine and skips the history save', async () => {
    await renderSpeaking(listenParams());
    await screen.findByTestId('speaking-karaoke');

    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-end'));
    });

    expect(mockEngineStop).toHaveBeenCalled();
    expect(await screen.findByTestId('speaking-summary')).toBeOnTheScreen();
    expect(mockCreateRecord).not.toHaveBeenCalled();
    // A stale settlement of the superseded utterance must NOT double-finish.
    await act(async () => {
      speakCalls[0].resolve();
    });
    expect(screen.queryByTestId('speaking-karaoke')).toBeNull();
  });

  it('Listen again restarts playback from the beginning', async () => {
    await renderSpeaking(listenParams());
    await screen.findByTestId('speaking-karaoke');

    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-end'));
    });
    await screen.findByTestId('speaking-summary');

    await act(async () => {
      fireEvent.press(screen.getByTestId('speaking-listen-again'));
    });

    expect(screen.getByTestId('speaking-karaoke')).toBeOnTheScreen();
    expect(speakCalls).toHaveLength(2);
    expect(speakCalls[1].text).toBe(SAVED_TEXT);
  });
});
