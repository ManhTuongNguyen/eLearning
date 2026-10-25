/**
 * Screen nav-bar layout tests.
 *
 * The bar must stay on ONE line — back on the left, actions on the right,
 * and the title dead-center — no matter how many items it holds. The title
 * is centered by absolute positioning, so adding or removing a right action
 * never shifts it.
 */
import { render } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { ScreenTitleBar } from '../src/components/ScreenTitleBar';
import { ThemeProvider } from '../src/theme/ThemeContext';

function renderBar(props: Parameters<typeof ScreenTitleBar>[0]) {
  return render(
    <ThemeProvider>
      <ScreenTitleBar {...props} />
    </ThemeProvider>,
  );
}

const right = (
  <Pressable testID="action" accessibilityRole="button">
    <Text>Action</Text>
  </Pressable>
);

describe('ScreenTitleBar', () => {
  it('lays out back, title and actions as a single row', async () => {
    const view = await renderBar({
      title: 'Word bank',
      onBack: jest.fn(),
      backTestID: 'probe-back',
      titleTestID: 'probe-title',
      right,
    });

    // The row holding the bar children is horizontal — otherwise the three
    // items wrap onto separate lines.
    const bar = view.getByTestId('probe-back').parent;
    const barStyle = Array.isArray(bar?.props.style)
      ? Object.assign({}, ...bar?.props.style.filter(Boolean))
      : bar?.props.style;
    expect(barStyle.flexDirection).toBe('row');

    await view.unmount();
  });

  it('centers the title absolutely so it ignores the side items', async () => {
    const view = await renderBar({
      title: 'Real-life sentences',
      onBack: jest.fn(),
      backTestID: 'probe-back',
      titleTestID: 'probe-title',
      right,
    });

    const titleWrap = view.getByTestId('probe-title').parent;
    const wrapStyle = Array.isArray(titleWrap?.props.style)
      ? Object.assign({}, ...titleWrap?.props.style.filter(Boolean))
      : titleWrap?.props.style;

    // Absolute fill = centered over the bar, independent of the back button
    // and the right action widths.
    expect(wrapStyle.position).toBe('absolute');
    expect(wrapStyle.top).toBe(0);
    expect(wrapStyle.left).toBe(0);
    expect(wrapStyle.right).toBe(0);
    expect(wrapStyle.bottom).toBe(0);
    expect(wrapStyle.alignItems).toBe('center');

    await view.unmount();
  });

  it('renders the title and back control with the unified styling', async () => {
    const view = await renderBar({
      title: 'Settings',
      onBack: jest.fn(),
      backTestID: 'probe-back',
      titleTestID: 'probe-title',
    });

    expect(view.getByTestId('probe-title')).toHaveTextContent('Settings');
    // 18pt is the app-wide title size.
    const titleStyle = view.getByTestId('probe-title').props.style;
    expect(titleStyle.fontSize).toBe(18);
    expect(view.getByTestId('probe-back')).toBeTruthy();
    // No right actions renders no actions wrapper.
    expect(view.queryByTestId('action')).toBeNull();

    await view.unmount();
  });
});
