/**
 * Guide content invariants (in-app guide).
 *
 * The guide screens render whatever guideContent.ts declares, so the data
 * must be complete on its own: exactly one entry per guide id, every id
 * placed exactly once in the hub sections, every entry fully written, and
 * every entry ending in a deep link. Typecheck guarantees the deep-link
 * route shapes; the navigation test proves the links actually navigate.
 */

import { guideEntries, guideModeBadge, guideSections } from '../src/guide/guideContent';
import { GUIDE_IDS } from '../src/guide/types';

function expectNonBlank(value: string, label: string): void {
  expect(`${label}: ${value}`.length).toBeGreaterThan(label.length + 1);
  expect(value.trim()).not.toBe('');
}

describe('guide content', () => {
  it('defines exactly one entry per guide id', () => {
    expect(Object.keys(guideEntries).sort()).toEqual([...GUIDE_IDS].sort());
  });

  it('places every guide id exactly once across the hub sections', () => {
    const ids = guideSections.flatMap(section => section.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...GUIDE_IDS].sort());
    for (const section of guideSections) {
      expect(section.title.trim()).not.toBe('');
      expect(section.ids.length).toBeGreaterThan(0);
    }
  });

  it('keeps every entry complete and free of duplicate rows', () => {
    for (const entry of Object.values(guideEntries)) {
      expectNonBlank(entry.title, `title (${entry.id})`);
      expectNonBlank(entry.summary, `summary (${entry.id})`);
      expectNonBlank(entry.intro, `intro (${entry.id})`);
      expectNonBlank(entry.aiIntro, `aiIntro (${entry.id})`);

      expect(entry.steps.length).toBeGreaterThan(0);
      expect(new Set(entry.steps).size).toBe(entry.steps.length);
      for (const step of entry.steps) {
        expectNonBlank(step, `step (${entry.id})`);
      }

      expect(entry.aiUsage.length).toBeGreaterThan(0);
      expect(new Set(entry.aiUsage.map(usage => usage.action)).size).toBe(entry.aiUsage.length);
      for (const usage of entry.aiUsage) {
        expectNonBlank(usage.action, `aiUsage.action (${entry.id})`);
        expectNonBlank(usage.requests, `aiUsage.requests (${entry.id})`);
        if (usage.note) {
          expectNonBlank(usage.note, `aiUsage.note (${entry.id})`);
        }
      }

      for (const tip of entry.promptTips) {
        expectNonBlank(tip, `promptTip (${entry.id})`);
      }
      expect(entry.tips.length).toBeGreaterThan(0);
      for (const tip of entry.tips) {
        expectNonBlank(tip, `tip (${entry.id})`);
      }
    }
  });

  it('deep-links every entry to a real screen', () => {
    for (const entry of Object.values(guideEntries)) {
      const tryIt = entry.tryIt;
      expect(tryIt).toBeDefined();
      // An absent label must fail the non-blank check below.
      expectNonBlank(tryIt?.label ?? '', `tryIt.label (${entry.id})`);
      // The route's runtime validity is proven by the guide detail navigation
      // test; the type system already restricts it to parameterless routes.
      expect(typeof tryIt?.route).toBe('string');
    }
  });

  it('badges mode-specific entries with stable copy', () => {
    expect(guideModeBadge('serverless')).toBe('Serverless only');
    expect(guideModeBadge('server')).toBe('Server only');
    const modeSpecific = Object.values(guideEntries).filter(entry => entry.mode);
    expect(modeSpecific.length).toBeGreaterThan(0);
  });
});
