/**
 * Create-topic screen tests (TASK-SENT-008).
 *
 * The form lives on its own screen now. These tests run against the real
 * in-memory sql.js repository: saving writes the topic (including the optional
 * advanced generation guidance) and replaces the form with the new topic, while
 * Cancel and Back pop without writing anything.
 */
import React from 'react';
import {fireEvent, render, waitFor} from '@testing-library/react-native';

import {getSentenceTopicById} from '../src/db/sentenceRepository';
import type {SqlDriver} from '../src/db/driver';
import {SentenceTopicNewScreen} from '../src/screens/SentenceTopicNewScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';
import {ModeProvider} from '../src/mode/ModeContext';
import {saveApplicationMode} from '../src/mode/modeStorage';
import type {SentenceTopicNewScreenProps} from '../src/navigation/types';
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

const replace = jest.fn();
const goBack = jest.fn();

function screenProps(): SentenceTopicNewScreenProps {
  return {
    navigation: {
      replace,
      goBack,
    },
    route: {key: 'sentence-topic-new-test', name: 'SentenceTopicNew'},
  } as unknown as SentenceTopicNewScreenProps;
}

async function renderScreen() {
  db = await openSqlJsDriver();
  database.__setDriver(db);
  await saveApplicationMode('serverless');
  const view = await render(
    <ModeProvider>
      <ThemeProvider>
        <SentenceTopicNewScreen {...screenProps()} />
      </ThemeProvider>
    </ModeProvider>,
  );
  await view.findByTestId('sentence-topic-title');
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  replace.mockReset();
  goBack.mockReset();
});

afterEach(() => {
  db?.close?.();
});

describe('SentenceTopicNewScreen', () => {
  test('saves the title and description then replaces itself with the topic', async () => {
    const view = await renderScreen();

    await fireEvent.changeText(view.getByTestId('sentence-topic-title'), 'Meeting someone new');
    await fireEvent.changeText(
      view.getByTestId('sentence-topic-description'),
      'first day in a new city',
    );
    await fireEvent.press(view.getByTestId('sentence-topic-save'));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('SentenceTopic', {
        topicId: expect.any(Number),
      });
    });
    const topicId = replace.mock.calls[0][1].topicId as number;
    expect(await getSentenceTopicById(db, topicId)).toMatchObject({
      title: 'Meeting someone new',
      description: 'first day in a new city',
      generation_prompt: '',
    });
  });

  test('the save button is disabled while the title is blank', async () => {
    const view = await renderScreen();

    expect(
      view.getByTestId('sentence-topic-save').props.accessibilityState?.disabled,
    ).toBe(true);

    await fireEvent.changeText(view.getByTestId('sentence-topic-title'), '   ');
    expect(
      view.getByTestId('sentence-topic-save').props.accessibilityState?.disabled,
    ).toBe(true);

    await fireEvent.changeText(view.getByTestId('sentence-topic-title'), 'Greetings');
    expect(
      view.getByTestId('sentence-topic-save').props.accessibilityState?.disabled,
    ).toBe(false);
  });

  test('reveals advanced generation instructions and stores them on the topic', async () => {
    const view = await renderScreen();

    expect(view.queryByTestId('sentence-topic-generation-prompt')).toBeFalsy();
    expect(
      view.getByTestId('sentence-topic-advanced-toggle').props.accessibilityState,
    ).toEqual({checked: false});

    await fireEvent.press(view.getByTestId('sentence-topic-advanced-toggle'));
    expect(
      view.getByTestId('sentence-topic-advanced-toggle').props.accessibilityState,
    ).toEqual({checked: true});

    await fireEvent.changeText(view.getByTestId('sentence-topic-title'), 'Phone calls');
    await fireEvent.changeText(
      view.getByTestId('sentence-topic-generation-prompt'),
      'Use British spelling and focus on phone calls.',
    );
    await fireEvent.press(view.getByTestId('sentence-topic-save'));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('SentenceTopic', {
        topicId: expect.any(Number),
      });
    });
    const topicId = replace.mock.calls[0][1].topicId as number;
    expect((await getSentenceTopicById(db, topicId))?.generation_prompt).toBe(
      'Use British spelling and focus on phone calls.',
    );
  });

  test('cancel and back pop without persisting a topic', async () => {
    const view = await renderScreen();

    await fireEvent.changeText(view.getByTestId('sentence-topic-title'), 'A topic');
    await fireEvent.press(view.getByTestId('sentence-topic-cancel'));
    expect(goBack).toHaveBeenCalledTimes(1);

    await fireEvent.press(view.getByTestId('sentence-new-topic-back'));
    expect(goBack).toHaveBeenCalledTimes(2);
    expect(replace).not.toHaveBeenCalled();
  });
});
