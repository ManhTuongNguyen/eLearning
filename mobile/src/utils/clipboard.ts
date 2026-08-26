/**
 * Clipboard seam (SPEC TASK-060): every consumer copies text through this
 * helper instead of importing react-native's deprecated Clipboard export
 * directly, so tests can mock one tiny module and a future native
 * implementation can swap in without touching UI code.
 */
import {Clipboard} from 'react-native';

export function copyText(text: string): void {
  Clipboard.setString(text);
}
