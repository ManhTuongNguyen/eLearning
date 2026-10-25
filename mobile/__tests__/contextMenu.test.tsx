/**
 * Context menu tests.
 *
 * `computeContextMenuPosition` is the interesting half: the popover must hang
 * off the trigger's press point, flip up when the list ends near the screen
 * bottom, and never leave the screen. The render half pins the item contract
 * (icon, label, detail, danger) and the backdrop-dismiss behaviour.
 */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  ContextMenu,
  type ContextMenuItem,
  computeContextMenuPosition,
} from '../src/components/ContextMenu';
import { ThemeProvider } from '../src/theme/ThemeContext';

const ITEMS: readonly ContextMenuItem[] = [
  { key: 'edit', label: 'Edit topic', icon: 'edit', onPress: jest.fn() },
  {
    key: 'learn-ahead',
    label: 'Learn ahead limit',
    icon: 'settings',
    detail: '10 min',
    onPress: jest.fn(),
  },
  { key: 'delete', label: 'Delete topic', icon: 'trash', danger: true, onPress: jest.fn() },
];

describe('computeContextMenuPosition', () => {
  const WIDTH = 390;
  const HEIGHT = 844;

  it('opens below the press point, right-aligned with it', () => {
    const position = computeContextMenuPosition({ x: 370, y: 200 }, 3, WIDTH, HEIGHT);
    expect(position.top).toBe(212);
    expect(position.left).toBe(WIDTH - 208 - 8); // clamped to the right margin
  });

  it('flips above the anchor when there is no room below', () => {
    // 3 items ≈ 156pt tall; a press 40pt above the bottom cannot fit below.
    const below = computeContextMenuPosition({ x: 370, y: HEIGHT - 40 }, 3, WIDTH, HEIGHT);
    expect(below.top).toBeLessThan(HEIGHT - 40);
    expect(below.top).toBeGreaterThanOrEqual(8);

    // With room below, the same anchor opens downward.
    const downward = computeContextMenuPosition({ x: 370, y: 200 }, 3, WIDTH, HEIGHT);
    expect(downward.top).toBeGreaterThan(200);
  });

  it('clamps to the left margin when the press point is near the left edge', () => {
    const position = computeContextMenuPosition({ x: 10, y: 300 }, 3, WIDTH, HEIGHT);
    expect(position.left).toBe(8);
  });

  it('falls back to the top-right when the anchor carries no coordinates', () => {
    const fallback = computeContextMenuPosition(null, 1, WIDTH, HEIGHT);
    expect(fallback).toEqual(
      computeContextMenuPosition({ x: WIDTH - 32, y: 96 }, 1, WIDTH, HEIGHT),
    );

    const nonFinite = computeContextMenuPosition(
      { x: Number.NaN, y: Number.NaN },
      1,
      WIDTH,
      HEIGHT,
    );
    expect(nonFinite).toEqual(fallback);
  });
});

describe('ContextMenu', () => {
  function renderMenu(props: Partial<Parameters<typeof ContextMenu>[0]> = {}) {
    return render(
      <ThemeProvider>
        <ContextMenu
          visible
          anchor={{ x: 300, y: 400 }}
          items={ITEMS}
          onCancel={jest.fn()}
          testID="probe-menu"
          {...props}
        />
      </ThemeProvider>,
    );
  }

  it('renders nothing while hidden', async () => {
    const view = await renderMenu({ visible: false });
    expect(view.queryByTestId('probe-menu')).toBeFalsy();
    await view.unmount();
  });

  it('renders every item with its label, detail and danger colouring', async () => {
    const view = await renderMenu();

    expect(view.getByTestId('probe-menu-sheet')).toBeTruthy();
    expect(view.getByTestId('probe-menu-edit')).toHaveTextContent('Edit topic');
    expect(view.getByTestId('probe-menu-learn-ahead')).toHaveTextContent('Learn ahead limit10 min');
    expect(view.getByTestId('probe-menu-delete')).toHaveTextContent('Delete topic');

    await view.unmount();
  });

  it('draws a divider between rows but none around the first and last', async () => {
    const view = await renderMenu();

    expect(view.getByTestId('probe-menu-divider-learn-ahead')).toBeTruthy();
    expect(view.getByTestId('probe-menu-divider-delete')).toBeTruthy();
    expect(view.queryByTestId('probe-menu-divider-edit')).toBeFalsy();

    await view.unmount();
  });

  it('fires the item action and the backdrop cancels without acting', async () => {
    const onCancel = jest.fn();
    const view = await renderMenu({ onCancel });

    fireEvent.press(view.getByTestId('probe-menu-edit'));
    expect(ITEMS[0].onPress).toHaveBeenCalledTimes(1);

    fireEvent.press(view.getByTestId('probe-menu-backdrop'));
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    // Only the pressed item ran.
    expect(ITEMS[1].onPress).not.toHaveBeenCalled();
    expect(ITEMS[2].onPress).not.toHaveBeenCalled();

    await view.unmount();
  });
});
