/**
 * Shared modal chrome: the themed style set every dialog-style modal in the
 * app uses — dimmed centered backdrop, one surface card, title/hint/error
 * text, a right-aligned footer of pill buttons (cancel / primary / danger).
 *
 * Screens merge it into their own `createStyles` and keep any keys that
 * genuinely differ (their local keys win, since they are written after the
 * spread):
 *
 * ```ts
 * const modal = createModalStyles(c);
 * return StyleSheet.create({ ...modal, modalCard: { ...modal.modalCard, maxWidth: 560 }, ...local });
 * ```
 *
 * `modalCard` dimensions vary per dialog; everything else is pixel-identical
 * across the app by convention. The explicit style types keep the spread
 * assignable to `StyleSheet.create` in consumers.
 */
import type { TextStyle, ViewStyle } from 'react-native';
import type { ThemeColors } from '../theme/colors';
import { SCREEN_GUTTER } from './ScreenLayout';

/** The shared modal style set, keyed exactly as the module doc describes. */
export interface ModalChromeStyles {
  backdrop: ViewStyle;
  modalCard: ViewStyle;
  modalTitle: TextStyle;
  inputLabel: TextStyle;
  input: TextStyle;
  modalError: TextStyle;
  modalFooter: ViewStyle;
  modalButton: ViewStyle;
  modalCancelButton: ViewStyle;
  modalPrimaryButton: ViewStyle;
  modalDangerButton: ViewStyle;
  modalDisabled: ViewStyle;
  modalCancelText: TextStyle;
  modalPrimaryText: TextStyle;
}

/** Card-size overrides; omitted `cardMaxHeight` leaves the card unclamped. */
export interface ModalChromeOptions {
  cardMaxWidth?: number;
  cardMaxHeight?: number | `${number}%`;
}

/** The shared modal style set. See the module doc for the merge convention. */
export function createModalStyles(
  c: ThemeColors,
  options: ModalChromeOptions = {},
): ModalChromeStyles {
  return {
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SCREEN_GUTTER,
    },
    modalCard: {
      width: '100%',
      maxWidth: options.cardMaxWidth ?? 420,
      ...(options.cardMaxHeight !== undefined ? { maxHeight: options.cardMaxHeight } : {}),
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    input: {
      backgroundColor: c.background,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: c.textPrimary,
    },
    modalError: {
      fontSize: 13,
      color: c.errorText,
    },
    modalFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
      marginTop: 4,
    },
    modalButton: {
      minWidth: 88,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    modalCancelButton: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    modalPrimaryButton: {
      backgroundColor: c.primary,
    },
    modalDangerButton: {
      backgroundColor: c.danger,
    },
    modalDisabled: {
      opacity: 0.5,
    },
    modalCancelText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textPrimary,
    },
    modalPrimaryText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.onPrimary,
    },
  };
}
