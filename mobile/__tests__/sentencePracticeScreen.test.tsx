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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';

import type { SqlDriver } from '../src/db/driver';
import { migrateDatabase } from '../src/db/migrations';
import {
  createSentenceTopic,
  getSentenceById,
  insertSentences,
  listReviewLogForSentence,
} from '../src/db/sentenceRepository';
import type { SentenceTopicRecord } from '../src/db/types';
import type { SentencePracticeScreenProps } from '../src/navigation/types';
import { savePracticeMode } from '../src/preferences/practiceMode';
import { SentencePracticeScreen } from '../src/screens/SentencePracticeScreen';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { TextToSpeechEngine } from '../src/tts/textToSpeech';
import { openSqlJsDriver } from '../testing/sqlJsDriver';

let db: SqlDriver;

jest.mock('../src/db/database', () => {
  const actualMigrations = jest.requireActual('../src/db/migrations').migrateDatabase;
  const handle: { db: SqlDriver } = { db: undefined as never };
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
      params: { topicId },
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
  spoken: { text: string; release: () => void }[];
  stopMock: jest.Mock;
}

function makeDeferredEngine(): DeferredEngineDouble {
  const spoken: { text: string; release: () => void }[] = [];
  const stopMock = jest.fn();
  return {
    spoken,
    stopMock,
    engine: {
      speak(text: string) {
        return new Promise<void>(resolve => {
          spoken.push({ text, release: resolve });
        });
      },
      stop: stopMock,
    },
  };
}

async function renderPractice(topicId: number, speech?: TextToSpeechEngine) {
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
  return { topic, ids: inserted.map(sentence => sentence.id) };
}

async function setDue(id: number, iso: string): Promise<void> {
  await db.execute('UPDATE sentences SET due_at = ? WHERE id = ?', [iso, id]);
}

async function setStateColumn(id: number, state: string): Promise<void> {
  await db.execute('UPDATE sentences SET state = ? WHERE id = ?', [state, id]);
}

async function setSuspended(id: number): Promise<void> {
  await db.execute('UPDATE sentences SET suspended = 1 WHERE id = ?', [id]);
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
    const { topic, ids } = await seedTopic([
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
    await setSuspended(ids[4]);
    await setDue(ids[4], minutesAgo(10));
    await setDue(ids[5], minutesAgo(4));

    const { engine, spoken } = makeEngine();
    const view = await renderPractice(topic.id, engine);

    expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('1 / 4');
    await waitFor(() => {
      expect(spoken).toEqual(['Oldest sentence']);
    });
  });
});

