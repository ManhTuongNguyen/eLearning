/**
 * Vocabulary save popup tests (SPEC TASK-070): the expression preview,
 * Save firing the save callback, the loading state replacing the action
 * row, the role="alert" failure message with Save still available for
 * retry, and every dismissal path (Cancel, Close, backdrop, Android back)
 * leaving the save untouched.
 */
import React from 'react';
import {act, fireEvent, render, screen} from '@testing-library/react-native';

import {VocabularySaveSheet} from '../src/screens/VocabularySaveSheet';
import {ThemeProvider} from '../src/theme/ThemeContext';

const EXPRESSION = 'the early bird';

interface SheetOverrides {
  visible?: boolean;
  expression?: string;
  loading?: boolean;
  error?: string | null;
  onClose?: () => void;
  onSave?: () => void;
}

async function renderSheet(overrides: SheetOverrides = {}) {
  return render(
    <ThemeProvider>
      <VocabularySaveSheet
        visible={overrides.visible ?? true}
        expression={overrides.expression ?? EXPRESSION}
        loading={overrides.loading ?? false}
        error={overrides.error ?? null}
        onClose={overrides.onClose ?? (() => undefined)}
        onSave={overrides.onSave ?? (() => undefined)}
      />
    </ThemeProvider>,
  );
}

describe('VocabularySaveSheet', () => {
  it('renders nothing while closed', async () => {
    await renderSheet({visible: false});

    expect(screen.queryByTestId('chat-vocab-modal')).toBeNull();
    expect(screen.queryByTestId('chat-vocab')).toBeNull();
  });

  it('previews exactly the expression that will be saved', async () => {
    await renderSheet();

    expect(screen.getByTestId('chat-vocab-expression')).toHaveTextContent(
      EXPRESSION,
    );
    // Both required actions are present.
    expect(screen.getByTestId('chat-vocab-save')).toBeOnTheScreen();
    expect(screen.getByTestId('chat-vocab-cancel')).toBeOnTheScreen();
    expect(screen.queryByTestId('chat-vocab-error')).toBeNull();
  });

  it('Save fires the save callback once', async () => {
    const onSave = jest.fn();
    await renderSheet({onSave});

    await fireEvent.press(screen.getByTestId('chat-vocab-save'));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner instead of the actions while saving', async () => {
    await renderSheet({loading: true});

    expect(screen.getByTestId('chat-vocab-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('chat-vocab-save')).toBeNull();
    expect(screen.queryByTestId('chat-vocab-cancel')).toBeNull();
  });

  it('shows a failure alert above the still-available Save control', async () => {
    const onSave = jest.fn();
    await renderSheet({error: 'Could not reach the server.', onSave});

    expect(screen.getByTestId('chat-vocab-error')).toHaveTextContent(
      'Could not reach the server.',
    );
    expect(screen.getByTestId('chat-vocab-error').props.role).toBe('alert');
    expect(screen.getByTestId('chat-vocab-save')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('chat-vocab-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it('dismisses through Cancel, Close, backdrop tap and Android back without saving', async () => {
    const onClose = jest.fn();
    const onSave = jest.fn();
    await renderSheet({onClose, onSave});

    await fireEvent.press(screen.getByTestId('chat-vocab-cancel'));
    await fireEvent.press(screen.getByTestId('chat-vocab-close'));
    await fireEvent.press(screen.getByTestId('chat-vocab-backdrop'));
    await act(async () => {
      screen.getByTestId('chat-vocab-modal').props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(4);
    expect(onSave).not.toHaveBeenCalled();
  });
});
