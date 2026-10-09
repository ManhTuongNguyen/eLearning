/**
 * Speaking history screen tests: records render from the local repository,
 * and each record with a reading text is the entry point to practice it
 * again — the WHOLE row is pressable and pushes SpeakingPractice with the
 * stored text/material/minutes so the practice screen can reopen directly
 * in the reading phase. Records without text are not pressable. The nested
 * Delete button keeps its own tap target on every row.
 */
import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';

import type {LocalPracticeHistoryRecord} from '../src/db/types';
import type {SpeakingHistoryScreenProps} from '../src/navigation/types';
import {SpeakingHistoryScreen} from '../src/screens/SpeakingHistoryScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT =
  true;

jest.mock('../src/db/database', () => ({
  getLocalDatabase: jest.fn(async () => ({})),
}));

const mockList = jest.fn();
const mockDelete = jest.fn();
jest.mock('../src/db/speakingPracticeRepository', () => ({
  listSpeakingPracticeRecords: (...args: unknown[]) => mockList(...args),
  deleteSpeakingPracticeRecord: (...args: unknown[]) => mockDelete(...args),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();

function makeRecord(overrides: Partial<LocalPracticeHistoryRecord>): LocalPracticeHistoryRecord {
  return {
    id: 1,
    user_id: 0,
    title: 'Morning routine',
    description: '',
    raw_prompt: '',
    english_level: 'B1',
    text: 'I wake up early.\n\nThen I drink coffee.',
    minutes: 3,
    word_count: 6,
    created_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function historyProps(): SpeakingHistoryScreenProps {
  return {
    navigation: {navigate: mockNavigate, goBack: mockGoBack},
    route: {key: 'speaking-history-test', name: 'SpeakingHistory', params: undefined},
  } as unknown as SpeakingHistoryScreenProps;
}

async function renderHistory(records: LocalPracticeHistoryRecord[]) {
  mockList.mockResolvedValue(records);
  // RNTL v14 render is async: awaiting binds `screen` and flushes effects.
  await render(
    <ThemeProvider>
      <SpeakingHistoryScreen {...historyProps()} />
    </ThemeProvider>,
  );
  await screen.findByTestId('speaking-history-list');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDelete.mockResolvedValue(undefined);
});

describe('SpeakingHistoryScreen', () => {
  it('renders saved records from the local repository', async () => {
    await renderHistory([makeRecord({}), makeRecord({id: 2, title: 'At the market'})]);

    expect(screen.getByText('Morning routine')).toBeOnTheScreen();
    expect(screen.getByText('At the market')).toBeOnTheScreen();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('opens the practice screen when anywhere on the row is pressed', async () => {
    await renderHistory([makeRecord({minutes: 5, title: 'Travel stories'})]);

    // The whole row is the press target — no separate button in the UI.
    fireEvent.press(screen.getByTestId('history-practice-again'));

    expect(mockNavigate).toHaveBeenCalledWith('SpeakingPractice', {
      text: 'I wake up early.\n\nThen I drink coffee.',
      material: 'Travel stories',
      minutes: 5,
    });
  });

  it('offers no practice affordance for a record without text', async () => {
    await renderHistory([makeRecord({text: ''})]);

    expect(screen.queryByTestId('history-practice-again')).toBeNull();
    // Deletion is still available on every row.
    expect(screen.getByTestId('history-delete')).toBeOnTheScreen();
  });

  it('keeps delete working alongside the practice action', async () => {
    await renderHistory([makeRecord({})]);

    // act wraps the async handler so its setState lands inside act(...).
    await act(async () => {
      fireEvent.press(screen.getByTestId('history-delete'));
    });

    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