describe('SentencePracticeScreen — dictation card', () => {
  test('auto-plays once, replays without dismissing the keyboard and silences on card change', async () => {
    const { topic } = await seedTopic(['First sentence', 'Second sentence']);
    const { engine, spoken, stopMock } = makeDeferredEngine();
    const view = await renderPractice(topic.id, engine);
    const texts = () => spoken.map(item => item.text);
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss');

    await waitFor(() => {
      expect(texts()).toEqual(['First sentence']);
    });

    await fireEvent.press(view.getByTestId('sentence-practice-replay'));
    expect(texts()).toEqual(['First sentence', 'First sentence']);
    // Replay keeps the answer input focused so typing can continue with the
    // cursor where the learner left it.
    expect(dismissSpy).not.toHaveBeenCalled();

    await answerAndCheck(view, 'First sentence');
    // Checking the answer is still allowed to dismiss the keyboard.
    expect(dismissSpy).toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('sentence-grade-good'));

    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('2 / 3');
    });
    await waitFor(() => {
      expect(texts()).toEqual(['First sentence', 'First sentence', 'Second sentence']);
    });
    expect(stopMock).toHaveBeenCalled();

    const stopsBeforeBlur = stopMock.mock.calls.length;
    await act(async () => {
      (listeners.blur ?? []).forEach(callback => {
        callback();
      });
    });
    expect(stopMock.mock.calls.length).toBeGreaterThan(stopsBeforeBlur);

    await view.unmount();
    spoken.forEach(item => {
      item.release();
    });
    dismissSpy.mockRestore();
  });

  test('persists the FSRS schedule and an Anki-shaped dictation log', async () => {
    const { topic, ids } = await seedTopic(['Could I get a flat white, please?']);
    const view = await renderPractice(topic.id);

    await answerAndCheck(view, 'could i get a flat white please');

    expect(view.getByTestId('sentence-dictation-answer')).toHaveTextContent(
      'Could I get a flat white, please?',
    );
    expect(view.getByTestId('sentence-dictation-answer').props.selectable).toBe(true);
    expect(view.getByTestId('sentence-dictation-meaning').props.selectable).toBe(true);
    expect(view.getByTestId('sentence-dictation-situation').props.selectable).toBe(true);
    expect(view.getByTestId('sentence-diff-summary')).toHaveTextContent('7 correct');
    expect(view.getByTestId('sentence-suggested-grade')).toHaveTextContent('Suggested: Good');
    expect(view.getByTestId('sentence-grade-good').props.accessibilityState?.selected).toBe(true);

    // Anki's four buttons, each carrying the interval it would schedule.
    expect(view.getByTestId('sentence-grade-hard')).toBeTruthy();
    expect(view.getByTestId('sentence-grade-interval-again')).toHaveTextContent('1m');
    expect(view.getByTestId('sentence-grade-interval-good')).toHaveTextContent('10m');
    // Fuzz is seeded per card, so the Easy hint is stable for this card.
    expect(view.getByTestId('sentence-grade-interval-easy')).toHaveTextContent(/^\d+d$/);

    // The first Good only advances the learning step: FSRS keeps the card in
    // the session, so it comes back for the graduating Good.
    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('2 / 2');
    });

    await answerAndCheck(view, 'could i get a flat white please');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-reviewed')).toHaveTextContent('2 cards reviewed');
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 0 · Hard 0 · Good 2 · Easy 0',
    );
    expect(view.getByTestId('sentence-practice-nothing-due')).toBeTruthy();

    const stored = await getSentenceById(db, ids[0]);
    expect(stored).toMatchObject({
      state: 'review',
      reps: 2,
      lapses: 0,
      learning_steps: 0,
      last_grade: 'good',
    });
    expect(stored?.stability).toBeGreaterThan(0);
    expect(stored?.scheduled_days).toBeGreaterThanOrEqual(1);
    expect(new Date(stored?.due_at ?? '').getHours()).toBe(4);

    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log).toHaveLength(2);
    // Newest first: the graduating review, then the learning step.
    expect(log.map(entry => entry.grade)).toEqual(['good', 'good']);
    expect(log[1]).toMatchObject({ state: 'new', rating: 3, mode: 'dictation' });
    expect(log[0]).toMatchObject({ state: 'learning', rating: 3, mode: 'dictation' });
    expect(log[0].review_duration_ms).toBeGreaterThanOrEqual(0);

    await fireEvent.press(view.getByTestId('sentence-practice-back-to-topic'));
    expect(goBack).toHaveBeenCalled();
  });

  test('pre-suggests Again for a missing word and lets the learner override with Easy', async () => {
    const { topic, ids } = await seedTopic(['I will have the same, thanks.']);
    const view = await renderPractice(topic.id);

    await answerAndCheck(view, 'I will have same thanks');

    expect(view.getByTestId('sentence-suggested-grade')).toHaveTextContent('Suggested: Again');
    expect(view.getByTestId('sentence-grade-again').props.accessibilityState?.selected).toBe(true);

    await fireEvent.press(view.getByTestId('sentence-grade-easy'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 0 · Hard 0 · Good 0 · Easy 1',
    );

    const stored = await getSentenceById(db, ids[0]);
    expect(stored).toMatchObject({
      state: 'review',
      last_grade: 'easy',
    });
    expect(stored?.scheduled_days).toBeGreaterThanOrEqual(1);
    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log[0]).toMatchObject({ grade: 'easy', rating: 4, mode: 'dictation' });
  });
});

