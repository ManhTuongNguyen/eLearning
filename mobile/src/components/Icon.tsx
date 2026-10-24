/**
 * The application's single icon seam (TASK-SENT-001).
 *
 * Screens never import an icon library directly: they ask for a semantic name
 * (`sentences`, `speaker`, `trash`, ...) and this module maps it onto the
 * concrete lucide component. Swapping or extending the icon set is therefore a
 * one-file change, and tests can assert behaviour by semantic name.
 *
 * Colors are always supplied by the caller from the active theme; the seam
 * deliberately has no hard-coded palette so dark mode cannot be broken here.
 */

import type { LucideIcon } from 'lucide-react-native';

import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  EllipsisVertical,
  Headphones,
  History,
  Keyboard,
  ListChecks,
  List as ListIcon,
  MessageSquare,
  MicVocal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Speech,
  SquarePen,
  Target,
  Trash2,
  Type,
  Volume2,
  X,
} from 'lucide-react-native';

/** Every icon the application is allowed to render, by semantic name. */
export const ICON_NAMES = [
  'chat',
  'history',
  'listening',
  'speaking',
  'speakingHistory',
  'sentences',
  'words',
  'settings',
  'plus',
  'edit',
  'trash',
  'speaker',
  'play',
  'check',
  'close',
  'more',
  'refresh',
  'regenerate',
  'generate',
  'arrowLeft',
  'arrowRight',
  'audioLines',
  'keyboard',
  'list',
  'target',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** Semantic name → concrete lucide component. */
export const ICON_COMPONENTS: Record<IconName, LucideIcon> = {
  chat: MessageSquare,
  history: History,
  listening: Headphones,
  speaking: MicVocal,
  speakingHistory: ListChecks,
  sentences: Speech,
  words: Type,
  settings: Settings,
  plus: Plus,
  edit: SquarePen,
  trash: Trash2,
  speaker: Volume2,
  play: Play,
  check: Check,
  close: X,
  more: EllipsisVertical,
  refresh: RefreshCw,
  regenerate: RotateCcw,
  generate: Sparkles,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  audioLines: AudioLines,
  keyboard: Keyboard,
  list: ListIcon,
  target: Target,
};

export interface IconProps {
  /** Semantic icon name; see {@link ICON_NAMES}. */
  name: IconName;
  /** Square edge length in points. */
  size?: number;
  /** Stroke color — pass a theme color, never a literal palette value. */
  color?: string;
  /** Stroke width; lucide's default is 2. */
  strokeWidth?: number;
  /** Test identifier; defaults to `icon-<name>`. */
  testID?: string;
}

/**
 * Render one semantic icon. An unknown name is a programming error caught by
 * the type system, never a runtime fallback.
 */
export function Icon({ name, size = 22, color, strokeWidth = 2, testID }: IconProps) {
  const IconComponent = ICON_COMPONENTS[name];
  return (
    <IconComponent
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      testID={testID ?? `icon-${name}`}
    />
  );
}
