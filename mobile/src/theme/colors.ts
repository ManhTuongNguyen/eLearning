/**
 * Theme color tokens (SPEC TASK-044): a neutral, modern palette in light and
 * dark variants. Screens must reference these tokens instead of hard-coded
 * colors so the whole app re-themes through a single palette swap.
 */

export interface ThemeColors {
  /** Screen background. */
  background: string;
  /** Cards, inputs, list rows and other raised surfaces. */
  surface: string;
  /** Subtle outlines (list rows, dividers). */
  border: string;
  /** Strong outlines (text inputs, radio circles). */
  borderStrong: string;
  /** Primary text. */
  textPrimary: string;
  /** Supporting copy. */
  textSecondary: string;
  /** De-emphasized descriptions. */
  textMuted: string;
  /** Brand fill for primary buttons, selected radios and spinners. */
  primary: string;
  /** Text/icons rendered on top of `primary` or destructive fills. */
  onPrimary: string;
  /** Accent for links/back controls on the page background. */
  accent: string;
  /** Soft accent wash behind selected rows. */
  accentSoft: string;
  /** Destructive fill (logout). */
  danger: string;
  /** Error/validation message text. */
  errorText: string;
  /** Caution color (grammar warning badges and similar soft alerts). */
  warning: string;
  /** Success confirmation text. */
  success: string;
}

export const lightColors: ThemeColors = {
  background: '#f5f6f8',
  surface: '#ffffff',
  border: '#e5e7eb',
  borderStrong: '#d1d5db',
  textPrimary: '#111827',
  textSecondary: '#4b5563',
  textMuted: '#6b7280',
  primary: '#2563eb',
  onPrimary: '#ffffff',
  accent: '#2563eb',
  accentSoft: '#eff6ff',
  danger: '#dc2626',
  errorText: '#b91c1c',
  warning: '#b45309',
  success: '#15803d',
};

export const darkColors: ThemeColors = {
  background: '#0f172a',
  surface: '#1e293b',
  border: '#293548',
  borderStrong: '#475569',
  textPrimary: '#f9fafb',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  primary: '#3b82f6',
  onPrimary: '#ffffff',
  accent: '#93c5fd',
  accentSoft: 'rgba(59,130,246,0.16)',
  danger: '#dc2626',
  errorText: '#fca5a5',
  warning: '#fbbf24',
  success: '#4ade80',
};
