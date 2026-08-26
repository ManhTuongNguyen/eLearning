/**
 * Text selection sheet tests (SPEC TASK-069): the pinned message content,
 * live selection preview for single words, phrases and multi-word
 * expressions, trimming of dragged whitespace edges, the disabled Save
 * control until something savable is selected, immovability of the pinned
 * text against edit attempts, dismissal paths (Cancel, Close, backdrop,
 * Android back) that never capture, and clean state on reopening.
 */
import React from 'react';
import {act, fireEvent, render, screen} from '@testing-library/react-native';

import {TextSelectionSheet} from '../src/screens/TextSelectionSheet';
import {ThemeProvider} from '../src/theme/ThemeContext';

const MESSAGE = 'The early bird catches the worm.';

interface SheetOverrides {
  visible?: boolean;
  content?: string;
  onClose?: () => void;
  onSave?: (selectedText: string) => void;
}

async function renderSheet(overrides: SheetOverrides = {}) {
  return render(
    <ThemeProvider>
      <TextSelectionSheet
        visible={overrides.visible ?? true}
        content={overrides.content ?? MESSAGE}
        onClose={overrides.onClose ?? (() => undefined)}
        onSave={overrides.onSave ?? (() => undefined)}
      />
    </ThemeProvider>,
  );
}

/** Simulate a native selection span over the pinned input. */
async function selectRange(start: number, end: number): Promise<void> {
  const input = screen.getByTestId('chat-selection-input');
  await fireEvent(input, 'selectionChange', {
    nativeEvent: {selection: {start, end}},
  });
}

describe('TextSelectionSheet', () => {
  it('renders nothing while closed', async () => {
    await renderSheet({visible: false});

    expect(screen.queryByTestId('chat-selection-modal')).toBeNull();
    expect(screen.queryByTestId('chat-selection')).toBeNull();
  });

  it('shows the full message content for selection with nothing captured yet', async () => {
    await renderSheet();

    const input = screen.getByTestId('chat-selection-input');
    expect(input.props.value).toBe(MESSAGE);
    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'Nothing selected yet.',
    );
    expect(
      (screen.getByTestId('chat-selection-save').props.accessibilityState ?? {})
        .disabled,
    ).toBe(true);
  });

  it('previews and saves a single selected word exactly', async () => {
    const onSave = jest.fn();
    await renderSheet({onSave});
    // "The early bird…" — "early" spans indices 4–9.
    await selectRange(4, 9);

    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'early',
    );
    expect(
      (screen.getByTestId('chat-selection-save').props.accessibilityState ?? {})
        .disabled,
    ).toBe(false);

    await fireEvent.press(screen.getByTestId('chat-selection-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('early');
  });

  it('trims whitespace dragged into a multi-word phrase selection', async () => {
    const onSave = jest.fn();
    await renderSheet({onSave});
    // A sloppy drag from the space before "early" through "bird".
    await selectRange(3, 14);

    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'early bird',
    );

    await fireEvent.press(screen.getByTestId('chat-selection-save'));

    expect(onSave).toHaveBeenCalledWith('early bird');
  });

  it('captures multi-line expressions spanning newlines', async () => {
    const onSave = jest.fn();
    const content = 'Line one.\nA second sentence follows.';
    await renderSheet({content, onSave});

    // "Line o|ne.\nA second| sentence…" — a drag across the line break.
    const expression = 'ne.\nA second';
    const start = content.indexOf(expression);
    await selectRange(start, start + expression.length);
    await fireEvent.press(screen.getByTestId('chat-selection-save'));

    expect(onSave).toHaveBeenCalledWith(expression);
  });

  it('keeps Save disabled for collapsed and whitespace-only selections', async () => {
    const onSave = jest.fn();
    await renderSheet({onSave});

    // Collapsed caret between words.
    await selectRange(9, 9);
    expect(
      (screen.getByTestId('chat-selection-save').props.accessibilityState ?? {})
        .disabled,
    ).toBe(true);

    // Only blanks and a newline were swept over.
    await selectRange(3, 4);
    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'Nothing selected yet.',
    );
    expect(
      (screen.getByTestId('chat-selection-save').props.accessibilityState ?? {})
        .disabled,
    ).toBe(true);

    await fireEvent.press(screen.getByTestId('chat-selection-save'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the pinned content unchanged against edit attempts', async () => {
    await renderSheet();

    const input = screen.getByTestId('chat-selection-input');
    await fireEvent.changeText(input, 'Tampered text');

    expect(input.props.value).toBe(MESSAGE);
  });

  it('dismisses through Cancel, Close, backdrop tap and Android back without saving', async () => {
    const onClose = jest.fn();
    const onSave = jest.fn();
    await renderSheet({onClose, onSave});
    await selectRange(4, 9);

    await fireEvent.press(screen.getByTestId('chat-selection-cancel'));
    await fireEvent.press(screen.getByTestId('chat-selection-close'));
    await fireEvent.press(screen.getByTestId('chat-selection-backdrop'));
    await act(async () => {
      screen.getByTestId('chat-selection-modal').props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(4);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('starts clean when reopened after a previous capture attempt', async () => {
    const sheet = (visible: boolean) => (
      <ThemeProvider>
        <TextSelectionSheet
          visible={visible}
          content={MESSAGE}
          onClose={() => undefined}
          onSave={() => undefined}
        />
      </ThemeProvider>
    );
    const utils = await render(sheet(true));
    await selectRange(4, 9);
    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'early',
    );

    // Closing unmounts the surface; reopening mounts a fresh one with no
    // inherited selection.
    await act(async () => {
      utils.rerender(sheet(false));
    });
    await act(async () => {
      utils.rerender(sheet(true));
    });

    expect(screen.getByTestId('chat-selection-preview')).toHaveTextContent(
      'Nothing selected yet.',
    );
  });
});
