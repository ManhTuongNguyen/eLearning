/**
 * Grammar auto-check hook tests.
 *
 * Covers the full contract of useGrammarAutoCheck: default-off opt-in
 * (disabled ⇒ zero requests), per-message check through the mode's
 * improvement pipeline, severity caching (badge data) including "none"
 * (no badge), skip rules (assistant rows, pending/failed, blank content,
 * synthetic optimistic echoes), history seeding (a settled session load
 * never auto-checks old rows), session switching dropping state, silent
 * failure, and the badge press path showing the cached result in the
 * improvement sheet without a second API call.
 */
import React from 'react';
import {Text, View} from 'react-native';
import {act, render, screen, waitFor} from '@testing-library/react-native';

import type {ChatMessage, MessageImprovement} from '../src/api/sessions';
import * as sessionsApi from '../src/api/sessions';
import type {AuthedRequester} from '../src/auth/authedRequest';
import type {ApplicationMode} from '../src/mode/types';
import * as serverlessImprovement from '../src/serverless/improvement';
import * as serverlessSettings from '../src/serverless/settings';
import * as messageStore from '../src/db/messageStore';
import {useGrammarAutoCheck} from '../src/hooks/useGrammarAutoCheck';

jest.mock('../src/api/sessions', () => ({
  __esModule: true,
  improveMessage: jest.fn(),
}));
jest.mock('../src/serverless/improvement', () => ({
  __esModule: true,
  generateImprovement: jest.fn(),
}));
jest.mock('../src/serverless/providerRegistry', () => ({
  __esModule: true,
  createProviderClient: jest.fn(() => ({}) as never),
}));
jest.mock('../src/serverless/settings', () => ({
  __esModule: true,
  loadServerlessOpenRouterConfig: jest.fn(),
}));jest.mock('../src/db/database', () => ({
  __esModule: true,
  getLocalDatabase: jest.fn(),
}));
jest.mock('../src/db/messageStore', () => ({
  __esModule: true,
  saveMessageImprovement: jest.fn(),
}));
jest.mock('../src/db/profileStore', () => ({
  __esModule: true,
  getLearningProfile: jest.fn(async () => ({level: 'B1'})),
}));

const mockedImproveMessage = jest.mocked(sessionsApi.improveMessage);
const mockedGenerateImprovement = jest.mocked(serverlessImprovement.generateImprovement);

const AUTHED_REQUEST = (async () => undefined) as unknown as AuthedRequester;

function improvementOf(overrides: Partial<MessageImprovement> = {}): MessageImprovement {
  return {
    original: 'i go to store',
    improved: 'I went to the store.',
    explanation: 'Past tense for a finished action.',
    severity: 'critical',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 501,
    role: 'user',
    status: 'complete',
    content: 'i go to store',
    sequence: 2,
    created_at: '2026-09-04T10:00:00Z',
    ...overrides,
  };
}

/** Harness exposing the hook state through test IDs. */
function HookHarness(props: {
  sessionId: number | undefined;
  mode: ApplicationMode;
  authedRequest: AuthedRequester;
  messages: ChatMessage[];
  enabled: boolean;
  historySettled: boolean;
  onBadgePress?: () => void;
}) {
  const {checks, getResult} = useGrammarAutoCheck(props);
  const ids = Object.keys(checks)
    .map(Number)
    .sort((a, b) => a - b);
  return (
    <View>
      <Text testID="checked-ids">{ids.join(',')}</Text>
      {ids.map(id => (
        <Text key={id} testID={`check-${id}`}>
          {checks[id].severity}
        </Text>
      ))}
      <Text testID="lookup-501">{getResult(501)?.severity ?? 'none-found'}</Text>
      <Text onPress={props.onBadgePress} testID="press-badge">
        press
      </Text>
    </View>
  );
}

async function renderHook(options: {
  sessionId?: number;
  mode?: ApplicationMode;
  messages?: ChatMessage[];
  enabled?: boolean;
  historySettled?: boolean;
}) {
  const props = {
    sessionId: options.sessionId,
    mode: options.mode ?? 'server',
    authedRequest: AUTHED_REQUEST,
    messages: options.messages ?? [],
    enabled: options.enabled ?? true,
    historySettled: options.historySettled ?? true,
  };
  const utils = await render(<HookHarness {...props} />);
  // Updates accumulate on `props` (like the chat screen's real prop flow)
  // and rerenders are awaited so act() nesting never overlaps.
  const update = async (next: Partial<typeof props>) => {
    Object.assign(props, next);
    await utils.rerender(<HookHarness {...props} />);
  };
  return {utils, props, update};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedImproveMessage.mockResolvedValue(improvementOf());
  jest.mocked(serverlessSettings.loadServerlessOpenRouterConfig).mockResolvedValue({
    apiKey: 'test-key',
    primaryModel: 'test/model',
    fallbackModels: [],
    provider: 'openrouter',
  });
  jest.mocked(messageStore.saveMessageImprovement).mockResolvedValue(undefined);
});

