/**
 * Sentence practice screen tests (TASK-SENT-012).
 *
 * The screen runs against the real in-memory sql.js repository, so every grade
 * assertion checks the stored schedule and the review-log row rather than a
 * mocked repository. A fake speech engine records utterances to prove the
 * dictation auto-play, replay and one-playback-at-a-time contract. The workflow
 * tests cover both card shapes, the suggested-grade override, requeue-once and
 * the caught-up empty state.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';

import type {SqlDriver} from '../src/db/driver';
import {migrateDatabase} from '../src/db/migrations';
import {
  createSentenceTopic,
  getSentenceById,
  insertSentences,
  listReviewLogForSentence,
} from '../src/db/sentenceRepository';
import type {SentenceTopicRecord} from '../src/db/types';
import type {SentencePracticeScreenProps} from '../src/navigation/types';
import {savePracticeMode} from '../src/preferences/practiceMode';
import {SentencePracticeScreen} from '../src/screens/SentencePracticeScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';
import type {TextToSpeechEngine} from '../src/tts/textToSpeech';
import {openSqlJsDriver} from '../testing/sqlJsDriver';

let db: SqlDriver;

jest.mock('../src/db/database', () => {
  const actualMigrations = jest.requireActual('../src/db/migrations').migrateDatabase;
  const handle: {db: SqlDriver} = {db: undefined as never};
  return {
    getLocalDatabase: jest.fn(async () => {
      await actualMigrations(handle.db);
      return handle.db;
    }),
    resetLocalDatabase: jest.fn(),
    __setDriver: (driver: SqlDriver) => {
      handle.db = driver;
    },
  };
});

const database = jest.mocked(require('../src/db/database'));
const asyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage> & {
  __resetAsyncStorageStore: () => void;
};

const goBack = jest.fn();
const navigate = jest.fn();
let listeners: Record<string, (() => void)[]> = {};

function screenProps(topicId: number): SentencePracticeScreenProps {
  return {
    navigation: {
      navigate,
      goBack,
      popToTop: jest.fn(),
      addListener: (event: string, callback: () => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(callback);
        return () => {
          listeners[event] = listeners[event].filter(cb => cb !== callback);
        };
      },
    },
    route: {
      key: 'sentence-practice-test',
      name: 'SentencePractice',
      params: {topicId},
    },
  } as unknown as SentencePracticeScreenProps;
}

interface EngineDouble {
  engine: TextToSpeechEngine;
  spoken: string[];
  stopMock: jest.Mock;
}

function makeEngine(): EngineDouble {
  const spoken: string[] = [];
  const stopMock = jest.fn();
  return {
    spoken,
    stopMock,
    engine: {
      async speak(text: string) {
        spoken.push(text);
      },
      stop: stopMock,
    },
  };
}

interface DeferredEngineDouble {
  engine: TextToSpeechEngine;
  spoken: {text: string; release: () => void}[];
  stopMock: jest.Mock;
}

function makeDeferredEngine(): DeferredEngineDouble {
  const spoken: {text: string; release: () => void}[] = [];
  const stopMock = jest.fn();
  return {
    spoken,
    stopMock,
    engine: {
      speak(text: string) {
        return new Promise<void>(resolve => {
          spoken.push({text, release: resolve});
        });
      },
      stop: stopMock,
    },
  };
}

async function renderPractice(
  topicId: number,
  speech?: TextToSpeechEngine,
) {
  const view = await render(
    <ThemeProvider>
      <SentencePracticeScreen {...screenProps(topicId)} speech={speech} />
    </ThemeProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('sentence-practice-loading')).toBeFalsy();
  });
  return view;
}

async function seedTopic(texts: readonly string[]): Promise<{
  topic: SentenceTopicRecord;
  ids: number[];
}> {
  const topic = await createSentenceTopic(db, {
    title: 'Small talk',
    description: 'Everyday conversations.',
  });
  const inserted = await insertSentences(
    db,
    topic.id,
    texts.map(text => ({
      text,
      meaning: `Meaning of ${text}`,
      situation: `Situation for ${text}`,
    })),
  );
  return {topic, ids: inserted.map(sentence => sentence.id)};
}

async function setDue(id: number, iso: string): Promise<void> {
  await db.execute('UPDATE sentences SET due_at = ? WHERE id = ?', [iso, id]);
}

async function setStatus(id: number, status: string): Promise<void> {
  await db.execute('UPDATE sentences SET status = ? WHERE id = ?', [status, id]);
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function answerAndCheck(
  view: Awaited<ReturnType<typeof renderPractice>>,
  answer: string,
): Promise<void> {
  await fireEvent.changeText(view.getByTestId('sentence-dictation-input'), answer);
  await fireEvent.press(view.getByTestId('sentence-dictation-check'));
}

beforeEach(async () => {
  jest.clearAllMocks();
  asyncStorage.__resetAsyncStorageStore();
  goBack.mockReset();
  navigate.mockReset();
  listeners = {};
  db = await openSqlJsDriver();
  await migrateDatabase(db);
  database.__setDriver(db);
});

afterEach(async () => {
  db?.close?.();
});

describe('SentencePracticeScreen — session build', () => {
  test('shows only due, non-suspended cards in due order and counts them', async () => {
    const {topic, ids} = await seedTopic([
      'First sentence',
      'Second sentence',
      'Third sentence',
      'Fourth sentence',
      'Suspended sentence',
      'Oldest sentence',
    ]);
    await setDue(ids[0], minutesAgo(3));
    await setDue(ids[1], minutesAgo(1));
    await setDue(ids[2], minutesAgo(2));
    await setDue(ids[3], daysAhead(1));
    await setStatus(ids[4], 'suspended');
    await setDue(ids[4], minutesAgo(10));
    await setDue(ids[5], minutesAgo(4));

    const {engine, spoken} = makeEngine();
    const view = await renderPractice(topic.id, engine);

    expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent(
      '1 / 4',
    );
    await waitFor(() => {
      expect(spoken).toEqual(['Oldest sentence']);
    });
  });
});

describe('SentencePracticeScreen — dictation card', () => {
  test('auto-plays once, replays on demand and silences on card change', async () => {
    const {topic} = await seedTopic(['First sentence', 'Second sentence']);
    const {engine, spoken, stopMock} = makeDeferredEngine();
    const view = await renderPractice(topic.id, engine);
    const texts = () => spoken.map(item => item.text);

    await waitFor(() => {
      expect(texts()).toEqual(['First sentence']);
    });

    await fireEvent.press(view.getByTestId('sentence-practice-replay'));
    expect(texts()).toEqual(['First sentence', 'First sentence']);

    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent(
        '2 / 2',
      );
    });
    await waitFor(() => {
      expect(texts()).toEqual([
        'First sentence',
        'First sentence',
        'Second sentence',
      ]);
    });
    expect(stopMock).toHaveBeenCalled();

    const stopsBeforeBlur = stopMock.mock.calls.length;
    await act(async () => {
      (listeners.blur ?? []).forEach(callback => callback());
    });
    expect(stopMock.mock.calls.length).toBeGreaterThan(stopsBeforeBlur);

    await view.unmount();
    spoken.forEach(item => item.release());
  });

  test('persists the schedule and a dictation review-log row', async () => {
    const {topic, ids} = await seedTopic(['Could I get a flat white, please?']);
    const view = await renderPractice(topic.id);

    await answerAndCheck(view, 'could i get a flat white please');

    expect(view.getByTestId('sentence-diff-summary')).toHaveTextContent(
      '7 correct',
    );
    expect(view.getByTestId('sentence-suggested-grade')).toHaveTextContent(
      'Suggested: Good',
    );
    expect(
      view.getByTestId('sentence-grade-good').props.accessibilityState?.selected,
    ).toBe(true);

    await fireEvent.press(view.getByTestId('sentence-grade-good'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-reviewed')).toHaveTextContent(
      '1 card reviewed',
    );
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 0 · Good 1 · Easy 0',
    );
    expect(view.getByTestId('sentence-practice-nothing-due')).toBeTruthy();

    const stored = await getSentenceById(db, ids[0]);
    expect(stored).toMatchObject({
      status: 'review',
      reps: 1,
      lapses: 0,
      interval_days: 1,
      last_grade: 'good',
    });

    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({grade: 'good', mode: 'dictation'});

    await fireEvent.press(view.getByTestId('sentence-practice-back-to-topic'));
    expect(goBack).toHaveBeenCalled();
  });

  test('pre-suggests Again for a missing word and lets the learner override with Easy', async () => {
    const {topic, ids} = await seedTopic(['I will have the same, thanks.']);
    const view = await renderPractice(topic.id);

    await answerAndCheck(view, 'I will have same thanks');

    expect(view.getByTestId('sentence-suggested-grade')).toHaveTextContent(
      'Suggested: Again',
    );
    expect(
      view.getByTestId('sentence-grade-again').props.accessibilityState?.selected,
    ).toBe(true);

    await fireEvent.press(view.getByTestId('sentence-grade-easy'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 0 · Good 0 · Easy 1',
    );

    const stored = await getSentenceById(db, ids[0]);
    expect(stored).toMatchObject({
      status: 'review',
      interval_days: 4,
      last_grade: 'easy',
    });
    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log[0]).toMatchObject({grade: 'easy', mode: 'dictation'});
  });
});

describe('SentencePracticeScreen — recall card', () => {
  test('reveals meaning and answer, plays TTS and logs a recall grade', async () => {
    const {topic, ids} = await seedTopic(['It was nice meeting you.']);
    await setStatus(ids[0], 'review');
    await setDue(ids[0], minutesAgo(1));

    const {engine, spoken} = makeEngine();
    const view = await renderPractice(topic.id, engine);

    expect(view.getByTestId('sentence-recall-card')).toBeTruthy();
    expect(view.getByTestId('sentence-recall-situation')).toHaveTextContent(
      'Situation for It was nice meeting you.',
    );
    expect(view.queryByTestId('sentence-dictation-input')).toBeFalsy();
    expect(view.queryByTestId('sentence-grade-good')).toBeFalsy();

    await fireEvent.press(view.getByTestId('sentence-recall-show-meaning'));
    expect(view.getByTestId('sentence-recall-meaning')).toHaveTextContent(
      'Meaning of It was nice meeting you.',
    );

    await fireEvent.press(view.getByTestId('sentence-recall-reveal'));
    expect(view.getByTestId('sentence-recall-answer')).toHaveTextContent(
      'It was nice meeting you.',
    );
    expect(spoken).toEqual(['It was nice meeting you.']);
    expect(view.getByTestId('sentence-grade-good')).toBeTruthy();

    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await view.findByTestId('sentence-practice-summary');

    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log[0]).toMatchObject({grade: 'good', mode: 'recall'});
  });

  test('forced modes override the schedule for every card', async () => {
    await savePracticeMode('recall');
    const recallSeed = await seedTopic(['A new sentence shown as recall.']);
    const recallView = await renderPractice(recallSeed.topic.id);

    expect(recallView.getByTestId('sentence-recall-card')).toBeTruthy();
    await recallView.unmount();

    await savePracticeMode('dictation');
    const dictationSeed = await seedTopic(['A review sentence shown as dictation.']);
    await setStatus(dictationSeed.ids[0], 'review');
    await setDue(dictationSeed.ids[0], minutesAgo(1));
    const dictationView = await renderPractice(dictationSeed.topic.id);

    expect(dictationView.getByTestId('sentence-dictation-card')).toBeTruthy();
    await dictationView.unmount();
  });
});

describe('SentencePracticeScreen — requeue and empty state', () => {
  test('reappears once after Again and a second Again does not requeue it', async () => {
    const {topic, ids} = await seedTopic(['First sentence', 'Second sentence']);
    const {engine, spoken} = makeEngine();
    const view = await renderPractice(topic.id, engine);

    await waitFor(() => {
      expect(spoken).toEqual(['First sentence']);
    });

    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-again'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent(
        '2 / 3',
      );
    });
    await waitFor(() => {
      expect(spoken).toEqual(['First sentence', 'Second sentence']);
    });

    await answerAndCheck(view, 'Second sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent(
        '3 / 3',
      );
    });
    await waitFor(() => {
      expect(spoken).toEqual([
        'First sentence',
        'Second sentence',
        'First sentence',
      ]);
    });

    // The requeued card comes back once; grading it Again ends the session.
    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-again'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-reviewed')).toHaveTextContent(
      '3 cards reviewed',
    );
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 2 · Good 1 · Easy 0',
    );

    const firstLog = await listReviewLogForSentence(db, ids[0]);
    const secondLog = await listReviewLogForSentence(db, ids[1]);
    expect(firstLog.map(entry => entry.grade)).toEqual(['again', 'again']);
    expect(secondLog.map(entry => entry.grade)).toEqual(['good']);
  });

  test('shows "All caught up" and names the next due time when nothing is due', async () => {
    const {topic, ids} = await seedTopic(['Not due yet.']);
    await setDue(ids[0], daysAhead(2));

    const view = await renderPractice(topic.id);

    expect(view.getByTestId('sentence-practice-empty')).toBeTruthy();
    expect(view.getByText('All caught up')).toBeTruthy();
    expect(view.getByTestId('sentence-practice-next-due')).toHaveTextContent(
      /Next due in 2 days/,
    );
    expect(view.queryByTestId('sentence-dictation-input')).toBeFalsy();
  });
});
