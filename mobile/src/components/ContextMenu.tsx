/**
 * Context menu: a popover anchored next to the ⋮ button that opened it.
 *
 * The trigger passes the press point (`nativeEvent.pageX/pageY`); the sheet
 * opens with its right edge under the trigger, flipping up when the list ends
 * near the screen bottom. A transparent backdrop dims the rest and closes on
 * tap (and on Android back). Items mirror the earlier sheet menu: semantic
 * icon, bold label, optional muted detail value and a `danger` variant.
 *
 * The anchor coordinates are optional on purpose: in environments where the
 * press event carries no page position (unit tests, accessibility tools) the
 * menu falls back to the top-right corner so it always opens.
 */
import { useMemo } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { IconName } from './Icon';
import { Icon } from './Icon';

/** The point the menu should hang off, in window coordinates. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  /** Stable key for the list; also becomes the `testID` suffix. */
  key: string;
  label: string;
  icon: IconName;
  /** Muted right-aligned value, e.g. the current setting. */
  detail?: string;
  /** Renders the label in the danger color (destructive actions). */
  danger?: boolean;
  onPress: () => void;
}

export interface ContextMenuProps {
  /** Whether the menu is presented. */
  visible: boolean;
  /** The trigger's press point; falls back to the top-right when missing. */
  anchor: ContextMenuAnchor | null;
  /** The actions of the row that opened the menu. */
  items: readonly ContextMenuItem[];
  /** Dismiss without acting (backdrop press or Android back). */
  onCancel: () => void;
  /** Becomes the modal's `testID`; items become `<testID>-<key>`. */
  testID?: string;
}

const MENU_WIDTH = 208;
const ITEM_HEIGHT = 48;
const SHEET_CHROME = 12;
const SCREEN_MARGIN = 8;

/**
 * Place the sheet: right-aligned with the trigger and just below it, flipping
 * above the trigger when there is no room below, always inside the screen.
 * Pure so tests can pin the flip and clamp behaviour.
 */
export function computeContextMenuPosition(
  anchor: ContextMenuAnchor | null,
  itemCount: number,
  windowWidth: number,
  windowHeight: number,
): { left: number; top: number } {
  const x = anchor && Number.isFinite(anchor.x) ? anchor.x : windowWidth - 32;
  const y = anchor && Number.isFinite(anchor.y) ? anchor.y : 96;
  const estimatedHeight = itemCount * ITEM_HEIGHT + SHEET_CHROME;

  // The ⋮ sits on the row's right, so the sheet's right edge lines up with
  // the press point (slightly past it).
  const left = Math.min(
    Math.max(SCREEN_MARGIN, x + 24 - MENU_WIDTH),
    windowWidth - MENU_WIDTH - SCREEN_MARGIN,
  );

  let top = y + 12;
  if (top + estimatedHeight > windowHeight - SCREEN_MARGIN) {
    top = Math.max(SCREEN_MARGIN, y - estimatedHeight - 12);
  }
  return { left, top };
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      // Lighter than a sheet scrim: a popover floats over readable content.
      backgroundColor: 'rgba(0, 0, 0, 0.2)',
    },
    sheet: {
      position: 'absolute',
      width: MENU_WIDTH,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingVertical: 6,
      // Float over the row instead of docking to an edge.
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 8,
    },
    item: {
      minHeight: ITEM_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    itemText: {
      flex: 1,
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    itemTextDanger: {
      color: c.danger,
    },
    itemDetail: {
      fontSize: 13,
      fontWeight: '500',
      color: c.textMuted,
    },
    pressedFade: {
      opacity: 0.7,
    },
  });
}

export function ContextMenu({ visible, anchor, items, onCancel, testID }: ContextMenuProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const window = Dimensions.get('window');
  const position = computeContextMenuPosition(anchor, items.length, window.width, window.height);

  if (!visible) {
    return null;
  }

  return (
    <Modal animationType="fade" onRequestClose={onCancel} testID={testID} transparent visible>
      <Pressable
        style={styles.backdrop}
        onPress={onCancel}
        accessibilityLabel="Close menu"
        testID={testID ? `${testID}-backdrop` : undefined}>
        <Pressable
          style={[styles.sheet, position]}
          accessibilityViewIsModal
          testID={testID ? `${testID}-sheet` : undefined}>
          <View accessibilityRole="menu">
            {items.map(item => (
              <Pressable
                key={item.key}
                accessibilityRole="menuitem"
                accessibilityLabel={item.detail ? `${item.label}, ${item.detail}` : item.label}
                testID={testID ? `${testID}-${item.key}` : undefined}
                onPress={item.onPress}
                style={({ pressed }) => [styles.item, pressed && styles.pressedFade]}>
                <Icon
                  name={item.icon}
                  size={18}
                  color={item.danger ? colors.danger : colors.accent}
                />
                <Text style={[styles.itemText, item.danger && styles.itemTextDanger]}>
                  {item.label}
                </Text>
                {item.detail ? <Text style={styles.itemDetail}>{item.detail}</Text> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
