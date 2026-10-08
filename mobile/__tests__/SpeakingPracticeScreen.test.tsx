/**
 * Speaking-practice screen tests: the form renders topic/minutes inputs,
 * a missing provider key surfaces the Settings hint without leaving the
 * form, a successful generation routes through the configured provider and
 * opens the karaoke view with the generated paragraphs centered, the
 * pause/resume control flips, the elapsed timer ticks with the session,
 * End shows the summary with the elapsed time and word count, and Practice
 * again returns to a reset form. Provider failures surface inline.
 */
import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import type {SpeakingPracticeScreenProps} from '../src/navigation/types';
import {SpeakingPracticeScreen} from '../src/screens/SpeakingPracticeScreen';
import type {LLMClient} from '../src/serverless/types';
import type {ThemeColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

const mockLoadConfig = jest.fn();
const mockCreateProviderClient = jest.fn();

jest.mock('../src/serverless/settings', () => ({
  loadServerlessOpenRouterConfig: () => mockLoadConfig(),
}));

jest.mock('../src/serverless/providerRegistry', () => ({
  createProviderClient: (config: unknown) => mockCreateProviderClient(config),
}));

jest.mock('../src/db/profileStore', () => ({
  getLearningProfile: jest.fn(async () => ({level: 'B1', updated_at: ''})),
}));

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT =
  true;

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

function speakingProps(): SpeakingPracticeScreenProps {
  return {
    navigation: {
      goBack: jest.fn(),
      navigate: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: {key: 'speaking-test', name: 'SpeakingPractice', params: undefined},
  } as unknown as SpeakingPracticeScreenProps;
}

/** Palette only used to satisfy the ThemeProvider shape; the screen reads tokens itself. */
const themeColorsStub = {} as ThemeColors;

async function renderSpeaking() {
  const props = speakingProps();
  // ThemeColors fallback: ThemeProvider expects a color palette from its own
  // context when nesting is absent, so wrap in the real provider instead.
  const instance = await render(
    <ThemeProvider>
      <SpeakingPracticeScreen {...props} />
    </ThemeProvider>,
  );
  return {props, instance};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadConfig.mockResolvedValue(PROVIDER_CONFIG);
  mockCreateProviderClient.mockReturnValue(fakeClient);
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
    expect(request.content).toContain('roughly 650 words');
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
    (fakeClient.complete as jest.Mock).mockRejectedValueOnce(
      new Error('Provider is down.'),
    );
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
    expect(screen.getByTestId('speaking-speed')).toBeOnTheScreen();

    // The material reached the provider.
    const [, userTurn] = (fakeClient.complete as jest.Mock).mock.calls[0][0]
      .messages as Array<{content: string}>;
    expect(userTurn.content).toContain('A day at the lake');
  });

  it('pauses and resumes the session timer', async () => {
    jest.useFakeTimers();
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
      jest.useRealTimers();
    }
  });

  it('End shows the summary and Practice again resets to the form', async () => {
    jest.useFakeTimers();
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

      expect(screen.getByTestId('speaking-input')).toBeOnTheScreen();
      expect(screen.getByTestId('speaking-input').props.value).toBe('');
      expect(screen.queryByTestId('speaking-summary')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
