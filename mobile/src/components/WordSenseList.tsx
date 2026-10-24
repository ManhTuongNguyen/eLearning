/**
 * Shared renderer for one word's stored senses (WORD_BANK_V1).
 *
 * Every surface that shows a word's data — Word detail, the practice back
 * cards, the enrichment change-review cells — renders through this component
 * so they cannot drift apart. The layout groups the data the way dictionaries
 * do, so the eye can parse it at a glance instead of reading a wall of lines:
 *
 * - one section per part-of-speech group, marked by a badge;
 * - definitions numbered within the group and separated by hairline dividers;
 * - every example pulled into a quote block with a left accent bar, so it
 *   reads as attached to the definition above it rather than as another line;
 * - sense-level Synonyms/Antonyms and definition-level ≈/≠ lines labeled.
 *
 * `variant="front"` is the recall card's masked front: every string goes
 * through `renderText` (the word mask), nothing is selectable (selecting
 * masked text would leak the answer) and synonym/antonym lines are omitted —
 * a synonym can contain the answer.
 */

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { WordSense } from '../db/types';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    list: {
      gap: 18,
    },
    group: {
      gap: 8,
    },
    posBadge: {
      alignSelf: 'flex-start',
      backgroundColor: c.accentSoft,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    posBadgeText: {
      fontSize: 12,
      fontWeight: '700',
      color: c.accent,
    },
    relationLine: {
      fontSize: 13,
      lineHeight: 18,
      color: c.textMuted,
    },
    definitionRow: {
      flexDirection: 'row',
      gap: 8,
    },
    definitionNumber: {
      fontSize: 16,
      lineHeight: 22,
      fontWeight: '700',
      color: c.textMuted,
      minWidth: 20,
    },
    definitionBody: {
      flex: 1,
      gap: 6,
    },
    definitionText: {
      fontSize: 16,
      lineHeight: 22,
      color: c.textPrimary,
    },
    definitionDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: c.border,
      marginVertical: 9,
    },
    exampleBlock: {
      borderLeftWidth: 2,
      borderLeftColor: c.accent,
      paddingLeft: 10,
    },
    exampleText: {
      fontSize: 14,
      lineHeight: 20,
      fontStyle: 'italic',
      color: c.textSecondary,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 2,
    },
    tagChip: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
      backgroundColor: c.background,
    },
    tagChipText: {
      fontSize: 11,
      color: c.textMuted,
    },
  });
}

/** One "Synonyms: a, b" / "≈ a, b" line, or nothing when the list is empty. */
function RelationLine({
  label,
  words,
  selectable,
  style,
}: {
  label: string;
  words: readonly string[];
  selectable: boolean;
  style: { fontSize: number; lineHeight: number; color: string };
}) {
  if (words.length === 0) {
    return null;
  }
  return (
    <Text selectable={selectable} style={style}>
      {label}
      {words.join(', ')}
    </Text>
  );
}

export interface WordSenseListProps {
  senses: readonly WordSense[];
  /** `'front'` renders the recall card's masked, non-selectable front. */
  variant?: 'full' | 'front';
  /** Wrap every displayed string — the recall front passes the word mask. */
  renderText?: (text: string) => ReactNode;
  /** Hide the per-group POS badge (enrich review rows already identify the POS). */
  showPosHeader?: boolean;
}

export function WordSenseList({
  senses,
  variant = 'full',
  renderText,
  showPosHeader = true,
}: WordSenseListProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const full = variant === 'full';
  const render = renderText ?? ((text: string) => text);

  return (
    <View style={styles.list}>
      {senses.map((sense, senseIndex) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: groups render positionally
          key={`${sense.partOfSpeech}-${senseIndex}`}
          style={styles.group}>
          {showPosHeader ? (
            <View style={styles.posBadge}>
              <Text selectable={full} style={styles.posBadgeText}>
                {sense.partOfSpeech}
              </Text>
            </View>
          ) : null}
          {full ? (
            <>
              <RelationLine
                label="Synonyms: "
                words={sense.synonyms ?? []}
                selectable
                style={styles.relationLine}
              />
              <RelationLine
                label="Antonyms: "
                words={sense.antonyms ?? []}
                selectable
                style={styles.relationLine}
              />
            </>
          ) : null}
          {sense.definitions.map((definition, definitionIndex) => {
            const examples = [
              ...(definition.example ? [definition.example] : []),
              ...(full ? (definition.extraExamples ?? []) : []),
            ];
            return (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: definitions render positionally
                key={definitionIndex}>
                {definitionIndex > 0 ? <View style={styles.definitionDivider} /> : null}
                <View style={styles.definitionRow}>
                  <Text selectable={full} style={styles.definitionNumber}>
                    {definitionIndex + 1}.
                  </Text>
                  <View style={styles.definitionBody}>
                    {full && (definition.tags ?? []).length > 0 ? (
                      <View style={styles.chipRow}>
                        {(definition.tags ?? []).map((tag, tagIndex) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: chips render positionally
                          <View key={tagIndex} style={styles.tagChip}>
                            <Text style={styles.tagChipText}>{tag}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <Text selectable={full} style={styles.definitionText}>
                      {render(definition.definition)}
                    </Text>
                    {examples.map((example, exampleIndex) => (
                      <View
                        // biome-ignore lint/suspicious/noArrayIndexKey: examples render positionally
                        key={`example-${exampleIndex}`}
                        style={styles.exampleBlock}>
                        <Text selectable={full} style={styles.exampleText}>
                          {render(example)}
                        </Text>
                      </View>
                    ))}
                    {full ? (
                      <>
                        <RelationLine
                          label="≈ "
                          words={definition.synonyms ?? []}
                          selectable
                          style={styles.relationLine}
                        />
                        <RelationLine
                          label="≠ "
                          words={definition.antonyms ?? []}
                          selectable
                          style={styles.relationLine}
                        />
                      </>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
