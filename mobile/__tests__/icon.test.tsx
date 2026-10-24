/**
 * Icon seam tests (TASK-SENT-001).
 *
 * The seam is the only place allowed to know about the icon library (enforced
 * for all future code by the `no-restricted-imports` override in
 * `.eslintrc.js`), so these tests pin two things: every semantic name renders,
 * and props reach the underlying lucide component unchanged.
 */

import { render } from '@testing-library/react-native';
import type { IconName } from '../src/components/Icon';
import { ICON_COMPONENTS, ICON_NAMES, Icon } from '../src/components/Icon';

describe('Icon seam', () => {
  it('maps every semantic name to a component', () => {
    for (const name of ICON_NAMES) {
      expect(ICON_COMPONENTS[name]).toBeDefined();
    }
    expect(Object.keys(ICON_COMPONENTS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it('renders every name with a default test identifier', async () => {
    for (const name of ICON_NAMES) {
      const view = await render(<Icon name={name} />);
      // lucide marks its icons aria-hidden, so the accessibility-aware query
      // has to opt into hidden elements.
      expect(view.getByTestId(`icon-${name}`, { includeHiddenElements: true })).toBeTruthy();
      await view.unmount();
    }
  });

  it('forwards size, color, stroke width and a custom test identifier', async () => {
    const view = await render(
      <Icon name="sentences" size={30} color="#123456" strokeWidth={1.5} testID="probe" />,
    );

    // lucide paints `color` as the SVG stroke and turns `size` into width/height.
    const probe = view.getByTestId('probe', { includeHiddenElements: true });
    expect(probe.props.width).toBe(30);
    expect(probe.props.height).toBe(30);
    expect(probe.props.stroke).toBe('#123456');
    expect(probe.props.strokeWidth).toBe(1.5);
    expect(String(probe.props.className)).toContain('lucide-speech');
  });

  it('maps each semantic name onto a distinct icon component', async () => {
    const chat = await render(<Icon name="chat" />);
    const chatNode = chat.getByTestId('icon-chat', { includeHiddenElements: true });
    expect(String(chatNode.props.className)).toContain('lucide-message-square');

    const settings = await render(<Icon name="settings" />);
    const settingsNode = settings.getByTestId('icon-settings', { includeHiddenElements: true });
    expect(String(settingsNode.props.className)).toContain('lucide-settings');
  });

  it('exposes the semantic names the screens rely on', () => {
    const required: IconName[] = [
      'chat',
      'history',
      'listening',
      'speaking',
      'speakingHistory',
      'sentences',
      'settings',
      'plus',
      'trash',
      'speaker',
      'check',
      'help',
    ];
    for (const name of required) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});
