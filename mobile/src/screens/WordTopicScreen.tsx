/**
 * One word topic's bank (WORD_BANK_V1 TASK-WB-009, §2.8).
 *
 * Shows the topic's learner-context description, a client-side search box over
 * the word list (normalized substring match, live count, "no words match"
 * state), and the words themselves with their primary part of speech, a
 * due/status hint, device-TTS playback and a confirmed delete. Tapping a row
 * opens Word detail.
 *
 * "+ Generate" asks the AI for a user-typed number of words (1–30, default 10)
 * and runs the generation pipeline (TASK-WB-004): the AI picks the words, the
 * Free Dictionary API fills the verified data, and the summary distinguishes
 * kept-with-data, kept-without-data (dictionary unavailable — fetch later from
 * Word detail) and not-found words.
 *
 * Practice unlocks at 5+ words through the shared `canPractice` rule; while
 * disabled the button explains how many more words are needed.
 *
 * Audio follows the `useSpeechPlayback` contract: one playback at a time,
 * silenced on blur and unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Icon } from '../components/Icon';
import { SCREEN_GUTTER, Screen, ScreenHeader, ScreenList } from '../components/ScreenLayout';
import { getLocalDatabase } from '../db/database';
import {
  deleteWord,
  getWordTopicById,
  listWordsByTopic,
} from '../db/wordRepository';
import type { WordRecord, WordTopicRecord } from '../db/types';
import { useApplicationMode } from '../mode/ModeContext';
import type { WordTopicScreenProps } from '../navigation/types';
import {
  MAX_WORD_COUNT,
  MIN_WORD_COUNT,
  generateTopicWords,
  type WordGenerationResult,
} from '../serverless/wordGeneration';
import { lookupDictionaryWord } from '../serverless/dictionaryApi';
import { createProviderClient } from '../serverless/providerRegistry';
import { loadServerlessConfig } from '../serverless/settings';
import { normalizeWordText } from '../srs/normalizeWord';
import { canPractice } from '../srs/session';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';

const MODE_NOTICE_TEXT = 'The word bank is saved on this device only.';
const PROVIDER_MISSING_MESSAGE = 'Add your provider API key in Settings to generate words.';
const DEFAULT_GENERATION_COUNT = 10;

/** Human message for any error the screen surfaces. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 8,
    },
    headerTexts: {
      flex: 1,
      gap: 2,
    },
    title: {
      fontSize: 24,
      fontWeight: '700',
      color: c.textPrimary,
    },
    description: {
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
    },
    actionRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 12,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    primaryActionButton: {
      backgroundColor: c.primary,
      borderColor: c.primary,
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
    actionButtonDisabled: {
      opacity: 0.5,
    },
    practiceHint: {
      fontSize: 12,
      color: c.textMuted,
      marginTop: 6,
    },
    searchInput: {
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 15,
      color: c.textPrimary,
      marginBottom: 10,
    },
    searchCount: {
      fontSize: 12,
      color: c.textMuted,
      marginBottom: 8,
    },
    rowGroup: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingLeft: 16,
      paddingRight: 6,
    },
    rowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    rowText: {
      flex: 1,
      gap: 1,
    },
    rowTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.textPrimary,
    },
    rowSub: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    posLabel: {
      fontSize: 12,
      color: c.textMuted,
      fontStyle: 'italic',
    },
    statusHint: {
      fontSize: 11,
      fontWeight: '600',
      color: c.textMuted,
      backgroundColor: c.background,
      borderColor: c.borderStrong,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: 'hidden',
    },
    statusDue: {
      color: c.onPrimary,
      backgroundColor: c.primary,
      borderColor: c.primary,
    },
    statusMissing: {
      color: c.errorText,
      borderColor: c.errorText,
    },
    rowIconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.border,
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
    errorText: {
      color: c.errorText,
      fontSize: 13,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
    successText: {
      color: c.primary,
      fontSize: 13,
      textAlign: 'center',
      paddingHorizontal: 24,
      marginBottom: 8,
    },
    actionText: {
      color: c.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    pressedFade: {
      opacity: 0.9,
    },
    // --- Modals ---
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: SCREEN_GUTTER,
    },
    modalCard: {
      width: '100%',
      maxWidth: 420,
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
    hint: {
      fontSize: 12,
      lineHeight: 17,
      color: c.textMuted,
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
    generatingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
  });
}

/** Parse the typed count defensively; invalid input keeps the default. */
export function parseGenerationCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < MIN_WORD_COUNT || parsed > MAX_WORD_COUNT) {
    return null;
  }
  return parsed;
}

