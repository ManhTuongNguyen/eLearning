/**
 * Grammar badge rendering on the message row.
 *
 * Covers the badge contract end to end: only user messages carry a badge,
 * severity "minor" renders the warning-styled badge and "critical" the
 * error-styled one, "none"/unchecked render nothing, the badge is
 * pressable through the cached-improvement handler (never a new API call
 * — the handler receives the message) and the bubble text is untouched.
 */
import React from 'react';
import {render, screen, fireEvent} from '@testing-library/react-native';

import type {ChatMessage, ImprovementSeverity} from '../src/api/sessions';
import {MessageRow, createRowStyles} from '../src/screens/MessageRow';
import {lightColors} from '../src/theme/colors';

const styles = createRowStyles(lightColors);

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 101,
    role: 'user',
    status: 'complete',
    content: 'i has went to store',
    sequence: 1,
    created_at: '2026-09-04T10:00:00Z',
    ...overrides,
  };
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const entries = Array.isArray(style) ? style : [style];
  return Object.assign(
    {},
    ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})),
  );
}

async function renderRow(
  overrides: Partial<ChatMessage> = {},
  grammarSeverity: ImprovementSeverity | null = null,
  onPress: (message: ChatMessage) => void = jest.fn(),
) {
  const item = makeMessage(overrides);
  await render(
    <MessageRow
      item={item}
      styles={styles}
      streaming={false}
      speaking={false}
      spinnerColor={lightColors.textMuted}
      onMessageLongPress={jest.fn()}
      onRetry={jest.fn()}
      onStopSpeech={jest.fn()}
      grammarSeverity={grammarSeverity}
      onGrammarBadgePress={onPress}
    />,
  );
  return item;
}

describe('MessageRow grammar badge', () => {
  it('renders no badge for unchecked messages', async () => {
    await renderRow({}, null);
    expect(screen.queryByTestId('chat-grammar-badge-101')).toBeNull();
  });

  it('renders no badge when the message was already correct (none)', async () => {
    await renderRow({}, 'none');
    expect(screen.queryByTestId('chat-grammar-badge-101')).toBeNull();
  });

  it('renders a warning-styled badge for minor severity', async () => {
    await renderRow({}, 'minor');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(screen.getByText('Minor issues')).toBeOnTheScreen();

    const badgeStyle = flattenStyle(badge.props.style);
    expect(badgeStyle).toMatchObject({borderColor: lightColors.warning});
  });

  it('renders an error-styled badge for critical severity', async () => {
    await renderRow({}, 'critical');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(screen.getByText('Grammar issues')).toBeOnTheScreen();

    const badgeStyle = flattenStyle(badge.props.style);
    expect(badgeStyle).toMatchObject({borderColor: lightColors.errorText});
  });

  it('never renders a badge on assistant rows', async () => {
    await renderRow({role: 'assistant', content: 'Assistant says hi'}, 'critical');

    expect(screen.queryByTestId('chat-grammar-badge-101')).toBeNull();
  });

  it('pressing the badge hands the message to the cached-improvement handler', async () => {
    const onPress = jest.fn();
    const item = await renderRow({}, 'critical', onPress);

    fireEvent.press(screen.getByTestId('chat-grammar-badge-101'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(item);
  });

  it('keeps the message text verbatim next to the badge', async () => {
    await renderRow({}, 'minor');

    expect(screen.getByText('i has went to store')).toBeOnTheScreen();
  });
});
