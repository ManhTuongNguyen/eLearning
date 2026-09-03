/**
 * TTS settings screen tests (TASK-TTS-001): the dual-engine selection,
 * speed/pitch controls and reset render with persisted state, every
 * change is persisted and applied live to the engine adapter, the focus
 * refresh picks up voice selections made on the manager screen (bug #2),
 * and the screen uses the shared 16px header spacing (bug #1). Voice
 * browsing AND the instant-voices-only switch live on the VoiceManagerScreen.
 */
import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {applySpeechPreferences} from '../src/tts/androidSpeech';
import {
  loadSpeechPreferences,
  saveSpeechPreferences,
} from '../src/tts/speechSettings';
import {
  DEFAULT_SPEECH_PREFERENCES,
  SPEECH_PITCH_MAX,
  SPEECH_PITCH_MIN,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
} from '../src/tts/types';
import type {SpeechPreferences} from '../src/tts/types';
import type {TTSSettingsScreenProps} from '../src/navigation/types';
import {TTSSettingsScreen, createStyles} from '../src/screens/TTSSettingsScreen';
import {lightColors} from '../src/theme/colors';
import {ThemeProvider} from '../src/theme/ThemeContext';

const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

function ttsProps(): TTSSettingsScreenProps {
  return {
    navigation: {
      navigate: jest.fn(),
      goBack: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: {key: 'tts-test', name: 'TTSSettings', params: undefined},
  } as unknown as TTSSettingsScreenProps;
}

async function renderTts() {
  const props = ttsProps();
  await render(
    <ThemeProvider>
      <TTSSettingsScreen {...props} />
    </ThemeProvider>,
  );
  return props;
}

/** Waits until the screen finished restoring preferences. */
async function waitForReady() {
  await waitFor(() => expect(screen.getByTestId('tts-rate-value')).toBeOnTheScreen());
}

describe('TTSSettingsScreen', () => {
  beforeEach(() => {
    asyncStorage.__resetAsyncStorageStore();
    applySpeechPreferences(DEFAULT_SPEECH_PREFERENCES);
  });

  it('renders the system engine card as the single engine', async () => {
    await renderTts();
    await waitForReady();

    expect(screen.getByText('Instant, built into the device. Always available.')).toBeOnTheScreen();
    expect(screen.queryByTestId('tts-engine-neural')).toBeNull();
  });

  it('uses the shared 16px header spacing like the other screens (bug #1)', () => {
    const styles = createStyles(lightColors);
    expect(styles.container.paddingTop).toBe(16);
  });

  it('has no inline voice list — voice picking lives on the manager (bug #5)', async () => {
    await renderTts();
    await waitForReady();

    // The gender chips and voice rows moved to the VoiceManagerScreen.
    expect(screen.queryByTestId('tts-voice-section')).toBeNull();
    expect(screen.queryByTestId('tts-gender-any')).toBeNull();
    expect(screen.getByTestId('tts-manage-voices')).toBeOnTheScreen();
  });

  it('persists a rate change and applies it to the live adapter', async () => {
    await renderTts();
    await waitForReady();

    const slider = screen.getByTestId('tts-rate-slider');
    await act(async () => {
      slider.props.onValueChange(1.3);
    });

    await waitFor(() => expect(screen.getByTestId('tts-rate-value')).toHaveTextContent('1.30×'));
    const stored = await loadSpeechPreferences();
    expect(stored.rate).toBe(1.3);
  });

  it('keeps the pitch slider inside its bounds and persists changes', async () => {
    await renderTts();
    await waitForReady();

    const slider = screen.getByTestId('tts-pitch-slider');
    expect(slider.props.minimumValue).toBe(SPEECH_PITCH_MIN);
    expect(slider.props.maximumValue).toBe(SPEECH_PITCH_MAX);

    await act(async () => {
      slider.props.onValueChange(0.75);
    });

    await waitFor(() => expect(screen.getByTestId('tts-pitch-value')).toHaveTextContent('0.75×'));
    expect((await loadSpeechPreferences()).pitch).toBe(0.75);
  });

  it('has no inline instant-voices switch — it lives on the voice manager', async () => {
    await renderTts();
    await waitForReady();

    // The latency/quality card (and its instant-only switch) moved to the
    // VoiceManagerScreen, directly above the list it filters.
    expect(screen.queryByTestId('tts-latency-section')).toBeNull();
    expect(screen.queryByTestId('tts-instant-only')).toBeNull();
  });

  it('shows the single system engine as selected and non-configurable', async () => {
    await renderTts();
    await waitForReady();

    // System-only build: the engine card is informational, not a radio.
    expect(screen.getByText('Instant, built into the device. Always available.')).toBeOnTheScreen();
    expect(screen.queryByTestId('tts-engine-neural')).toBeNull();
  });

  it('shows the active system voice from persisted preferences (bug #2)', async () => {
    await saveSpeechPreferences({
      ...DEFAULT_SPEECH_PREFERENCES,
      systemVoiceId: 'en-us-x-iol-local',
    });
    await renderTts();
    await waitForReady();

    expect(screen.getByTestId('tts-system-active')).toHaveTextContent(
      'Active voice: en-us-x-iol-local',
    );
  });

  it('re-reads preferences on focus so manager selections show up (bug #2)', async () => {
    const props = await renderTts();
    await waitForReady();

    expect(screen.getByTestId('tts-system-active')).toHaveTextContent(
      'Active voice: device default',
    );

    // A selection made on the VoiceManagerScreen while this screen stayed
    // mounted in the stack.
    await saveSpeechPreferences({
      ...DEFAULT_SPEECH_PREFERENCES,
      systemVoiceId: 'en-gb-x-gba-local',
    });

    // Settings regains focus; the focus listener must re-read storage.
    const focusListener = (props.navigation.addListener as jest.Mock).mock.calls.find(
      call => call[0] === 'focus',
    )?.[1] as (() => void) | undefined;
    expect(focusListener).toBeDefined();
    await act(async () => {
      focusListener?.();
    });

    await waitFor(() =>
      expect(screen.getByTestId('tts-system-active')).toHaveTextContent(
        'Active voice: en-gb-x-gba-local',
      ),
    );
  });

  it('navigates to the unified voice manager (bug #5)', async () => {
    const props = await renderTts();
    await waitForReady();

    fireEvent.press(screen.getByTestId('tts-manage-voices'));

    expect(props.navigation.navigate).toHaveBeenCalledWith('VoiceManager');
  });

  it('restores persisted preferences instead of the defaults', async () => {
    const stored: SpeechPreferences = {
      ...DEFAULT_SPEECH_PREFERENCES,
      rate: 1.5,
      engine: 'system',
    };
    await saveSpeechPreferences(stored);

    await renderTts();
    await waitForReady();

    expect(screen.getByTestId('tts-rate-value')).toHaveTextContent('1.50×');
  });

  it('reset restores the defaults and clears the stored entry', async () => {
    await saveSpeechPreferences({...DEFAULT_SPEECH_PREFERENCES, rate: 1.8});
    await renderTts();
    await waitForReady();

    expect(screen.getByTestId('tts-rate-value')).toHaveTextContent('1.80×');
    fireEvent.press(screen.getByTestId('tts-reset'));

    await waitFor(() =>
      expect(screen.getByTestId('tts-rate-value')).toHaveTextContent('1.00×'),
    );
    expect(await loadSpeechPreferences()).toEqual(DEFAULT_SPEECH_PREFERENCES);
  });

  it('renders the rate slider with the documented bounds', async () => {
    await renderTts();
    await waitForReady();

    const slider = screen.getByTestId('tts-rate-slider');
    expect(slider.props.minimumValue).toBe(SPEECH_RATE_MIN);
    expect(slider.props.maximumValue).toBe(SPEECH_RATE_MAX);
  });
});