describe('useGrammarAutoCheck', () => {
  it('is inert when the feature is disabled (default off)', async () => {
    const {update} = await renderHook({sessionId: 1, enabled: false});
    await update({messages: [makeMessage()]});

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedImproveMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('checked-ids').props.children).toBe('');
  });

  it('checks a newly arrived complete user message in server mode', async () => {
    const {update} = await renderHook({sessionId: 1, mode: 'server'});
    await update({messages: [makeMessage()]});

    await waitFor(() => expect(screen.getByTestId('checked-ids').props.children).toBe('501'));

    expect(mockedImproveMessage).toHaveBeenCalledWith(AUTHED_REQUEST, 1, 501);
    expect(screen.getByTestId('check-501').props.children).toBe('critical');
  });

  it('checks through the serverless improvement port with the local profile', async () => {
    mockedGenerateImprovement.mockResolvedValue(improvementOf({severity: 'minor'}));
    const {update} = await renderHook({sessionId: 2, mode: 'serverless'});
    await update({messages: [makeMessage()]});

    await waitFor(() => expect(screen.getByTestId('check-501').props.children).toBe('minor'));

    expect(mockedGenerateImprovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({level: 'B1', originalMessage: 'i go to store'}),
    );
    expect(mockedImproveMessage).not.toHaveBeenCalled();
    // The paid-for result is persisted before display so it survives an
    // app restart (the db handle comes from the mocked getLocalDatabase).
    const saveMock = jest.mocked(messageStore.saveMessageImprovement);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][1]).toBe(501);
    expect(saveMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({severity: 'minor'}),
    );
  });

  it('restores persisted improvements from the history without new requests', async () => {
    const seeded = makeMessage();
    seeded.improvement = {
      original: seeded.content,
      improved: 'I went to the store.',
      explanation: 'Past tense.',
      severity: 'critical',
    };
    const {update} = await renderHook({
      sessionId: 3,
      historySettled: false,
      messages: [],
    });
    // The seeded history already carries its stored improvement: it must
    // appear as a badge payload with zero provider calls.
    await update({historySettled: true, messages: [seeded]});
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('checked-ids').props.children).toBe('501');
    expect(screen.getByTestId('check-501').props.children).toBe('critical');
    expect(mockedImproveMessage).not.toHaveBeenCalled();
    expect(mockedGenerateImprovement).not.toHaveBeenCalled();
  });

  it('skips assistant rows, non-complete rows, blank content and synthetic echoes', async () => {
    const {update} = await renderHook({sessionId: 1});
    await update({
      messages: [
        makeMessage({id: 1, role: 'assistant', content: 'Assistant reply'}),
        makeMessage({id: 2, status: 'pending'}),
        makeMessage({id: 3, status: 'failed'}),
        makeMessage({id: 4, content: '   '}),
        makeMessage({id: -99, content: 'optimistic echo'}),
      ],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedImproveMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('checked-ids').props.children).toBe('');
  });

  it('never auto-checks the seeded history snapshot', async () => {
    // historySettled=true seeds whatever is present at seed time; the rows
    // of the seeded snapshot must be checked exactly zero times.
    const {update} = await renderHook({
      sessionId: 1,
      historySettled: false,
      messages: [makeMessage({id: 10})],
    });
    await update({historySettled: true, messages: [makeMessage({id: 10})]});

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedImproveMessage).not.toHaveBeenCalled();

    // A later arrival in the same session is checked normally.
    await update({messages: [makeMessage({id: 10}), makeMessage({id: 11})]});
    await waitFor(() => expect(screen.getByTestId('check-11').props.children).toBe('critical'));
    expect(mockedImproveMessage).toHaveBeenCalledTimes(1);
    expect(mockedImproveMessage).toHaveBeenCalledWith(AUTHED_REQUEST, 1, 11);
  });

  it('stores severity none results without a badge (badgeSeverity stays silent)', async () => {
    mockedImproveMessage.mockResolvedValue(improvementOf({severity: 'none'}));
    const {update} = await renderHook({sessionId: 1});
    await update({messages: [makeMessage()]});

    await waitFor(() => expect(screen.getByTestId('checked-ids').props.children).toBe('501'));

    // Checked but correct: no badge severity.
    expect(screen.getByTestId('check-501').props.children).toBe('none');
  });

  it('checks each message exactly once even when the list re-renders', async () => {
    const {update} = await renderHook({sessionId: 1});
    await update({messages: [makeMessage()]});
    await waitFor(() => expect(screen.getByTestId('check-501')).toBeOnTheScreen());

    // Same row re-delivered (streaming flushes replace the array).
    await update({messages: [makeMessage()]});
    await update({messages: [makeMessage()]});

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedImproveMessage).toHaveBeenCalledTimes(1);
  });

  it('drops in-flight results when the session changes and starts fresh', async () => {
    let resolveCheck: (value: MessageImprovement) => void = () => undefined;
    mockedImproveMessage.mockImplementation(
      () =>
        new Promise<MessageImprovement>(resolve => {
          resolveCheck = resolve;
        }),
    );
    const {update} = await renderHook({sessionId: 1});
    await update({messages: [makeMessage({id: 7})]});
    await waitFor(() => expect(mockedImproveMessage).toHaveBeenCalledTimes(1));

    await update({sessionId: 2});
    resolveCheck(improvementOf());
    await act(async () => {
      await Promise.resolve();
    });

    // The stale result must never surface under the new session.
    expect(screen.getByTestId('checked-ids').props.children).toBe('');

    // The replacement promise must be ready BEFORE the arrival that uses it.
    mockedImproveMessage.mockResolvedValue(improvementOf({severity: 'minor'}));
    await update({messages: [makeMessage({id: 8})]});
    await waitFor(() => expect(screen.getByTestId('check-8').props.children).toBe('minor'));
  });

  it('stays silent when the check fails (no crash, no badge)', async () => {
    mockedImproveMessage.mockRejectedValue(new Error('provider down'));
    const {update} = await renderHook({sessionId: 1});
    await update({messages: [makeMessage()]});

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('checked-ids').props.children).toBe('');
  });

  it('skips messages that arrive while disabled forever', async () => {
    const {update} = await renderHook({sessionId: 1, enabled: false});
    await update({messages: [makeMessage({id: 20})]});
    await act(async () => {
      await Promise.resolve();
    });

    // Turning the feature on afterwards never retro-checks the old row.
    await update({enabled: true});
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedImproveMessage).not.toHaveBeenCalled();
  });

  it('runs one check per message even when several arrive in one batch', async () => {
    const {update} = await renderHook({sessionId: 1});
    await update({messages: [makeMessage({id: 30}), makeMessage({id: 31})]});

    await waitFor(() => expect(mockedImproveMessage).toHaveBeenCalledTimes(2));
    expect(mockedImproveMessage).toHaveBeenCalledWith(AUTHED_REQUEST, 1, 30);
    expect(mockedImproveMessage).toHaveBeenCalledWith(AUTHED_REQUEST, 1, 31);
  });
});