type WordRowProps = {
  item: WordRecord;
  onPress: (item: WordRecord) => void;
  onSpeak: (item: WordRecord) => void;
  onDelete: (item: WordRecord) => void;
  speaking: boolean;
  deleting: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
};

/** The first POS label of the stored senses, or a placeholder. */
export function primaryPosLabel(word: WordRecord): string {
  return word.senses_json[0]?.partOfSpeech ?? '';
}

/** Short per-row schedule hint: due, in-learning, scheduled, or no data. */
export function wordStatusHint(word: WordRecord, nowMs: number): {
  label: string;
  due: boolean;
  missing: boolean;
} {
  if (word.data_status === 'missing') {
    return { label: 'no data', due: false, missing: true };
  }
  const dueMs = Date.parse(word.due_at);
  if (Number.isFinite(dueMs) && dueMs <= nowMs && !word.suspended) {
    return { label: 'due', due: true, missing: false };
  }
  if (word.suspended) {
    return { label: 'suspended', due: false, missing: false };
  }
  if (word.state === 'new') {
    return { label: 'new', due: false, missing: false };
  }
  return { label: word.state === 'review' ? 'scheduled' : 'learning', due: false, missing: false };
}

function WordRow({ item, onPress, onSpeak, onDelete, speaking, deleting, colors, styles }: WordRowProps) {
  const pos = primaryPosLabel(item);
  const hint = wordStatusHint(item, Date.now());
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.text}`}
        testID={`word-${item.id}`}
        onPress={() => onPress(item)}
        style={({ pressed }) => [styles.rowMain, pressed && styles.pressedFade]}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.text}
          </Text>
          <View style={styles.rowSub}>
            {pos ? (
              <Text style={styles.posLabel} numberOfLines={1}>
                {pos}
              </Text>
            ) : null}
            <Text
              style={[styles.statusHint, hint.due && styles.statusDue, hint.missing && styles.statusMissing]}
              testID={`word-${item.id}-status`}>
              {hint.label}
            </Text>
          </View>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Play ${item.text}`}
        accessibilityState={{ busy: speaking }}
        testID={`word-speak-${item.id}`}
        onPress={() => onSpeak(item)}
        style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
        <Icon name={speaking ? 'speaker' : 'play'} size={18} color={colors.accent} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${item.text}`}
        accessibilityState={{ disabled: deleting, busy: deleting }}
        testID={`word-delete-${item.id}`}
        onPress={() => onDelete(item)}
        disabled={deleting}
        style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
        {deleting ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Icon name="trash" size={18} color={colors.danger} />
        )}
      </Pressable>
    </View>
  );
}

interface WordTopicScreenInternalProps extends WordTopicScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function WordTopicScreen({ route, navigation, speech = getSpeechEngine() }: WordTopicScreenInternalProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topicId = route.params.topicId;

  const [topic, setTopic] = useState<WordTopicRecord | null>(null);
  const [words, setWords] = useState<WordRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const [search, setSearch] = useState('');

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateCountText, setGenerateCountText] = useState(String(DEFAULT_GENERATION_COUNT));
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WordGenerationResult | null>(null);
  // Synchronous guard: a double tap in the same tick must not start two AI requests.
  const generatingRef = useRef(false);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WordRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { speakingId, speak, stop } = useSpeechPlayback(speech);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadTopic = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const db = await getLocalDatabase();
      const [record, list] = await Promise.all([
        getWordTopicById(db, topicId),
        listWordsByTopic(db, topicId),
      ]);
      if (!record) {
        throw new Error('This topic no longer exists.');
      }
      setTopic(record);
      setWords(list);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverMode, topicId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadTopic();
  }, [loadTopic, reloadKey]);

  // Returning from practice or detail changes schedules and counts; re-read
  // on focus so due hints and the practice unlock state stay truthful.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (!serverMode) {
        loadTopic();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadTopic, serverMode]);

  // TTS must never continue after the screen loses focus. Unmount silencing
  // lives inside useSpeechPlayback.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('blur', () => {
      stop();
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, stop]);

  const handleSpeak = useCallback(
    (word: WordRecord) => {
      if (speakingId === word.id) {
        stop();
        return;
      }
      speak(word.id, word.text);
    },
    [speakingId, speak, stop],
  );

  const handleOpenWord = useCallback(
    (word: WordRecord) => {
      stop();
      navigation.navigate('WordDetail', { wordId: word.id });
    },
    [navigation, stop],
  );

  // --- Search ---------------------------------------------------------------
  const filteredWords = useMemo(() => {
    const query = normalizeWordText(search);
    if (!query) {
      return words;
    }
    return words.filter(word => word.normalized_text.includes(query));
  }, [words, search]);

  // --- Generate ---------------------------------------------------------------
  const parsedCount = parseGenerationCount(generateCountText);
  const countInvalid = generateCountText.trim() !== '' && parsedCount === null;

  const handleGenerate = useCallback(async () => {
    if (generatingRef.current || parsedCount === null) {
      return;
    }
    generatingRef.current = true;
    setGenerating(true);
    setGenerateError(null);
    setActionError(null);
    setSummary(null);
    try {
      const config = await loadServerlessConfig();
      if (!config) {
        setGenerateError(PROVIDER_MISSING_MESSAGE);
        return;
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const record = await getWordTopicById(db, topicId);
      if (!record) {
        throw new Error('This topic no longer exists.');
      }
      const existing = await listWordsByTopic(db, topicId);
      const result = await generateTopicWords(
        db,
        request => client.complete(request),
        word => lookupDictionaryWord(word, fetch),
        {
          topic: record,
          count: parsedCount,
          existingWords: existing.map(word => word.text),
        },
      );
      setSummary(result);
      setGenerateOpen(false);
      await loadTopic();
    } catch (err) {
      setGenerateError(`Could not generate words: ${describeError(err)}`);
    } finally {
      generatingRef.current = false;
      setGenerating(false);
    }
  }, [parsedCount, topicId, loadTopic]);

  // --- Delete -----------------------------------------------------------------
  const handleDeleteRequest = useCallback((word: WordRecord) => {
    if (deletingId !== null) {
      return;
    }
    setDeleteError(null);
    setDeleteTarget(word);
  }, [deletingId]);

  const cancelDelete = useCallback(() => {
    if (deletingId !== null) {
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deletingId]);

  const confirmDelete = useCallback(async () => {
    if (deletingId !== null || deleteTarget === null) {
      return;
    }
    const target = deleteTarget;
    setDeletingId(target.id);
    setDeleteError(null);
    try {
      const db = await getLocalDatabase();
      await deleteWord(db, target.id);
      // Remove from the underlying list, not just the filtered view.
      setWords(previous => previous.filter(word => word.id !== target.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(`Could not delete the word: ${describeError(err)}`);
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, deleteTarget]);

  // --- Render -----------------------------------------------------------------
  const practiceUnlocked = canPractice(words.length);
  const wordsStillNeeded = Math.max(0, 5 - words.length);
  const description = topic?.description ?? '';
  const searchActive = normalizeWordText(search) !== '';

  const rowContent = ({ item, index }: { item: WordRecord; index: number }) => (
    <>
      {index > 0 ? <View style={styles.rowDivider} /> : null}
      <WordRow
        item={item}
        onPress={handleOpenWord}
        onSpeak={handleSpeak}
        onDelete={handleDeleteRequest}
        speaking={speakingId === item.id}
        deleting={deletingId === item.id}
        colors={colors}
        styles={styles}
      />
    </>
  );

  /** Actions, feedback, the search box and its count — above the word list. */
  const listHeader = (
    <>
      <View style={styles.actionRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Generate new words"
          testID="word-topic-generate"
          onPress={() => setGenerateOpen(true)}
          style={({ pressed }) => [
            styles.actionButton,
            styles.primaryActionButton,
            pressed && styles.pressedFade,
          ]}>
          <Icon name="generate" size={16} color={colors.onPrimary} />
          <Text style={styles.actionButtonTextLight}>Generate</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            practiceUnlocked ? 'Practice this topic' : `Add ${wordsStillNeeded} more words to practice`
          }
          accessibilityState={{ disabled: !practiceUnlocked }}
          testID="word-topic-practice"
          onPress={() => navigation.navigate('WordPractice', { topicId })}
          disabled={!practiceUnlocked}
          style={({ pressed }) => [
            styles.actionButton,
            !practiceUnlocked && styles.actionButtonDisabled,
            pressed && styles.pressedFade,
          ]}>
          <Icon name="target" size={16} color={practiceUnlocked ? colors.accent : colors.textMuted} />
          <Text style={styles.actionButtonText}>Practice</Text>
        </Pressable>
      </View>
      {!practiceUnlocked ? (
        <Text style={styles.practiceHint} testID="word-topic-practice-hint">
          Practice unlocks at 5 words — add {wordsStillNeeded} more.
        </Text>
      ) : null}

      {summary ? (
        <Text style={styles.successText} testID="word-topic-summary">
          {`Kept ${summary.keptWithData} word${summary.keptWithData === 1 ? '' : 's'} with dictionary` +
            ` data, ${summary.keptWithoutData} without data (fetch it later from Word detail), ` +
            `${summary.notFoundCount} not found in the dictionary.`}
        </Text>
      ) : null}
      {generateError ? (
        <Text role="alert" style={styles.errorText} testID="word-topic-generate-error">
          {generateError}
        </Text>
      ) : null}
      {actionError ? (
        <Text role="alert" style={styles.errorText} testID="word-topic-action-error">
          {actionError}
        </Text>
      ) : null}

      <TextInput
        placeholder="Search words"
        value={search}
        onChangeText={setSearch}
        style={styles.searchInput}
        testID="word-topic-search"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {searchActive ? (
        <Text style={styles.searchCount} testID="word-topic-search-count">
          {filteredWords.length} match{filteredWords.length === 1 ? '' : 'es'}
        </Text>
      ) : null}
    </>
  );

  return (
    <Screen style={styles.container} testID="word-topic-screen">
      <ScreenHeader style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to topics"
          testID="word-topic-back"
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.rowIconButton, pressed && styles.pressedFade]}>
          <Icon name="arrowLeft" color={colors.accent} />
        </Pressable>
        <Pressable
          style={styles.headerTexts}
          onPress={() => setDescriptionExpanded(value => !value)}
          disabled={description.length < 80}
          testID="word-topic-header">
          <Text style={styles.title} numberOfLines={1}>
            {topic?.title ?? 'Topic'}
          </Text>
          {description ? (
            <Text
              style={styles.description}
              numberOfLines={descriptionExpanded ? undefined : 2}
              testID="word-topic-description">
              {description}
            </Text>
          ) : null}
        </Pressable>
      </ScreenHeader>

      {serverMode ? (
        <View style={styles.centered} testID="word-topic-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="word-topic-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError ? (
        <View style={styles.centered} testID="word-topic-error">
          <Text role="alert" style={styles.errorText}>
            {loadError}
          </Text>
          <Pressable testID="word-topic-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScreenList
          data={filteredWords}
          keyExtractor={item => String(item.id)}
          renderItem={rowContent}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            words.length === 0 ? (
              <View style={styles.centered} testID="word-topic-empty">
                <Text style={styles.stateText}>
                  No words yet. Tap Generate to let the AI pick words for this topic.
                </Text>
              </View>
            ) : (
              <View style={styles.centered} testID="word-topic-no-match">
                <Text style={styles.stateText}>No words match your search.</Text>
              </View>
            )
          }
          onRefresh={() => setReloadKey(key => key + 1)}
          refreshing={loading}
        />
      )}

      {/* Generate form. */}
      <Modal
        animationType="fade"
        onRequestClose={() => {
          if (!generating) {
            setGenerateOpen(false);
          }
        }}
        testID="word-generate-modal"
        transparent
        visible={generateOpen}>
        <View style={styles.backdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.modalTitle} testID="word-generate-title">
              Generate words
            </Text>
            <Text style={styles.hint}>
              The AI picks the words; meanings and IPA come from the Free Dictionary API.
            </Text>
            <Text style={styles.inputLabel}>How many words (1–30)?</Text>
            <TextInput
              value={generateCountText}
              onChangeText={setGenerateCountText}
              style={styles.input}
              testID="word-generate-count"
              keyboardType="number-pad"
              autoFocus
            />
            {countInvalid ? (
              <Text role="alert" style={styles.modalError} testID="word-generate-count-error">
                Enter a number between 1 and 30.
              </Text>
            ) : null}
            <View style={styles.modalFooter}>
              <Pressable
                accessibilityRole="button"
                testID="word-generate-cancel"
                onPress={() => {
                  if (!generating) {
                    setGenerateOpen(false);
                  }
                }}
                disabled={generating}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalCancelButton,
                  generating && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: generating || parsedCount === null, busy: generating }}
                testID="word-generate-submit"
                onPress={() => {
                  // handleGenerate handles its own errors, so it never rejects.
                  handleGenerate();
                }}
                disabled={generating || parsedCount === null}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalPrimaryButton,
                  (generating || parsedCount === null) && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                {generating ? (
                  <View style={styles.generatingRow}>
                    <ActivityIndicator size="small" color={colors.onPrimary} />
                    <Text style={styles.modalPrimaryText}>Generating…</Text>
                  </View>
                ) : (
                  <Text style={styles.modalPrimaryText}>Generate</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Delete confirmation. */}
      <Modal
        animationType="fade"
        onRequestClose={cancelDelete}
        testID="word-delete-modal"
        transparent
        visible={deleteTarget !== null}>
        <View style={styles.backdrop}>
          <View style={styles.modalCard} accessibilityViewIsModal>
            <Text style={styles.modalTitle} testID="word-delete-title">
              Delete word?
            </Text>
            <Text style={styles.hint} testID="word-delete-message">
              {`"${deleteTarget?.text ?? ''}" and its practice history will be permanently deleted.`}
            </Text>
            {deleteError ? (
              <Text role="alert" style={styles.modalError} testID="word-delete-error">
                {deleteError}
              </Text>
            ) : null}
            <View style={styles.modalFooter}>
              <Pressable
                accessibilityRole="button"
                testID="word-delete-cancel"
                onPress={cancelDelete}
                disabled={deletingId !== null}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalCancelButton,
                  deletingId !== null && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: deletingId !== null, busy: deletingId !== null }}
                testID="word-delete-confirm"
                onPress={() => {
                  // confirmDelete handles its own errors, so it never rejects.
                  confirmDelete();
                }}
                disabled={deletingId !== null}
                style={({ pressed }) => [
                  styles.modalButton,
                  styles.modalDangerButton,
                  deletingId !== null && styles.modalDisabled,
                  pressed && styles.modalDisabled,
                ]}>
                {deletingId !== null ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalPrimaryText}>Delete</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
