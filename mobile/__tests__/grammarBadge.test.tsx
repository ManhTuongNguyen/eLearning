/**
 * Grammar badge rendering on the message row.
 *
 * Covers the badge contract end to end: only user messages carry a corner
 * status mark, severity "none" renders a check, "minor" a "!" and "critical"
 * a "✕", in warning and error colors, unchecked messages render nothing, the mark
 * and a tap anywhere on a checked bubble open the cached improvement
 * (never a new API call — the handler receives the message), and the
 * bubble text is untouched.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';

import type { ChatMessage, ImprovementSeverity } from '../src/api/sessions';
import { createRowStyles, MessageRow } from '../src/screens/MessageRow';
import { lightColors } from '../src/theme/colors';

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
  return Object.assign({}, ...entries.filter(Boolean).map(s => (typeof s === 'object' ? s : {})));
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

  it('renders a success-styled check mark when the message was already correct (none)', async () => {
    await renderRow({}, 'none');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(badge.props.accessibilityLabel).toBe('Looks good, open feedback');
    expect(screen.getByText('✓')).toBeOnTheScreen();
    expect(flattenStyle(badge.props.style)).toMatchObject({ borderColor: lightColors.success });
  });

  it('renders a warning-styled "!" mark for minor severity', async () => {
    await renderRow({}, 'minor');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(badge.props.accessibilityLabel).toBe('Minor grammar issues found, open suggestion');
    expect(screen.getByText('!')).toBeOnTheScreen();
    expect(flattenStyle(badge.props.style)).toMatchObject({ borderColor: lightColors.warning });
  });

  it('renders an error-styled "✕" mark for critical severity', async () => {
    await renderRow({}, 'critical');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(badge.props.accessibilityLabel).toBe('Serious grammar issues found, open suggestion');
    expect(screen.getByText('✕')).toBeOnTheScreen();
    expect(screen.queryByText('!')).toBeNull();
    expect(flattenStyle(badge.props.style)).toMatchObject({ borderColor: lightColors.errorText });
  });

  it('keeps the corner mark small and absolutely positioned', async () => {
    await renderRow({}, 'minor');

    const badge = screen.getByTestId('chat-grammar-badge-101');
    expect(flattenStyle(badge.props.style)).toMatchObject({
      position: 'absolute',
      width: 16,
      height: 16,
    });
    // 16px visible mark + 14px slop each side ≈ 44px touch target.
    expect(badge.props.hitSlop).toBe(14);
  });

  it('never renders a badge on assistant rows', async () => {
    await renderRow({ role: 'assistant', content: 'Assistant says hi' }, 'critical');

    expect(screen.queryByTestId('chat-grammar-badge-101')).toBeNull();
  });

  it('pressing the badge hands the message to the cached-improvement handler', async () => {
    const onPress = jest.fn();
    const item = await renderRow({}, 'critical', onPress);

    fireEvent.press(screen.getByTestId('chat-grammar-badge-101'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(item);
  });

  it('opens the cached improvement when the whole bubble is tapped, for any checked severity', async () => {
    const onPress = jest.fn();
    const item = await renderRow({}, 'minor', onPress);

    fireEvent.press(screen.getByTestId('chat-message-101'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(item);
    expect(screen.getByTestId('chat-message-101').props.accessibilityHint).toBe(
      'Opens the improvement suggestion',
    );
  });

  it('keeps an unchecked bubble non-tappable for the feedback sheet', async () => {
    const onPress = jest.fn();
    await renderRow({}, null, onPress);

    fireEvent.press(screen.getByTestId('chat-message-101'));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-message-101').props.accessibilityHint).toBeUndefined();
  });

  it('keeps the message text verbatim next to the badge', async () => {
    await renderRow({}, 'minor');

    expect(screen.getByText('i has went to store')).toBeOnTheScreen();
  });
});