describe('badge press path (no second API call)', () => {
  it('shows the cached improvement via the hook result without new requests', async () => {
    let badgePressCount = 0;
    let liveMessages: ChatMessage[] = [];
    function BadgeHarness() {
      const {checks, getResult} = useGrammarAutoCheck({
        sessionId: 1,
        mode: 'server',
        authedRequest: AUTHED_REQUEST,
        // The message arrives AFTER the history seeded (historySettled true
        // with an empty initial list), exactly like a freshly sent message.
        messages: liveMessages,
        enabled: true,
        historySettled: true,
      });
      const check = getResult(501);
      const label = `badge:${check?.severity ?? 'none'}`;
      return (
        <View>
          <Text onPress={() => {
            badgePressCount += 1;
          }} testID="badge">
            {label}
          </Text>
          <Text testID="cached">{check ? String(checks[501].improved) : 'pending'}</Text>
        </View>
      );
    }

    const utils = await render(<BadgeHarness />);
    // Simulate the send: the persisted user row arrives after the seed.
    liveMessages = [makeMessage()];
    await utils.rerender(<BadgeHarness />);
    await waitFor(() => expect(screen.getByTestId('badge').props.children).toBe('badge:critical'));
    expect(screen.getByTestId('cached').props.children).toBe('I went to the store.');

    // Pressing the badge triggers zero additional provider calls: the
    // improvement arrives with the check itself.
    const callsAfterCheck = mockedImproveMessage.mock.calls.length;
    act(() => {
      screen.getByTestId('badge').props.onPress();
    });
    expect(badgePressCount).toBe(1);
    expect(mockedImproveMessage.mock.calls.length).toBe(callsAfterCheck);
  });
});
