import React from 'react';
import {render, screen} from '@testing-library/react-native';
import type {TestInstance} from 'test-renderer';

import type {ChatMessage} from '../src/api/sessions';
import {MessageRow, createRowStyles} from '../src/screens/MessageRow';
import {lightColors} from '../src/theme/colors';

const styles = createRowStyles(lightColors);

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 101,
    role: 'assistant',
    status: 'complete',
    content: 'Hello!',
    sequence: 1,
    created_at: '2026-08-26T10:00:00Z',
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

function parentOf(element: TestInstance): TestInstance {
  const parent = element.parent;
  if (!parent) {
    throw new Error('Expected the element to have a parent');
  }
  return parent;
}

async function renderRow(overrides: Partial<ChatMessage> = {}) {
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
    />,
  );
  return screen.getByTestId(`chat-message-${item.id}`);
}

describe('MessageRow layout (TASK-AUDIT-009)', () => {
  it('caps bubble width on the wrapper whose parent row has definite width', async () => {
    const bubble = await renderRow();

    const wrapperStyle = flattenStyle(parentOf(bubble).props.style);
    expect(wrapperStyle).toMatchObject({maxWidth: '85%', flexShrink: 1});

    const rowStyle = flattenStyle(parentOf(parentOf(bubble)).props.style);
    expect(rowStyle).toMatchObject({flexDirection: 'row'});

    const bubbleStyle = flattenStyle(bubble.props.style);
    expect(bubbleStyle).not.toHaveProperty('maxWidth');
    expect(bubbleStyle).toMatchObject({
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
    });
  });

  it('aligns user messages toward the right edge', async () => {
    const bubble = await renderRow({role: 'user'});

    const rowStyle = flattenStyle(parentOf(parentOf(bubble)).props.style);
    expect(rowStyle).toMatchObject({
      flexDirection: 'row',
      justifyContent: 'flex-end',
    });

    const wrapperStyle = flattenStyle(parentOf(bubble).props.style);
    expect(wrapperStyle).toMatchObject({maxWidth: '85%'});

    expect(flattenStyle(bubble.props.style)).toMatchObject({
      backgroundColor: lightColors.primary,
    });
  });

  it('keeps assistant messages aligned toward the left', async () => {
    const bubble = await renderRow({role: 'assistant'});

    const rowStyle = flattenStyle(parentOf(parentOf(bubble)).props.style);
    expect(rowStyle.flexDirection).toBe('row');
    expect(rowStyle).not.toHaveProperty('justifyContent', 'flex-end');

    expect(flattenStyle(bubble.props.style)).toMatchObject({
      backgroundColor: lightColors.surface,
    });
  });

  it('leaves text wrapping enabled for short and long messages', async () => {
    await renderRow({content: 'Hello!'});

    const text = screen.getByText('Hello!');
    expect(text.props.numberOfLines).toBeUndefined();

    const textStyle = flattenStyle(text.props.style);
    expect(textStyle).toMatchObject({fontSize: 15, lineHeight: 21});
    expect(textStyle).not.toHaveProperty('width');
    expect(textStyle).not.toHaveProperty('maxWidth');
  });

  it('renders long message content inside the capped wrapper', async () => {
    const longContent =
      'This is a substantially longer message that must wrap across several lines while the bubble keeps a bounded width and never overflows the screen edges. '.repeat(3);
    const bubble = await renderRow({content: longContent});

    expect(screen.getByText(longContent)).toBeOnTheScreen();

    const wrapperStyle = flattenStyle(parentOf(bubble).props.style);
    expect(wrapperStyle).toMatchObject({maxWidth: '85%', flexShrink: 1});
  });
});
