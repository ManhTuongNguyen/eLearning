/**
 * Message actions menu tests (SPEC TASK-060): role-driven action matrix
 * (user rows gain Improve my English; assistant rows do not), dismissal
 * through the Close control, backdrop tap and Android back, and the
 * accessibility surface (labeled buttons per action, accessibility modal
 * container).
 */
import React from 'react';
import {act, fireEvent, render, screen, within} from '@testing-library/react-native';

import {MessageActionsMenu} from '../src/screens/MessageActionsMenu';
import type {MessageAction} from '../src/screens/MessageActionsMenu';
import {ThemeProvider} from '../src/theme/ThemeContext';

interface MenuOverrides {
  visible?: boolean;
  role?: 'user' | 'assistant';
  onClose?: () => void;
  onSelect?: (action: MessageAction) => void;
}

async function renderMenu(overrides: MenuOverrides = {}) {
  return render(
    <ThemeProvider>
      <MessageActionsMenu
        visible={overrides.visible ?? true}
        role={overrides.role ?? 'assistant'}
        onClose={overrides.onClose ?? (() => undefined)}
        onSelect={overrides.onSelect ?? (() => undefined)}
      />
    </ThemeProvider>,
  );
}

function visibleActionLabels(): string[] {
  return screen
    .getAllByTestId(/^chat-menu-/)
    .filter(
      element =>
        /^chat-menu-(suggest-replies|improve-english|copy|speak)$/.test(
          element.props.testID as string,
        ),
    )
    .map(element => element.props.accessibilityLabel as string);
}

describe('MessageActionsMenu', () => {
  it('renders nothing while closed', async () => {
    await renderMenu({visible: false});

    expect(screen.queryByTestId('chat-menu-modal')).toBeNull();
    expect(screen.queryByTestId('chat-menu')).toBeNull();
  });

  it('shows assistant-message actions without the improvement entry', async () => {
    await renderMenu({role: 'assistant'});

    expect(visibleActionLabels()).toEqual(['Suggest replies', 'Copy', 'Read aloud']);
  });

  it('shows user-message actions including Improve my English', async () => {
    await renderMenu({role: 'user'});

    expect(visibleActionLabels()).toEqual([
      'Suggest replies',
      'Improve my English',
      'Copy',
      'Read aloud',
    ]);
  });

  it('exposes every action as a labeled button inside an accessibility modal', async () => {
    await renderMenu({role: 'user'});

    for (const testId of [
      'chat-menu-suggest-replies',
      'chat-menu-improve-english',
      'chat-menu-copy',
      'chat-menu-speak',
    ]) {
      const item = screen.getByTestId(testId);
      expect(item.props.accessibilityRole).toBe('button');
      expect(item.props.accessibilityLabel).toBeTruthy();
    }
    expect(screen.getByTestId('chat-menu-close').props.accessibilityRole).toBe('button');
    expect(screen.getByTestId('chat-menu-content').props.accessibilityViewIsModal).toBe(
      true,
    );
  });

  it('reports the selected action to the parent', async () => {
    const onSelect = jest.fn();
    await renderMenu({role: 'user', onSelect});

    await fireEvent.press(screen.getByTestId('chat-menu-copy'));
    await fireEvent.press(screen.getByTestId('chat-menu-improve-english'));

    expect(onSelect).toHaveBeenNthCalledWith(1, 'copy');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'improve-english');
  });

  it('dismisses through the Close control and the backdrop tap', async () => {
    const onClose = jest.fn();
    await renderMenu({onClose});

    await fireEvent.press(screen.getByTestId('chat-menu-backdrop'));
    await fireEvent.press(screen.getByTestId('chat-menu-close'));

    // The sheet itself is not a dismissal surface; only its backdrop and
    // Close are. Two presses → exactly two close calls.
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('dismisses through the Android back button', async () => {
    const onClose = jest.fn();
    await renderMenu({onClose});

    const modal = screen.getByTestId('chat-menu-modal');
    await act(async () => {
      modal.props.onRequestClose();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps every action inside the sheet when open', async () => {
    await renderMenu({role: 'assistant'});

    const sheet = screen.getByTestId('chat-menu');
    expect(within(sheet).getByText('Suggest replies')).toBeOnTheScreen();
    expect(within(sheet).getByText('Copy')).toBeOnTheScreen();
    expect(within(sheet).getByText('Read aloud')).toBeOnTheScreen();
  });
});
