/**
 * One real-life sentence topic (TASK-SENT-009, SENTENCE_LIVE_V1 §1.3/§2.6).
 *
 * Shows the topic header, the bank of generated sentences and the actions a
 * learner needs to grow and drill it: generate a batch through the user's own
 * serverless provider, review the candidates before persisting them, play a
 * sentence with TTS, delete a sentence, and open spaced-repetition practice
 * once the topic holds at least five sentences.
 *
 * The list always reloads from the repository after a write, so counts and due
 * hints reflect what is actually stored. TTS uses the shared
 * `useSpeechPlayback` contract: one playback at a time, silenced on blur and
 * unmount.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {
  Screen,
  ScreenHeader,
  ScreenList,
  SCREEN_GUTTER,
} from '../components/ScreenLayout';
import {getLocalDatabase} from '../db/database';
import {
  deleteSentence,
  getSentenceTopicById,
  insertSentences,
  listSentencesByTopic,
} from '../db/sentenceRepository';
import type {SentenceRecord, SentenceTopicRecord} from '../db/types';
import type {SentenceTopicScreenProps} from '../navigation/types';
import {
  generateTopicSentences,
  type SentenceCandidate,
} from '../serverless/sentenceGeneration';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessConfig} from '../serverless/settings';
import {canPractice, MIN_PRACTICE_SENTENCES} from '../srs/session';
import type {ThemeColors} from '../theme/colors';
import {useTheme} from '../theme/ThemeContext';
import type {TextToSpeechEngine} from '../tts/textToSpeech';
import {getSpeechEngine} from '../tts/textToSpeech';
import {useSpeechPlayback} from '../tts/useSpeechPlayback';
import {SentenceReviewModal} from './SentenceReviewModal';

/** Counts offered by the generation panel. */
export const GENERATION_COUNTS = [1, 5, 10] as const;

/** Visible height of the scrollable description block. */
export const DESCRIPTION_MAX_HEIGHT = 110;

const PROVIDER_MISSING_MESSAGE =
  'Add your provider API key in Settings to generate sentences.';

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
    },
    header: {
      marginBottom: 14,
      gap: 8,
    },
    headerTop: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    backLinkButton: {
      paddingVertical: 4,
    },
    backLinkText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.accent,
    },
    title: {
      flex: 1,
      fontSize: 20,
      fontWeight: '700',
      color: c.textPrimary,
    },
    descriptionBox: {
      maxHeight: DESCRIPTION_MAX_HEIGHT,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    descriptionScroll: {
      maxHeight: DESCRIPTION_MAX_HEIGHT - 22,
    },
    description: {
      fontSize: 14,
      lineHeight: 20,
      color: c.textSecondary,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 16,
    },
    generateButton: {
      backgroundColor: c.primary,
    },
    generateButtonText: {
      color: c.onPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    practiceButton: {
      flex: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    practiceButtonText: {
      color: c.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    disabled: {
      opacity: 0.45,
    },
    hint: {
      fontSize: 13,
      color: c.textMuted,
      marginBottom: 12,
    },
    generatingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    generatePanel: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 14,
      gap: 12,
      marginBottom: 12,
    },
    panelLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: c.textMuted,
    },
    countRow: {
      flexDirection: 'row',
      gap: 10,
    },
    countOption: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingVertical: 10,
    },
    countOptionSelected: {
      borderColor: c.primary,
      backgroundColor: c.accentSoft,
    },
    countText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.textSecondary,
    },
    countTextSelected: {
      color: c.primary,
    },
    panelActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 10,
    },
    panelButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    panelButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.primary,
    },
    error: {
      color: c.errorText,
      fontSize: 13,
      marginBottom: 10,
    },
    success: {
      color: c.success,
      fontSize: 13,
      marginBottom: 10,
    },
    rowGroup: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      overflow: 'hidden',
    },
    row: {
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 6,
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    rowText: {
      flex: 1,
      gap: 3,
    },
    sentenceText: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
      lineHeight: 22,
    },
    meaning: {
      fontSize: 13,
      color: c.textSecondary,
      lineHeight: 18,
    },
    situation: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
      lineHeight: 17,
    },
    rowBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: 4,
    },
    dueHint: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      color: c.textMuted,
    },
    rowIconButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.background,
    },
    rowIconButtonActive: {
      backgroundColor: c.accentSoft,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: SCREEN_GUTTER,
    },
    stateText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    retryText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    emptyText: {
      fontSize: 14,
      color: c.textSecondary,
      textAlign: 'center',
      paddingVertical: 28,
      paddingHorizontal: 16,
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}

