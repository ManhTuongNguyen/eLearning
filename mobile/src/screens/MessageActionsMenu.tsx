/**
 * Message long-press menu (SPEC TASK-060, ROADMAP §8/§16): presents the
 * contextual actions available for one chat message. User messages offer
 * Suggest replies / Improve my English / Copy / Read aloud; assistant
 * messages drop the improvement action (it only applies to the learner's
 * own text). The menu is a bottom-sheet card over a dismissible backdrop:
 * it closes through the Close control, a backdrop tap or the Android back
 * button, and its container is marked as an accessibility modal with every
 * action exposed as a labeled button.
 *
 * Selecting an action reports it upward and lets the parent close the menu;
 * the behaviors land in their own tasks (suggestions → TASK-061,
 * improvement → TASK-064, speech → TASK-078) while Copy already works via
 * the clipboard seam in the chat screen.
 */
import React, {useMemo} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';

import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';

export type MessageAction = 'suggest-replies' | 'improve-english' | 'copy' | 'speak';

export interface MessageActionItem {
  action: MessageAction;
  label: string;
}

const USER_ACTIONS: MessageActionItem[] = [
  {action: 'suggest-replies', label: 'Suggest replies'},
  {action: 'improve-english', label: 'Improve my English'},
  {action: 'copy', label: 'Copy'},
  {action: 'speak', label: 'Read aloud'},
];

const ASSISTANT_ACTIONS: MessageActionItem[] = [
  {action: 'suggest-replies', label: 'Suggest replies'},
  {action: 'copy', label: 'Copy'},
  {action: 'speak', label: 'Read aloud'},
];

function actionsForRole(role: 'user' | 'assistant'): MessageActionItem[] {
  return role === 'user' ? USER_ACTIONS : ASSISTANT_ACTIONS;
}

function testIdForAction(action: MessageAction): string {
  return `chat-menu-${action}`;
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: 8,
      paddingBottom: 16,
      paddingTop: 6,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    title: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    closeText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
      paddingVertical: 4,
    },
    item: {
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    itemText: {
      fontSize: 15,
      color: c.textPrimary,
    },
  });
}

interface MessageActionsMenuProps {
  /** Whether the overlay is presented; closed menus render nothing. */
  visible: boolean;
  /** Role of the message the menu was opened for; drives the action list. */
  role: 'user' | 'assistant';
  /** Dismissal callback (Close button, backdrop tap and Android back). */
  onClose: () => void;
  /** Selection callback; the parent closes the menu and runs the action. */
  onSelect: (action: MessageAction) => void;
}

export function MessageActionsMenu({
  visible,
  role,
  onClose,
  onSelect,
}: MessageActionsMenuProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const actions = useMemo(() => actionsForRole(role), [role]);

  if (!visible) {
    return null;
  }

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      testID="chat-menu-modal"
      transparent
      visible>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="chat-menu-backdrop">
        <Pressable style={styles.sheet} testID="chat-menu">
          <View accessibilityViewIsModal testID="chat-menu-content">
            <View style={styles.header}>
              <Text style={styles.title}>Message actions</Text>
              <Pressable
                onPress={onClose}
                testID="chat-menu-close"
                accessibilityRole="button"
                accessibilityLabel="Close message actions">
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
            {actions.map(item => (
              <Pressable
                key={item.action}
                style={styles.item}
                onPress={() => {
                  onSelect(item.action);
                }}
                testID={testIdForAction(item.action)}
                accessibilityRole="button"
                accessibilityLabel={item.label}>
                <Text style={styles.itemText}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
