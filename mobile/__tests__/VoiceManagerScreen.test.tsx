/**
 * Voice manager tests (TASK-TTS-003, system-only branch): the concise voice
 * picker lists English system voices with search, per-voice metadata and
 * audition. Covers:
 *  - English-only listing (non-English locales filtered out)
 *  - search narrowing by voice name
 *  - selecting a voice persists systemVoiceId immediately
 *  - no gender filter chips (engines do not report gender reliably)
 *  - device default voice option and engine switching
 *  - the in-place instant-voices-only toggle (moved here from the settings
 *    screen so the switch sits directly above the list it filters)
 * The native Speech module is exercised through jest doubles (no native
 * side in the test environment).
 */
import React from 'react';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';

import * as androidSpeech from '../src/tts/androidSpeech';
import {loadSpeechPreferences, saveSpeechPreferences} from '../src/tts/speechSettings';
import {DEFAULT_SPEECH_PREFERENCES} from '../src/tts/types';
import type {VoiceManagerScreenProps} from '../src/navigation/types';
import {VoiceManagerScreen} from '../src/screens/VoiceManagerScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

jest.mock('../src/tts/androidSpeech', () => {
  const actual = jest.requireActual('../src/tts/androidSpeech');
  return {
    ...actual,
    listSystemVoices: jest.fn(),
    listSystemEngines: jest.fn(),
    getSystemEngineId: jest.fn(),
    selectSystemEngine: jest.fn(),
    applySpeechPreferences: jest.fn(),
    previewSystemVoice: jest.fn(),
  };
});

const mockedListSystemVoices = jest.mocked(androidSpeech.listSystemVoices);
const mockedListSystemEngines = jest.mocked(androidSpeech.listSystemEngines);
const mockedGetSystemEngineId = jest.mocked(androidSpeech.getSystemEngineId);
const mockedSelectSystemEngine = jest.mocked(androidSpeech.selectSystemEngine);
const mockedPreview = jest.mocked(androidSpeech.previewSystemVoice);

const SYSTEM_EN_FEMALE: Record<string, unknown> = {
  id: 'en-us-x-iol-local',
  name: 'en-us-x-iol-local',
  language: 'en_US',
  quality: 'high',
  latency: 'low',
  network: false,
  gender: 'female',
};

const SYSTEM_EN_MALE: Record<string, unknown> = {
  id: 'en-gb-x-gba-local',
  name: 'en-gb-x-gba-local',
  language: 'en_GB',
  quality: 'normal',
  latency: 'normal',
  network: false,
  gender: 'male',
};

const SYSTEM_SV_SE: Record<string, unknown> = {
  id: 'sv-se-x-lfs-local',
  name: 'sv-se-x-lfs-local',
  language: 'sv_SE',
  quality: 'normal',
  latency: 'normal',
  network: false,
  gender: 'male',
};

const SYSTEM_EN_NETWORK: Record<string, unknown> = {
  id: 'en-us-x-tpd-network',
  name: 'en-us-x-tpd-network',
  language: 'en_US',
  quality: 'enhanced',
  latency: 'normal',
  network: true,
  gender: 'female',
};

function managerProps(): VoiceManagerScreenProps {
  return {
    navigation: {
      goBack: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    },
    route: {key: 'manager-test', name: 'VoiceManager', params: undefined},
  } as unknown as VoiceManagerScreenProps;
}

async function renderManager() {
  const props = managerProps();
  await render(
    <ThemeProvider>
      <VoiceManagerScreen {...props} />
    </ThemeProvider>,
  );
  return props;
}

function stubCatalog() {
  mockedListSystemVoices.mockResolvedValue([
    SYSTEM_EN_FEMALE,
    SYSTEM_EN_MALE,
    SYSTEM_SV_SE,
    SYSTEM_EN_NETWORK,
  ] as never);
  mockedListSystemEngines.mockResolvedValue([
    {id: 'com.google.android.tts', label: 'Google TTS', isDefault: true},
  ] as never);
  mockedGetSystemEngineId.mockResolvedValue('com.google.android.tts');
  mockedSelectSystemEngine.mockResolvedValue(undefined);
  mockedPreview.mockResolvedValue(undefined);
}