/** Local, secret-free description of any thrown value. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === 'string' && err.trim()) {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
  }
  return 'unknown error';
}

/**
 * A short due/status hint for one sentence. New and overdue rows read "Due
 * now"; future rows name the remaining whole minutes/hours/days.
 */
export function formatDueHint(sentence: SentenceRecord, nowMs: number): string {
  if (sentence.status === 'suspended') {
    return 'Suspended';
  }
  const dueMs = Date.parse(sentence.due_at);
  if (!Number.isFinite(dueMs) || dueMs <= nowMs) {
    return sentence.status === 'new' ? 'New · due now' : 'Due now';
  }
  const minutes = Math.max(1, Math.ceil((dueMs - nowMs) / 60_000));
  if (minutes < 60) {
    return `Due in ${minutes} min`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `Due in ${hours} h`;
  }
  const days = Math.ceil(hours / 24);
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

interface SentenceRowProps {
  sentence: SentenceRecord;
  nowMs: number;
  speaking: boolean;
  deleting: boolean;
  onSpeak: (sentence: SentenceRecord) => void;
  onDelete: (sentence: SentenceRecord) => void;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}

function SentenceRow({
  sentence,
  nowMs,
  speaking,
  deleting,
  onSpeak,
  onDelete,
  colors,
  styles,
}: SentenceRowProps) {
  return (
    <View style={styles.row} testID={`sentence-row-${sentence.id}`}>
      <View style={styles.rowTop}>
        <View style={styles.rowText}>
          <Text style={styles.sentenceText} testID={`sentence-text-${sentence.id}`}>
            {sentence.text}
          </Text>
          {sentence.meaning ? (
            <Text style={styles.meaning} testID={`sentence-meaning-${sentence.id}`}>
              {sentence.meaning}
            </Text>
          ) : null}
          {sentence.situation ? (
            <Text style={styles.situation} testID={`sentence-situation-${sentence.id}`}>
              {sentence.situation}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.rowBottom}>
        <Text style={styles.dueHint} testID={`sentence-hint-${sentence.id}`}>
          {formatDueHint(sentence, nowMs)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            speaking ? `Stop sentence ${sentence.text}` : `Play sentence ${sentence.text}`
          }
          testID={`sentence-speak-${sentence.id}`}
          onPress={() => onSpeak(sentence)}
          style={[styles.rowIconButton, speaking && styles.rowIconButtonActive]}
        >
          <Icon
            name="speaker"
            size={18}
            color={speaking ? colors.primary : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete sentence ${sentence.text}`}
          accessibilityState={{disabled: deleting}}
          testID={`sentence-delete-${sentence.id}`}
          onPress={() => onDelete(sentence)}
          disabled={deleting}
          style={styles.rowIconButton}
        >
          {deleting ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : (
            <Icon name="trash" size={18} color={colors.danger} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

interface SentenceTopicScreenInternalProps extends SentenceTopicScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function SentenceTopicScreen({
  navigation,
  route,
  speech = getSpeechEngine(),
}: SentenceTopicScreenInternalProps) {
  const {colors} = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topicId = route.params.topicId;

  const [topic, setTopic] = useState<SentenceTopicRecord | null>(null);
  const [sentences, setSentences] = useState<SentenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateCount, setGenerateCount] = useState<number>(5);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [providerMissing, setProviderMissing] = useState(false);

  const [candidates, setCandidates] = useState<SentenceCandidate[]>([]);
  const [reviewVisible, setReviewVisible] = useState(false);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {speakingId, speak, stop} = useSpeechPlayback(speech);
  const nowMs = Date.now();

  const loadTopic = useCallback(
    async (showSpinner: boolean) => {
      if (showSpinner) {
        setLoading(true);
      }
      setLoadError(null);
      try {
        const db = await getLocalDatabase();
        const [record, list] = await Promise.all([
          getSentenceTopicById(db, topicId),
          listSentencesByTopic(db, topicId),
        ]);
        if (!record) {
          throw new Error('This topic no longer exists.');
        }
        setTopic(record);
        setSentences(list);
      } catch (err) {
        setLoadError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [topicId],
  );

  useEffect(() => {
    loadTopic(true);
  }, [loadTopic, reloadKey]);

  // Returning from practice changes the schedule; re-read on focus so due
  // hints and the practice unlock state stay truthful.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      loadTopic(false);
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadTopic]);

  // TTS must never continue after the screen loses focus (pushed practice or
  // back navigation). Unmount silencing lives inside useSpeechPlayback.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('blur', () => {
      stop();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, stop]);

  const handleSpeak = useCallback(
    (sentence: SentenceRecord) => {
      if (speakingId === sentence.id) {
        stop();
        return;
      }
      speak(sentence.id, sentence.text);
    },
    [speakingId, speak, stop],
  );

  const handleDelete = useCallback(
    async (sentence: SentenceRecord) => {
      if (deletingId !== null) {
        return;
      }
      setDeletingId(sentence.id);
      setActionError(null);
      setSuccessMessage(null);
      try {
        const db = await getLocalDatabase();
        await deleteSentence(db, sentence.id);
        setSentences(previous => previous.filter(item => item.id !== sentence.id));
        setSuccessMessage('Sentence deleted.');
      } catch (err) {
        setActionError(`Could not delete the sentence: ${describeError(err)}`);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId],
  );

  const handleGenerate = useCallback(async () => {
    if (generating) {
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setProviderMissing(false);
    setSuccessMessage(null);
    setGenerateOpen(false);
    try {
      const config = await loadServerlessConfig();
      if (!config) {
        setProviderMissing(true);
        setGenerateError(PROVIDER_MISSING_MESSAGE);
        return;
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const record = await getSentenceTopicById(db, topicId);
      if (!record) {
        throw new Error('This topic no longer exists.');
      }
      const existing = await listSentencesByTopic(db, topicId);
      const generated = await generateTopicSentences(
        db,
        request => client.complete(request),
        {
          topicTitle: record.title,
          topicDescription: record.description,
          generationPrompt: record.generation_prompt,
          count: generateCount,
          existingSentences: existing.map(sentence => sentence.text),
        },
      );
      setCandidates(generated);
      setGenerateOpen(false);
      setReviewVisible(true);
    } catch (err) {
      setGenerateError(`Could not generate sentences: ${describeError(err)}`);
    } finally {
      setGenerating(false);
    }
  }, [generating, generateCount, topicId]);

  const handleKeepCandidates = useCallback(
    async (kept: SentenceCandidate[]) => {
      setGenerateError(null);
      setActionError(null);
      try {
        const db = await getLocalDatabase();
        const inserted = await insertSentences(
          db,
          topicId,
          kept.map(candidate => ({
            text: candidate.sentence,
            meaning: candidate.meaning,
            situation: candidate.situation,
          })),
        );
        setSuccessMessage(
          inserted.length === 0
            ? 'No new sentences added — duplicates were skipped.'
            : `${inserted.length} sentence${inserted.length === 1 ? '' : 's'} added.`,
        );
        await loadTopic(false);
      } catch (err) {
        setActionError(`Could not save the sentences: ${describeError(err)}`);
      } finally {
        setCandidates([]);
        setReviewVisible(false);
      }
    },
    [topicId, loadTopic],
  );

  const handlePractice = useCallback(() => {
    navigation.navigate('SentencePractice', {topicId});
  }, [navigation, topicId]);

  const practiceUnlocked = canPractice(sentences.length);
  const remainingToPractice = Math.max(
    0,
    MIN_PRACTICE_SENTENCES - sentences.length,
  );

  const renderRow = useCallback(
    ({item, index}: {item: SentenceRecord; index: number}) => (
      <>
        {index > 0 ? <View style={styles.rowDivider} /> : null}
        <SentenceRow
          sentence={item}
          nowMs={nowMs}
          speaking={speakingId === item.id}
          deleting={deletingId === item.id}
          onSpeak={handleSpeak}
          onDelete={handleDelete}
          colors={colors}
          styles={styles}
        />
      </>
    ),
    [nowMs, speakingId, deletingId, handleSpeak, handleDelete, colors, styles],
  );

  return (
    <Screen style={styles.container} testID="sentence-topic-screen">
      <ScreenHeader style={styles.header}>
        <View style={styles.headerTop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to topics"
            testID="sentence-topic-back"
            onPress={() => navigation.goBack()}
            style={styles.backLinkButton}
          >
            <Text style={styles.backLinkText}>‹ Topics</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1} testID="sentence-topic-title">
            {topic?.title ?? 'Topic'}
          </Text>
        </View>
        {topic?.description ? (
          <View style={styles.descriptionBox}>
            <ScrollView
              style={styles.descriptionScroll}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              testID="sentence-topic-description-scroll"
            >
              <Text style={styles.description} testID="sentence-topic-description">
                {topic.description}
              </Text>
            </ScrollView>
          </View>
        ) : null}
      </ScreenHeader>

      {loading ? (
        <View style={styles.centered} testID="sentence-topic-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.centered} testID="sentence-topic-load-error">
          <Text role="alert" style={styles.stateText}>
            {loadError}
          </Text>
          <Pressable testID="sentence-topic-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScreenList
          data={sentences}
          keyExtractor={item => String(item.id)}
          renderItem={renderRow}
          ListHeaderComponent={
            <>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Generate new sentences"
                  testID="sentence-generate-open"
                  onPress={() => {
                    setGenerateOpen(value => !value);
                    setGenerateError(null);
                    setProviderMissing(false);
                  }}
                  disabled={generating}
                  style={({pressed}) => [
                    styles.actionButton,
                    styles.generateButton,
                    pressed && styles.pressedFade,
                  ]}
                >
                  <Icon name="generate" size={18} color={colors.onPrimary} />
                  <Text style={styles.generateButtonText}>Generate</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    practiceUnlocked
                      ? 'Practice this topic'
                      : `Practice locked. ${remainingToPractice} more sentences needed.`
                  }
                  accessibilityState={{disabled: !practiceUnlocked}}
                  testID="sentence-practice"
                  onPress={handlePractice}
                  disabled={!practiceUnlocked}
                  style={({pressed}) => [
                    styles.actionButton,
                    styles.practiceButton,
                    !practiceUnlocked && styles.disabled,
                    pressed && styles.pressedFade,
                  ]}
                >
                  <Icon name="play" size={18} color={colors.textPrimary} />
                  <Text style={styles.practiceButtonText}>Practice</Text>
                </Pressable>
              </View>

              {!practiceUnlocked ? (
                <Text style={styles.hint} testID="sentence-practice-hint">
                  Add {remainingToPractice} more sentence
                  {remainingToPractice === 1 ? '' : 's'} to unlock practice.
                </Text>
              ) : null}

              {generateOpen ? (
                <View style={styles.generatePanel} testID="sentence-generate-panel">
                  <Text style={styles.panelLabel}>How many sentences?</Text>
                  <View style={styles.countRow}>
                    {GENERATION_COUNTS.map(count => {
                      const selected = generateCount === count;
                      return (
                        <Pressable
                          key={count}
                          accessibilityRole="button"
                          accessibilityState={{selected}}
                          accessibilityLabel={`Generate ${count} sentence${
                            count === 1 ? '' : 's'
                          }`}
                          testID={`sentence-generate-count-${count}`}
                          onPress={() => setGenerateCount(count)}
                          style={[
                            styles.countOption,
                            selected && styles.countOptionSelected,
                          ]}
                        >
                          <Text
                            style={[
                              styles.countText,
                              selected && styles.countTextSelected,
                            ]}
                          >
                            {count}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.panelActions}>
                    <Pressable
                      testID="sentence-generate-cancel"
                      onPress={() => setGenerateOpen(false)}
                      disabled={generating}
                      style={styles.panelButton}
                    >
                      <Text style={styles.panelButtonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      testID="sentence-generate-run"
                      onPress={handleGenerate}
                      disabled={generating}
                      style={styles.panelButton}
                    >
                      {generating ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : (
                        <Text style={styles.panelButtonText}>Generate</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {generating && !generateOpen ? (
                <View style={styles.generatingRow} testID="sentence-generating">
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.hint}>Generating sentences…</Text>
                </View>
              ) : null}

              {generateError ? (
                <View>
                  <Text
                    role="alert"
                    style={styles.error}
                    testID="sentence-generate-error"
                  >
                    {generateError}
                  </Text>
                  <View style={styles.panelActions}>
                    {providerMissing ? (
                      <Pressable
                        testID="sentence-generate-settings"
                        onPress={() => navigation.navigate('AIProviderSettings')}
                        style={styles.panelButton}
                      >
                        <Text style={styles.panelButtonText}>Open AI settings</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        testID="sentence-generate-retry"
                        onPress={handleGenerate}
                        style={styles.panelButton}
                      >
                        <Text style={styles.panelButtonText}>Try again</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              ) : null}

              {actionError ? (
                <Text role="alert" style={styles.error} testID="sentence-action-error">
                  {actionError}
                </Text>
              ) : null}
              {successMessage ? (
                <Text style={styles.success} testID="sentence-success">
                  {successMessage}
                </Text>
              ) : null}
            </>
          }
          ListEmptyComponent={
            <Text style={styles.emptyText} testID="sentence-empty">
              No sentences yet. Tap Generate to add your first batch.
            </Text>
          }
        />
      )}

      <SentenceReviewModal
        visible={reviewVisible}
        candidates={candidates}
        onClose={() => {
          setReviewVisible(false);
          setCandidates([]);
        }}
        onKeep={handleKeepCandidates}
      />
    </Screen>
  );
}
