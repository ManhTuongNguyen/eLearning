/**
 * Content model for the in-app guide.
 *
 * Guide text lives in `guideContent.ts` as plain data; the two guide screens
 * (`GuideScreen` hub, `GuideDetailScreen` page) only render this shape. Every
 * guide id must have exactly one entry, and every deep-link target must be a
 * stack route whose params are optional — both invariants are enforced by
 * tests, not by convention.
 */
import type { IconName } from '../components/Icon';
import type { MainStackParamList } from '../navigation/types';

/** Identifier of one guide entry; `guideContent.ts` defines all of them. */
export const GUIDE_IDS = [
  'conversations',
  'history',
  'listening',
  'speaking',
  'sentences',
  'wordBank',
  'aiUsage',
  'level',
  'provider',
  'tts',
  'vocabulary',
] as const;

export type GuideId = (typeof GUIDE_IDS)[number];

/** Application mode a guide's feature requires, if any. */
export type GuideModeRequirement = 'server' | 'serverless';

/**
 * Stack routes a guide may deep-link to: exactly the routes whose params are
 * optional, so `navigation.navigate(route)` alone always typechecks. Routes
 * that need a topic/word id (e.g. `WordTopic`) are deliberately excluded —
 * a guide cannot know a real id to hand over.
 */
export type GuideDeepLinkRoute = {
  [K in keyof MainStackParamList]: undefined extends MainStackParamList[K] ? K : never;
}[keyof MainStackParamList];

/** One row of the "AI requests" card: a learner action and its AI cost. */
export interface GuideAiUsage {
  /** What the learner does, in feature terms. */
  action: string;
  /** Request cost in one short phrase, e.g. "1 request, streamed". */
  requests: string;
  /** Optional one-line detail (caching, background cadence, mode). */
  note?: string;
}

/** A deep link that opens the real screen described by the guide. */
export interface GuideTryIt {
  label: string;
  route: GuideDeepLinkRoute;
}

export interface GuideEntry {
  id: GuideId;
  title: string;
  icon: IconName;
  /** One-line description shown on the guide hub. */
  summary: string;
  /** What the feature is, shown under the title on the guide page. */
  intro: string;
  /** Application mode the feature requires; absent when it works everywhere. */
  mode?: GuideModeRequirement;
  /** Numbered "how to use it" steps, in order. */
  steps: string[];
  /** Lead-in sentence above the AI-request rows. */
  aiIntro: string;
  /** Per-action AI request costs. */
  aiUsage: GuideAiUsage[];
  /** How the prompt is built and what the learner controls about it. */
  promptTips: string[];
  /** Short practical tips. */
  tips: string[];
  /** Deep link to the real screen, when the guide has a parameterless target. */
  tryIt?: GuideTryIt;
}

/** Hub grouping: the guide hub renders entries section by section. */
export interface GuideSection {
  title: string;
  ids: GuideId[];
}
