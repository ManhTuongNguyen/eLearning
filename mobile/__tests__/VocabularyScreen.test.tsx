/**
 * Vocabulary screen tests (SPEC TASK-072/075): saved expressions render newest-
 * first exactly as delivered, enrichment status is visible per row ("Enriching…"
 * while pending, a failure note while failed, enriched fields once complete),
 * pagination appends further pages through a guarded Load-more control, and
 * loading/empty/error states are all explicit — including retry after a
 * failed first page and failures that never destroy already-visible rows.
 * The TASK-075 export control fetches the Anki CSV, hands it to the native
 * share seam behind busy-state guarding, confirms through a toast and
 * surfaces failures as a retryable alert without disturbing the list.
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import * as authApi from '../src/api/auth';
import {ApiError} from '../src/api/client';
import type {Paginated} from '../src/api/sessions';
import * as vocabularyApi from '../src/api/vocabulary';
import type {VocabularyItem} from '../src/api/vocabulary';
import {AuthProvider} from '../src/auth/AuthContext';
import {ModeProvider} from '../src/mode/ModeContext';
import * as secureStorage from '../src/auth/secureStorage';
import type {MainStackParamList} from '../src/navigation/types';
import {ChatScreen} from '../src/screens/ChatScreen';
import {VocabularyScreen} from '../src/screens/VocabularyScreen';
import {ThemeProvider} from '../src/theme/ThemeContext';
import * as ankiShare from '../src/utils/ankiShare';

jest.mock('../src/api/auth');
jest.mock('../src/api/vocabulary');
jest.mock('../src/auth/secureStorage');
jest.mock('../src/utils/ankiShare');

const mockedAuth = jest.mocked(authApi);
const mockedVocabulary = jest.mocked(vocabularyApi);
const mockedStorage = jest.mocked(secureStorage);
const mockedShare = jest.mocked(ankiShare);

function makeItem(overrides: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: 1,
    expression: 'set off',
    normalized_expression: 'set off',
    definition: '',
    translation: '',
    pronunciation: '',
    part_of_speech: '',
    example: '',
    status: 'pending',
    source_message: null,
    source_session: null,
    created_at: '2026-08-26T10:00:00Z',
    ...overrides,
  };
}

function itemPage(
  results: VocabularyItem[],
  next: string | null = null,
): Paginated<VocabularyItem> {
  return {count: results.length, next, previous: null, results};
}

function renderedItemIds(): number[] {
  return screen
    .queryAllByTestId(/^vocabulary-item-/)
    .map(element => element.props.testID as string)
    .map(testId => Number(testId.replace('vocabulary-item-', '')));
}

async function renderVocabulary(options?: {withChatUnderneath?: boolean}) {
  const Stack = createNativeStackNavigator<MainStackParamList>();
  const navigator = (
    <NavigationContainer
      initialState={
        options?.withChatUnderneath
          ? {index: 1, routes: [{name: 'Chat'}, {name: 'Vocabulary'}]}
          : undefined
      }>
      <Stack.Navigator screenOptions={{headerShown: false}} initialRouteName="Vocabulary">
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="Vocabulary" component={VocabularyScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );

  return render(
    <ModeProvider>
      <ThemeProvider>
        <AuthProvider>{navigator}</AuthProvider>
      </ThemeProvider>
    </ModeProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedStorage.loadTokens.mockResolvedValue({access: 'token-a', refresh: 'token-r'});
  mockedAuth.getMe.mockResolvedValue({id: 1, username: 'alice', email: 'alice@example.com'});
});

describe('VocabularyScreen', () => {
  it('shows a loading state, then renders saved expressions in delivered order', async () => {
    let resolveFirstPage: (page: Paginated<VocabularyItem>) => void = () => {};
    mockedVocabulary.listVocabulary.mockImplementation(
      () =>
        new Promise<Paginated<VocabularyItem>>(resolve => {
          resolveFirstPage = resolve;
        }),
    );
    await renderVocabulary();

    expect(await screen.findByTestId('vocabulary-loading')).toBeOnTheScreen();

    resolveFirstPage(
      itemPage([
        makeItem({id: 302, expression: 'wanderlust'}),
        makeItem({id: 301, expression: 'gobsmacked'}),
      ]),
    );

    await waitFor(() => expect(renderedItemIds()).toEqual([302, 301]));
    expect(screen.getByText('wanderlust')).toBeOnTheScreen();
    expect(screen.queryByTestId('vocabulary-loading')).toBeNull();
  });

  it('shows an empty state when nothing has been saved yet', async () => {
    mockedVocabulary.listVocabulary.mockResolvedValue(itemPage([]));
    await renderVocabulary();

    expect(await screen.findByTestId('vocabulary-empty')).toBeOnTheScreen();
    expect(screen.queryAllByTestId(/^vocabulary-item-/)).toHaveLength(0);
    expect(screen.queryByTestId('vocabulary-load-more')).toBeNull();
  });

  it('surfaces load failures and recovers through Try again', async () => {
    mockedVocabulary.listVocabulary
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed.'))
      .mockResolvedValueOnce(itemPage([makeItem({id: 5, expression: 'serendipity'})]));
    await renderVocabulary();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'The server is unreachable right now. Please try again later.',
    );
    expect(mockedVocabulary.listVocabulary).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('vocabulary-retry'));

    await waitFor(() =>
      expect(mockedVocabulary.listVocabulary).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText('serendipity')).toBeOnTheScreen();
    expect(screen.queryByTestId('form-error')).toBeNull();
  });

  it('asks the user to sign in again when no access token is available', async () => {
    mockedStorage.loadTokens.mockResolvedValue(null);
    // TASK-AUDIT-005: the screen hands the central authed requester to the
    // binding; signed out, the wrapper rejects before any transport work —
    // simulated here with the exact rejection the wrapper produces.
    mockedVocabulary.listVocabulary.mockRejectedValue(
      new ApiError(401, 'You are signed out. Please log in again.', {}, 'authentication'),
    );
    await renderVocabulary();

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      'You are signed out. Please log in again.',
    );
  });

  it('marks pending rows as still enriching without enriched fields', async () => {
    mockedVocabulary.listVocabulary.mockResolvedValue(
      itemPage([
        makeItem({
          id: 7,
          expression: 'gobsmacked',
          status: 'pending',
          definition: '',
        }),
      ]),
    );
    await renderVocabulary();

    expect(await screen.findByTestId('vocab-badge-pending')).toHaveTextContent(
      'Enriching…',
    );
    expect(screen.queryByText(/definition/i)).toBeNull();
  });

  it('renders enriched fields for complete rows', async () => {
    mockedVocabulary.listVocabulary.mockResolvedValue(
      itemPage([
        makeItem({
          id: 9,
          expression: 'Serendipity',
          status: 'complete',
          part_of_speech: 'noun',
          definition: 'a happy accident',
          translation: 'счастливая случайность',
          pronunciation: '/ˌserənˈdɪpɪti/',
          example: 'Finding this book was pure serendipity.',
        }),
      ]),
    );
    await renderVocabulary();

    expect(await screen.findByText('Serendipity')).toBeOnTheScreen();
    expect(screen.getByText('noun')).toBeOnTheScreen();
    expect(screen.getByText('a happy accident')).toBeOnTheScreen();
    expect(screen.getByText('счастливая случайность')).toBeOnTheScreen();
    expect(screen.getByText('/ˌserənˈdɪpɪti/')).toBeOnTheScreen();
    expect(screen.getByText('Finding this book was pure serendipity.')).toBeOnTheScreen();
    expect(screen.queryByTestId('vocab-badge-pending')).toBeNull();
    expect(screen.queryByTestId('vocab-badge-failed')).toBeNull();
  });

  it('flags failed enrichment with a badge and an explanatory note', async () => {
    mockedVocabulary.listVocabulary.mockResolvedValue(
      itemPage([
        makeItem({
          id: 11,
          expression: 'set off',
          status: 'failed',
          definition: '',
        }),
      ]),
    );
    await renderVocabulary();

    expect(await screen.findByTestId('vocab-badge-failed')).toBeOnTheScreen();
    expect(
      screen.getByText('Enrichment failed — it will be retried automatically.'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('vocab-badge-pending')).toBeNull();
  });

  it('appends further pages in order and hides Load more once exhausted', async () => {
    mockedVocabulary.listVocabulary
      .mockResolvedValueOnce(
        itemPage(
          [
            makeItem({id: 12, expression: 'phrase twelve'}),
            makeItem({id: 11, expression: 'phrase eleven'}),
          ],
          'http://api.test/api/v1/vocabulary/?page=2',
        ),
      )
      .mockResolvedValueOnce(itemPage([makeItem({id: 10, expression: 'phrase ten'})]));

    await renderVocabulary();
    const loadMore = await screen.findByTestId('vocabulary-load-more');
    expect(loadMore).toBeOnTheScreen();

    await fireEvent.press(loadMore);

    await waitFor(() =>
      expect(mockedVocabulary.listVocabulary).toHaveBeenCalledWith(expect.any(Function), 2),
    );
    await waitFor(() => expect(renderedItemIds()).toEqual([12, 11, 10]));
    expect(screen.queryByTestId('vocabulary-load-more')).toBeNull();
  });

  it('guards Load more against double-fires while a page is loading', async () => {
    let resolveSecondPage: (page: Paginated<VocabularyItem>) => void = () => {};
    mockedVocabulary.listVocabulary
      .mockResolvedValueOnce(
        itemPage(
          [makeItem({id: 9})],
          'http://api.test/api/v1/vocabulary/?page=2',
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Paginated<VocabularyItem>>(resolve => {
            resolveSecondPage = resolve;
          }),
      );

    await renderVocabulary();
    await screen.findByTestId('vocabulary-item-9');

    await fireEvent.press(screen.getByTestId('vocabulary-load-more'));
    expect(await screen.findByTestId('vocabulary-load-more')).toBeDisabled();

    // Second press while loading must not fire another request.
    await fireEvent.press(screen.getByTestId('vocabulary-load-more'));
    expect(mockedVocabulary.listVocabulary).toHaveBeenCalledTimes(2);

    // A further page keeps the control; it must be re-enabled after settle.
    resolveSecondPage(
      itemPage([makeItem({id: 8})], 'http://api.test/api/v1/vocabulary/?page=3'),
    );
    await waitFor(() => expect(renderedItemIds()).toEqual([9, 8]));
    expect(screen.getByTestId('vocabulary-load-more')).toBeEnabled();
  });

  it('keeps loaded rows when loading another page fails', async () => {
    mockedVocabulary.listVocabulary
      .mockResolvedValueOnce(
        itemPage([makeItem({id: 6})], 'http://api.test/api/v1/vocabulary/?page=2'),
      )
      .mockRejectedValueOnce(new ApiError(500, 'Boom'));

    await renderVocabulary();
    await screen.findByTestId('vocabulary-item-6');

    await fireEvent.press(screen.getByTestId('vocabulary-load-more'));

    expect(await screen.findByTestId('form-error')).toBeOnTheScreen();
    expect(renderedItemIds()).toEqual([6]);
    // Rows survive; the control re-enables so the user can try again.
    expect(screen.getByTestId('vocabulary-load-more')).toBeEnabled();
    expect(screen.queryByTestId('vocabulary-retry')).toBeNull();
  });

  it('dismisses back to the underlying chat via the close control', async () => {
    mockedVocabulary.listVocabulary.mockResolvedValue(itemPage([]));
    await renderVocabulary({withChatUnderneath: true});

    await screen.findByTestId('vocabulary-empty');

    await fireEvent.press(screen.getByTestId('vocabulary-back'));

    await waitFor(() => expect(screen.getByTestId('chat-no-session')).toBeOnTheScreen());
  });

  describe('export flow (TASK-075)', () => {
    const EXPORT_CSV = 'Front,Back,Example,Pronunciation\n"set off","phrasal verb",,\n';

    beforeEach(() => {
      mockedVocabulary.listVocabulary.mockResolvedValue(itemPage([]));
      mockedShare.shareAnkiCsv.mockResolvedValue(undefined);
    });

    it('exports the CSV through the native share seam and confirms with a toast', async () => {
      mockedVocabulary.exportVocabulary.mockResolvedValue(EXPORT_CSV);
      await renderVocabulary();
      await screen.findByTestId('vocabulary-empty');

      await fireEvent.press(screen.getByTestId('vocabulary-export'));

      await waitFor(() =>
        expect(mockedVocabulary.exportVocabulary).toHaveBeenCalledWith('token-a'),
      );
      expect(mockedShare.shareAnkiCsv).toHaveBeenCalledWith(EXPORT_CSV);
      expect(await screen.findByTestId('vocabulary-toast')).toHaveTextContent(
        'Vocabulary exported — choose where to save or share it',
      );
    });

    it('guards double-presses while an export is in flight', async () => {
      let resolveExport: (csv: string) => void = () => {};
      mockedVocabulary.exportVocabulary.mockImplementation(
        () =>
          new Promise<string>(resolve => {
            resolveExport = resolve;
          }),
      );
      await renderVocabulary();
      await screen.findByTestId('vocabulary-empty');

      await fireEvent.press(screen.getByTestId('vocabulary-export'));
      expect(await screen.findByText('Exporting…')).toBeOnTheScreen();

      // A second press while busy must not fire another request.
      await fireEvent.press(screen.getByTestId('vocabulary-export'));
      expect(mockedVocabulary.exportVocabulary).toHaveBeenCalledTimes(1);

      resolveExport(EXPORT_CSV);
      await screen.findByTestId('vocabulary-toast');
      expect(screen.getByText('Export CSV')).toBeOnTheScreen();
      expect(screen.queryByText('Exporting…')).toBeNull();
    });

    it('shows a retryable alert when the export fails and keeps the list intact', async () => {
      mockedVocabulary.listVocabulary.mockResolvedValue(
        itemPage([makeItem({id: 4, expression: 'serendipity'})]),
      );
      mockedVocabulary.exportVocabulary
        .mockRejectedValueOnce(new ApiError(0, 'Network request failed.'))
        .mockResolvedValueOnce(EXPORT_CSV);
      await renderVocabulary();
      await screen.findByTestId('vocabulary-item-4');

      await fireEvent.press(screen.getByTestId('vocabulary-export'));

      expect(await screen.findByTestId('vocabulary-export-error')).toHaveTextContent(
        'The server is unreachable right now. Please try again later.',
      );
      expect(screen.queryByTestId('vocabulary-toast')).toBeNull();
      expect(mockedShare.shareAnkiCsv).not.toHaveBeenCalled();
      expect(screen.getByTestId('vocabulary-item-4')).toBeOnTheScreen();

      await fireEvent.press(screen.getByTestId('vocabulary-export'));

      await waitFor(() => expect(screen.queryByTestId('vocabulary-export-error')).toBeNull());
      expect(mockedShare.shareAnkiCsv).toHaveBeenCalledWith(EXPORT_CSV);
      expect(screen.queryByTestId('vocabulary-retry')).toBeNull();
    });
  });
});