describe('VoiceManagerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubCatalog();
  });

  it('lists only English system voices, hiding other locales (#3)', async () => {
    await renderManager();

    await screen.findByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`);
    expect(screen.getByTestId(`voice-system-${SYSTEM_EN_MALE.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`voice-system-${SYSTEM_SV_SE.id}`)).toBeNull();
  });

  it('offers the device default voice plus a searched subset', async () => {
    await renderManager();

    await screen.findByTestId('voice-system-default');

    const search = screen.getByTestId('voice-manager-search');
    fireEvent.changeText(search, 'gba');

    await waitFor(() =>
      expect(screen.queryByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`)).toBeNull(),
    );
    expect(screen.getByTestId(`voice-system-${SYSTEM_EN_MALE.id}`)).toBeOnTheScreen();
  });

  it('no longer offers gender filter chips — engines do not report gender reliably (#4)', async () => {
    await renderManager();

    await screen.findByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`);

    expect(screen.queryByTestId('voice-manager-gender-any')).toBeNull();
    expect(screen.queryByTestId('voice-manager-gender-female')).toBeNull();
    expect(screen.queryByTestId('voice-manager-gender-male')).toBeNull();
  });

  it('selecting a voice persists systemVoiceId immediately (#2)', async () => {
    await renderManager();

    fireEvent.press(await screen.findByTestId(`voice-system-${SYSTEM_EN_MALE.id}`));

    await waitFor(async () => {
      const stored = await loadSpeechPreferences();
      expect(stored.systemVoiceId).toBe(SYSTEM_EN_MALE.id);
    });
  });

  it('shows the Active badge on the selected voice', async () => {
    await renderManager();

    fireEvent.press(await screen.findByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`));

    const card = await screen.findByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`);
    expect(within(card).getByText('Active')).toBeOnTheScreen();
  });

  it('selecting the device default clears the stored voice id', async () => {
    await renderManager();

    fireEvent.press(await screen.findByTestId(`voice-system-${SYSTEM_EN_MALE.id}`));
    await waitFor(async () => {
      const stored = await loadSpeechPreferences();
      expect(stored.systemVoiceId).toBe(SYSTEM_EN_MALE.id);
    });

    fireEvent.press(screen.getByTestId('voice-system-default'));
    await waitFor(async () => {
      const stored = await loadSpeechPreferences();
      expect(stored.systemVoiceId).toBeNull();
    });
  });

  it('auditions a voice through previewSystemVoice without selecting it', async () => {
    await renderManager();

    fireEvent.press(await screen.findByTestId(`voice-system-preview-${SYSTEM_EN_FEMALE.id}`));

    await waitFor(() => expect(mockedPreview).toHaveBeenCalledWith(
      SYSTEM_EN_FEMALE.id,
      'Hello! This is how this voice sounds.',
    ));
    // No selection happened.
    expect((await loadSpeechPreferences()).systemVoiceId).toBeNull();
  });

  it('hides network voices while instant-only is on and shows them when toggled off', async () => {
    await saveSpeechPreferences({...DEFAULT_SPEECH_PREFERENCES, instantOnly: true});
    await renderManager();

    await screen.findByTestId(`voice-system-${SYSTEM_EN_FEMALE.id}`);
    expect(screen.queryByTestId(`voice-system-${SYSTEM_EN_NETWORK.id}`)).toBeNull();
    expect(
      screen.getByTestId('tts-instant-only').props.accessibilityState,
    ).toEqual(expect.objectContaining({checked: true}));

    // Toggle instant-only off directly on this screen (the switch moved
    // here from the settings screen) — no focus reload needed.
    fireEvent.press(screen.getByTestId('tts-instant-only'));

    await waitFor(() =>
      expect(screen.getByTestId(`voice-system-${SYSTEM_EN_NETWORK.id}`)).toBeOnTheScreen(),
    );
    expect((await loadSpeechPreferences()).instantOnly).toBe(false);

    // Toggling back on hides the network voices again.
    fireEvent.press(screen.getByTestId('tts-instant-only'));
    await waitFor(() =>
      expect(screen.queryByTestId(`voice-system-${SYSTEM_EN_NETWORK.id}`)).toBeNull(),
    );
    expect((await loadSpeechPreferences()).instantOnly).toBe(true);
  });

  it('switches the system TTS engine when several are installed', async () => {
    mockedListSystemEngines.mockResolvedValue([
      {id: 'com.google.android.tts', label: 'Google TTS', isDefault: true},
      {id: 'com.samsung.tts', label: 'Samsung TTS', isDefault: false},
    ] as never);
    await renderManager();

    fireEvent.press(await screen.findByTestId('voice-manager-engine-com.samsung.tts'));

    await waitFor(() => expect(mockedSelectSystemEngine).toHaveBeenCalledWith(
      'com.samsung.tts',
    ));
  });

  it('renders the unavailable degradation when no native module exists', async () => {
    mockedListSystemVoices.mockRejectedValue(
      new Error('Android speech module is not available'),
    );
    await renderManager();

    expect(
      await screen.findByText(/System voice options are not available/),
    ).toBeOnTheScreen();
  });

  it('navigates back with the back affordance', async () => {
    const props = await renderManager();
    await act(async () => {
      fireEvent.press(await screen.findByTestId('voice-manager-back'));
    });
    expect(props.navigation.goBack).toHaveBeenCalledTimes(1);
  });
});