describe('SentencePracticeScreen — recall card', () => {
  test('reveals meaning and answer, plays TTS and logs a recall grade', async () => {
    const { topic, ids } = await seedTopic(['It was nice meeting you.']);
    await setStateColumn(ids[0], 'review');
    await setDue(ids[0], minutesAgo(1));

    const { engine, spoken } = makeEngine();
    const view = await renderPractice(topic.id, engine);

    expect(view.getByTestId('sentence-recall-card')).toBeTruthy();
    expect(view.getByTestId('sentence-recall-situation')).toHaveTextContent(
      'Situation for It was nice meeting you.',
    );
    expect(view.getByTestId('sentence-recall-situation').props.selectable).toBe(true);
    expect(view.queryByTestId('sentence-dictation-input')).toBeFalsy();
    expect(view.queryByTestId('sentence-grade-good')).toBeFalsy();

    await fireEvent.press(view.getByTestId('sentence-recall-show-meaning'));
    expect(view.getByTestId('sentence-recall-meaning')).toHaveTextContent(
      'Meaning of It was nice meeting you.',
    );
    expect(view.getByTestId('sentence-recall-meaning').props.selectable).toBe(true);

    await fireEvent.press(view.getByTestId('sentence-recall-reveal'));
    expect(view.getByTestId('sentence-recall-answer')).toHaveTextContent(
      'It was nice meeting you.',
    );
    expect(spoken).toEqual(['It was nice meeting you.']);
    expect(view.getByTestId('sentence-grade-good')).toBeTruthy();

    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await view.findByTestId('sentence-practice-summary');

    const log = await listReviewLogForSentence(db, ids[0]);
    expect(log[0]).toMatchObject({ grade: 'good', mode: 'recall' });
  });

  test('forced modes override the schedule for every card', async () => {
    await savePracticeMode('recall');
    const recallSeed = await seedTopic(['A new sentence shown as recall.']);
    const recallView = await renderPractice(recallSeed.topic.id);

    expect(recallView.getByTestId('sentence-recall-card')).toBeTruthy();
    await recallView.unmount();

    await savePracticeMode('dictation');
    const dictationSeed = await seedTopic(['A review sentence shown as dictation.']);
    await setStateColumn(dictationSeed.ids[0], 'review');
    await setDue(dictationSeed.ids[0], minutesAgo(1));
    const dictationView = await renderPractice(dictationSeed.topic.id);

    expect(dictationView.getByTestId('sentence-dictation-card')).toBeTruthy();
    await dictationView.unmount();
  });
});

describe('SentencePracticeScreen — requeue and empty state', () => {
  test('keeps learning cards in the session until FSRS graduates them', async () => {
    const { topic, ids } = await seedTopic(['First sentence', 'Second sentence']);
    const { engine, spoken } = makeEngine();
    const view = await renderPractice(topic.id, engine);

    await waitFor(() => {
      expect(spoken).toEqual(['First sentence']);
    });

    // Again: the card drops into the 1-minute learning step and is requeued.
    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-again'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('2 / 3');
    });
    await waitFor(() => {
      expect(spoken).toEqual(['First sentence', 'Second sentence']);
    });

    // Good on a new card only advances to the 10-minute step: still learning.
    await answerAndCheck(view, 'Second sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('3 / 4');
    });
    await waitFor(() => {
      expect(spoken).toEqual(['First sentence', 'Second sentence', 'First sentence']);
    });

    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('4 / 5');
    });
    await waitFor(() => {
      expect(spoken).toEqual([
        'First sentence',
        'Second sentence',
        'First sentence',
        'Second sentence',
      ]);
    });

    // The second Good graduates card 2 to review, so it leaves the queue.
    await answerAndCheck(view, 'Second sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));
    await waitFor(() => {
      expect(view.getByTestId('sentence-practice-progress')).toHaveTextContent('5 / 5');
    });
    await waitFor(() => {
      expect(spoken).toEqual([
        'First sentence',
        'Second sentence',
        'First sentence',
        'Second sentence',
        'First sentence',
      ]);
    });

    // The second Good on card 1 graduates it too, ending the session.
    await answerAndCheck(view, 'First sentence');
    await fireEvent.press(view.getByTestId('sentence-grade-good'));

    await view.findByTestId('sentence-practice-summary');
    expect(view.getByTestId('sentence-practice-reviewed')).toHaveTextContent('5 cards reviewed');
    expect(view.getByTestId('sentence-practice-grades')).toHaveTextContent(
      'Again 1 · Hard 0 · Good 4 · Easy 0',
    );

    const firstLog = await listReviewLogForSentence(db, ids[0]);
    const secondLog = await listReviewLogForSentence(db, ids[1]);
    expect(firstLog.map(entry => entry.grade)).toEqual(['good', 'good', 'again']);
    expect(secondLog.map(entry => entry.grade)).toEqual(['good', 'good']);
  });

  test('shows "All caught up" and names the next due time when nothing is due', async () => {
    const { topic, ids } = await seedTopic(['Not due yet.']);
    await setDue(ids[0], daysAhead(2));

    const view = await renderPractice(topic.id);

    expect(view.getByTestId('sentence-practice-empty')).toBeTruthy();
    expect(view.getByText('All caught up')).toBeTruthy();
    expect(view.getByTestId('sentence-practice-next-due')).toHaveTextContent(/Next due in 2 days/);
    expect(view.queryByTestId('sentence-dictation-input')).toBeFalsy();
  });
});
