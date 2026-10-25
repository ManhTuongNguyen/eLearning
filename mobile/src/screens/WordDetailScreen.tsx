/**
 * Word detail screen (WORD_BANK_V1 §2.8, TASK-WB-013).
 *
 * Shows everything the row stores: the word in large type with its phonetics
 * and a device-TTS play button, every sense grouped by part of speech with
 * their examples, the topic it belongs to and the FSRS schedule info (state,
 * due time, stability, difficulty, reps, lapses, last grade/date).
 *
 * Actions:
 * - **Fetch dictionary data** is visible ONLY while `data_status='missing'`:
 *   one dictionary call fills senses and phonetics and flips the word to
 *   complete; a 404 keeps it missing with a "not found" message.
 * - **Enrich** re-drafts the learning data through the AI (TASK-WB-014). For a
 *   word the dictionary could not fill, the approved AI proposal is the only
 *   path that completes it.
 * - **Delete** asks for confirmation and removes the word (its review log
 *   cascades), then navigates back.
 *
 * The screen reads from the repository on focus; no in-memory guesses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ConfirmModal } from '../components/ConfirmModal';
import { Icon } from '../components/Icon';
import {
  SCREEN_GUTTER,
  SCREEN_TOP_SPACING,
  Screen,
  ScreenScrollView,
} from '../components/ScreenLayout';
import { ScreenTitleBar } from '../components/ScreenTitleBar';
import { WordSenseList } from '../components/WordSenseList';
import { getLocalDatabase } from '../db/database';
import type { WordRecord, WordSense } from '../db/types';
import {
  applyWordEnrichment,
  deleteWord,
  fillWordDictionaryData,
  getWordById,
  getWordTopicById,
} from '../db/wordRepository';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordDetailScreenProps } from '../navigation/types';
import { lookupDictionaryWord } from '../serverless/dictionaryApi';
import { createProviderClient } from '../serverless/providerRegistry';
import { loadServerlessConfig } from '../serverless/settings';
import { enrichWord } from '../serverless/wordEnrichment';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';
import { describeError } from '../utils/describeError';
import { WordEnrichReviewModal } from './WordEnrichReviewModal';
import { WordScheduleCard } from './WordScheduleCard';

const MODE_NOTICE_TEXT = 'The word bank is saved on this device only.';
const NOT_FOUND_MESSAGE = 'Not found in the dictionary. The word stays without data.';

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
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
    actionText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    body: {
      gap: 16,
      paddingBottom: 32,
    },
    wordBlock: {
      gap: 4,
    },
    wordRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    wordText: {
      fontSize: 34,
      fontWeight: '700',
      color: c.textPrimary,
      flexShrink: 1,
    },
    playButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    phonetics: {
      fontSize: 16,
      color: c.textMuted,
    },
    sourceLine: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
    },
    section: {
      gap: 8,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    actionRow: {
      flexDirection: 'row',
      gap: 10,
      flexWrap: 'wrap',
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    primaryActionButton: {
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    dangerActionButton: {
      borderColor: c.danger,
    },
    actionButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.textPrimary,
    },
    actionButtonTextLight: {
      fontSize: 14,
      fontWeight: '600',
      color: c.onPrimary,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    feedbackText: {
      fontSize: 13,
      color: c.textSecondary,
    },
    errorText: {
      fontSize: 13,
      color: c.errorText,
    },
    // --- Change-review modal (TASK-WB-014) ---
    pressedFade: {
      opacity: 0.9,
    },
  });
}

interface WordDetailScreenInternalProps extends WordDetailScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function WordDetailScreen({
  route,
  navigation,
  speech = getSpeechEngine(),
}: WordDetailScreenInternalProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const wordId = route.params.wordId;

  const [word, setWord] = useState<WordRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [fetching, setFetching] = useState(false);
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Enrichment (TASK-WB-014): the AI proposes a replacement, the learner
  // reviews it side by side with the old data and applies or cancels.
  const [enriching, setEnriching] = useState(false);
  const [proposal, setProposal] = useState<WordSense[] | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const { speakingId, speak, stop } = useSpeechPlayback(speech);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadWord = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const db = await getLocalDatabase();
      const record = await getWordById(db, wordId);
      if (!record) {
        throw new Error('This word no longer exists.');
      }
      setWord(record);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverMode, wordId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadWord();
  }, [loadWord, reloadKey]);

  // Re-read on focus so enrichment/fetch results from child flows show up.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (!serverMode) {
        loadWord();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadWord, serverMode]);

  // TTS must stop when the screen loses focus.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('blur', () => {
      stop();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, stop]);

  const handlePlay = useCallback(() => {
    if (!word) {
      return;
    }
    if (speakingId === word.id) {
      stop();
      return;
    }
    speak(word.id, word.text);
  }, [word, speakingId, speak, stop]);

  /** The one path that resolves a dataless word (§2.4, §2.8). */
  const handleFetchDictionaryData = useCallback(async () => {
    if (!word || fetching) {
      return;
    }
    setFetching(true);
    setFetchMessage(null);
    setFetchError(null);
    try {
      const outcome = await lookupDictionaryWord(word.text, (input, init) => fetch(input, init));
      if (outcome.outcome === 'found') {
        const db = await getLocalDatabase();
        const updated = await fillWordDictionaryData(db, word.id, {
          senses_json: outcome.senses,
          phonetics_json: outcome.phonetics,
        });
        if (updated) {
          setWord(updated);
        }
        setFetchMessage('Dictionary data saved.');
      } else if (outcome.outcome === 'not-found') {
        setFetchMessage(NOT_FOUND_MESSAGE);
      } else {
        setFetchError('The dictionary is unreachable right now. Try again later.');
      }
    } catch (err) {
      setFetchError(describeError(err));
    } finally {
      setFetching(false);
    }
  }, [word, fetching]);

  /**
   * Run one enrichment completion. The proposal is returned without writing;
   * the modal renders old vs new and the learner decides.
   */
  const handleEnrich = useCallback(async () => {
    if (!word || enriching) {
      return;
    }
    setEnriching(true);
    setEnrichError(null);
    try {
      const config = await loadServerlessConfig();
      if (!config) {
        setEnrichError('Add your provider API key in Settings to enrich words.');
        return;
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const topic = await getWordTopicById(db, word.topic_id);
      if (!topic) {
        throw new Error('This topic no longer exists.');
      }
      const proposed = await enrichWord(db, request => client.complete(request), {
        word,
        topic,
      });
      setProposal(proposed);
    } catch (err) {
      setEnrichError(describeError(err));
    } finally {
      setEnriching(false);
    }
  }, [word, enriching]);

  /** Apply the approved proposal: one wholesale senses write; FSRS untouched. */
  const handleApplyEnrichment = useCallback(async () => {
    if (!word || proposal === null || applying) {
      return;
    }
    setApplying(true);
    setEnrichError(null);
    try {
      const db = await getLocalDatabase();
      const updated = await applyWordEnrichment(db, word.id, proposal, new Date().toISOString());
      if (updated) {
        setWord(updated);
      }
      setProposal(null);
    } catch (err) {
      setEnrichError(describeError(err));
    } finally {
      setApplying(false);
    }
  }, [word, proposal, applying]);

  /** Cancel writes nothing. */
  const handleCancelEnrichment = useCallback(() => {
    if (applying) {
      return;
    }
    setProposal(null);
    setEnrichError(null);
  }, [applying]);

  const confirmDelete = useCallback(async () => {
    if (!word || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const db = await getLocalDatabase();
      await deleteWord(db, word.id);
      setDeleteOpen(false);
      stop();
      navigation.goBack();
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  }, [word, deleting, navigation, stop]);

  const hasData = word?.data_status === 'complete';

  return (
    <Screen style={styles.container} testID="word-detail-screen">
      <ScreenTitleBar
        title="Word"
        onBack={() => navigation.goBack()}
        backTestID="word-detail-back"
      />

      {serverMode ? (
        <View style={styles.centered} testID="word-detail-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="word-detail-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError || !word ? (
        <View style={styles.centered} testID="word-detail-error">
          <Text role="alert" style={styles.stateText}>
            {loadError ?? 'This word no longer exists.'}
          </Text>
          <Pressable testID="word-detail-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScreenScrollView>
          <View style={styles.body}>
            <View style={styles.wordBlock}>
              <View style={styles.wordRow}>
                {/* Selectable matches the practice screen's revealed word:
                    long-press copies the word natively. */}
                <Text selectable style={styles.wordText} testID="word-detail-word">
                  {word.text}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${word.text}`}
                  accessibilityState={{ busy: speakingId === word.id }}
                  testID="word-detail-play"
                  onPress={handlePlay}
                  style={({ pressed }) => [styles.playButton, pressed && styles.pressedFade]}>
                  <Icon
                    name={speakingId === word.id ? 'speaker' : 'play'}
                    size={20}
                    color={colors.accent}
                  />
                </Pressable>
              </View>
              {word.phonetics_json.length > 0 ? (
                <Text style={styles.phonetics} testID="word-detail-phonetics">
                  {word.phonetics_json.join('\n')}
                </Text>
              ) : null}
              <Text style={styles.sourceLine}>
                {word.data_source === 'enriched'
                  ? `AI-enriched${word.enriched_at ? ` · ${word.enriched_at.slice(0, 10)}` : ''}`
                  : word.data_status === 'missing'
                    ? 'No dictionary data yet'
                    : 'From the Free Dictionary API'}
              </Text>
            </View>

            <View style={styles.actionRow}>
              {!hasData ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: fetching, busy: fetching }}
                  testID="word-detail-fetch"
                  onPress={() => {
                    // handleFetchDictionaryData handles its own errors.
                    handleFetchDictionaryData();
                  }}
                  disabled={fetching}
                  style={({ pressed }) => [
                    styles.actionButton,
                    styles.primaryActionButton,
                    fetching && styles.buttonDisabled,
                    pressed && styles.pressedFade,
                  ]}>
                  {fetching ? (
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                  ) : (
                    <Icon name="refresh" size={16} color={colors.onPrimary} />
                  )}
                  <Text style={styles.actionButtonTextLight}>
                    {fetching ? 'Fetching…' : 'Fetch dictionary data'}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: enriching, busy: enriching }}
                testID="word-detail-enrich"
                onPress={() => {
                  // handleEnrich handles its own errors, so it never rejects.
                  handleEnrich();
                }}
                disabled={enriching}
                style={({ pressed }) => [
                  styles.actionButton,
                  enriching && styles.buttonDisabled,
                  pressed && styles.pressedFade,
                ]}>
                {enriching ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Icon name="generate" size={16} color={colors.accent} />
                )}
                <Text style={styles.actionButtonText}>{enriching ? 'Enriching…' : 'Enrich'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                testID="word-detail-delete"
                onPress={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.dangerActionButton,
                  pressed && styles.pressedFade,
                ]}>
                <Icon name="trash" size={16} color={colors.danger} />
                <Text style={styles.actionButtonText}>Delete</Text>
              </Pressable>
            </View>

            {fetchMessage ? (
              <Text style={styles.feedbackText} testID="word-detail-fetch-message">
                {fetchMessage}
              </Text>
            ) : null}
            {fetchError ? (
              <Text role="alert" style={styles.errorText} testID="word-detail-fetch-error">
                {fetchError}
              </Text>
            ) : null}
            {enrichError ? (
              <Text role="alert" style={styles.errorText} testID="word-detail-enrich-error">
                {enrichError}
              </Text>
            ) : null}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Meanings</Text>
              {word.senses_json.length === 0 ? (
                <Text style={styles.stateText} testID="word-detail-no-senses">
                  No dictionary data yet. Use “Fetch dictionary data” to fill it in.
                </Text>
              ) : (
                <WordSenseList senses={word.senses_json} />
              )}
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Schedule</Text>
              <WordScheduleCard word={word} />
            </View>
          </View>
        </ScreenScrollView>
      )}

      {/* Change-review modal (TASK-WB-014): current vs proposed, paired by
          sense-group index and rendered as aligned rows inside a scrollable
          list so the Apply/Cancel actions are always reachable. */}
      <WordEnrichReviewModal
        proposal={proposal}
        currentSenses={word?.senses_json ?? []}
        applying={applying}
        error={enrichError}
        onCancel={handleCancelEnrichment}
        onApply={() => {
          // handleApplyEnrichment handles its own errors, so it never rejects.
          handleApplyEnrichment();
        }}
      />

      {/* Delete confirmation. */}
      <ConfirmModal
        visible={deleteOpen}
        title="Delete word?"
        message={`"${word?.text ?? ''}" and its practice history will be permanently deleted.`}
        busy={deleting}
        error={deleteError}
        onCancel={() => {
          if (!deleting) {
            setDeleteOpen(false);
          }
        }}
        onConfirm={() => {
          // confirmDelete handles its own errors, so it never rejects.
          confirmDelete();
        }}
        testID="word-detail-delete"
      />
    </Screen>
  );
}
