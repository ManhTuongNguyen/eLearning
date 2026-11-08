/**
 * Sentence detail screen (MANUAL_SENTENCES).
 *
 * Shows everything stored for one real-life sentence: the sentence in large
 * type with a device-TTS play button, every meaning, situation, alternative
 * phrasing, register/nuance note and grammar note. From here the learner can
 * edit the sentence, enrich it through their own serverless provider (the AI
 * proposal is reviewed old-vs-new before anything is written), or delete it.
 *
 * The screen reads from the repository on focus; the sentence text and its
 * FSRS schedule are never changed by enrichment.
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
import { getLocalDatabase } from '../db/database';
import {
  applySentenceContent,
  deleteSentence,
  getSentenceById,
  getSentenceTopicById,
} from '../db/sentenceRepository';
import type { SentenceRecord } from '../db/types';
import { useApplicationMode } from '../mode/ModeContext';
import type { SentenceDetailScreenProps } from '../navigation/types';
import { createProviderClient } from '../serverless/providerRegistry';
import { enrichSentence, type SentenceEnrichmentProposal } from '../serverless/sentenceEnrichment';
import { loadServerlessConfig } from '../serverless/settings';
import type { ThemeColors } from '../theme/colors';
import { useTheme } from '../theme/ThemeContext';
import type { TextToSpeechEngine } from '../tts/textToSpeech';
import { getSpeechEngine } from '../tts/textToSpeech';
import { useSpeechPlayback } from '../tts/useSpeechPlayback';
import { describeError } from '../utils/describeError';
import { SentenceEnrichReviewModal } from './SentenceEnrichReviewModal';

const MODE_NOTICE_TEXT = 'Real-life sentences are saved on this device only.';

interface ContentSection {
  key: keyof Pick<
    SentenceRecord,
    'meanings' | 'situations' | 'alternatives' | 'registers' | 'grammar_notes'
  >;
  title: string;
}

const SECTIONS: readonly ContentSection[] = [
  { key: 'meanings', title: 'Meanings' },
  { key: 'situations', title: 'Situations' },
  { key: 'alternatives', title: 'Other ways to say it' },
  { key: 'registers', title: 'Register / nuance' },
  { key: 'grammar_notes', title: 'Grammar / structure' },
];

export function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
      paddingTop: SCREEN_TOP_SPACING,
    },
    body: {
      gap: 18,
      paddingBottom: 32,
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
    sentenceBlock: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    sentenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    sentenceText: {
      flex: 1,
      fontSize: 22,
      fontWeight: '700',
      lineHeight: 30,
      color: c.textPrimary,
    },
    playButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    playButtonActive: {
      backgroundColor: c.accentSoft,
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
    entryRow: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'flex-start',
    },
    entryBullet: {
      fontSize: 15,
      lineHeight: 22,
      color: c.primary,
      fontWeight: '700',
    },
    entryText: {
      flex: 1,
      fontSize: 15,
      lineHeight: 22,
      color: c.textPrimary,
    },
    emptyText: {
      fontSize: 14,
      color: c.textSecondary,
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
    errorText: {
      fontSize: 13,
      color: c.errorText,
    },
    pressedFade: {
      opacity: 0.9,
    },
  });
}

interface SentenceDetailScreenInternalProps extends SentenceDetailScreenProps {
  /** TTS seam; defaults to the active engine from the registry. */
  speech?: TextToSpeechEngine;
}

export function SentenceDetailScreen({
  route,
  navigation,
  speech = getSpeechEngine(),
}: SentenceDetailScreenInternalProps) {
  const { status: modeStatus, mode } = useApplicationMode();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const sentenceId = route.params.sentenceId;

  const [sentence, setSentence] = useState<SentenceRecord | null>(null);
  const [topicTitle, setTopicTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [enriching, setEnriching] = useState(false);
  const [proposal, setProposal] = useState<SentenceEnrichmentProposal | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { speakingId, speak, stop } = useSpeechPlayback(speech);

  const serverMode = modeStatus === 'ready' && mode === 'server';

  const loadSentence = useCallback(async () => {
    if (serverMode) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const db = await getLocalDatabase();
      const record = await getSentenceById(db, sentenceId);
      if (!record) {
        throw new Error('This sentence no longer exists.');
      }
      const topic = await getSentenceTopicById(db, record.topic_id);
      setSentence(record);
      setTopicTitle(topic?.title ?? '');
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverMode, sentenceId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is an intentional reload trigger
  useEffect(() => {
    loadSentence();
  }, [loadSentence, reloadKey]);

  // Returning from the edit screen must show the saved content.
  useEffect(() => {
    const unsubscribe = navigation.addListener?.('focus', () => {
      if (!serverMode) {
        loadSentence();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigation, loadSentence, serverMode]);

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
    if (!sentence) {
      return;
    }
    if (speakingId === sentence.id) {
      stop();
      return;
    }
    speak(sentence.id, sentence.text);
  }, [sentence, speakingId, speak, stop]);

  const handleEnrich = useCallback(async () => {
    if (!sentence || enriching) {
      return;
    }
    setEnriching(true);
    setEnrichError(null);
    try {
      const config = await loadServerlessConfig();
      if (!config) {
        setEnrichError('Add your provider API key in Settings to enrich sentences.');
        return;
      }
      const client = createProviderClient(config);
      const db = await getLocalDatabase();
      const topic = await getSentenceTopicById(db, sentence.topic_id);
      if (!topic) {
        throw new Error('This topic no longer exists.');
      }
      const proposed = await enrichSentence(db, request => client.complete(request), {
        sentence,
        topic,
      });
      setProposal(proposed);
    } catch (err) {
      setEnrichError(describeError(err));
    } finally {
      setEnriching(false);
    }
  }, [sentence, enriching]);

  /** Apply the approved proposal: content only, schedule untouched. */
  const handleApplyEnrichment = useCallback(async () => {
    if (!sentence || proposal === null || applying) {
      return;
    }
    setApplying(true);
    setEnrichError(null);
    try {
      const db = await getLocalDatabase();
      const updated = await applySentenceContent(db, sentence.id, proposal);
      if (updated) {
        setSentence(updated);
      }
      setProposal(null);
    } catch (err) {
      setEnrichError(describeError(err));
    } finally {
      setApplying(false);
    }
  }, [sentence, proposal, applying]);

  const cancelEnrichment = useCallback(() => {
    if (applying) {
      return;
    }
    setProposal(null);
    setEnrichError(null);
  }, [applying]);

  const confirmDelete = useCallback(async () => {
    if (!sentence || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const db = await getLocalDatabase();
      await deleteSentence(db, sentence.id);
      setDeleteOpen(false);
      stop();
      navigation.goBack();
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  }, [sentence, deleting, navigation, stop]);

  const renderEntries = (values: readonly string[]) =>
    values.map((value, index) => (
      <View key={value} style={styles.entryRow} testID={`sentence-detail-entry-${index}`}>
        {values.length > 1 ? <Text style={styles.entryBullet}>•</Text> : null}
        <Text style={styles.entryText} selectable>
          {value}
        </Text>
      </View>
    ));

  return (
    <Screen style={styles.container} testID="sentence-detail-screen">
      <ScreenTitleBar
        title={topicTitle || 'Sentence'}
        titleTestID="sentence-detail-title"
        onBack={() => navigation.goBack()}
        backTestID="sentence-detail-back"
      />

      {serverMode ? (
        <View style={styles.centered} testID="sentence-detail-mode-notice">
          <Text style={styles.stateText}>{MODE_NOTICE_TEXT}</Text>
        </View>
      ) : modeStatus !== 'ready' || loading ? (
        <View style={styles.centered} testID="sentence-detail-loading">
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : loadError || !sentence ? (
        <View style={styles.centered} testID="sentence-detail-error">
          <Text role="alert" style={styles.stateText}>
            {loadError ?? 'This sentence no longer exists.'}
          </Text>
          <Pressable testID="sentence-detail-retry" onPress={() => setReloadKey(key => key + 1)}>
            <Text style={styles.actionText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScreenScrollView contentContainerStyle={styles.body}>
          <View style={styles.sentenceBlock}>
            <View style={styles.sentenceRow}>
              <Text selectable style={styles.sentenceText} testID="sentence-detail-text">
                {sentence.text}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  speakingId === sentence.id
                    ? `Stop sentence ${sentence.text}`
                    : `Play sentence ${sentence.text}`
                }
                accessibilityState={{ busy: speakingId === sentence.id }}
                testID="sentence-detail-play"
                onPress={handlePlay}
                style={({ pressed }) => [
                  styles.playButton,
                  speakingId === sentence.id && styles.playButtonActive,
                  pressed && styles.pressedFade,
                ]}>
                <Icon
                  name={speakingId === sentence.id ? 'speaker' : 'play'}
                  size={20}
                  color={speakingId === sentence.id ? colors.primary : colors.accent}
                />
              </Pressable>
            </View>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: enriching, busy: enriching }}
              testID="sentence-detail-enrich"
              onPress={() => {
                // handleEnrich handles its own errors, so it never rejects.
                handleEnrich();
              }}
              disabled={enriching}
              style={({ pressed }) => [
                styles.actionButton,
                styles.primaryActionButton,
                enriching && styles.buttonDisabled,
                pressed && styles.pressedFade,
              ]}>
              {enriching ? (
                <ActivityIndicator size="small" color={colors.onPrimary} />
              ) : (
                <Icon name="generate" size={16} color={colors.onPrimary} />
              )}
              <Text style={styles.actionButtonTextLight}>
                {enriching ? 'Enriching...' : 'Enrich'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="sentence-detail-edit"
              onPress={() => navigation.navigate('SentenceEdit', { sentenceId })}
              style={({ pressed }) => [styles.actionButton, pressed && styles.pressedFade]}>
              <Icon name="edit" size={16} color={colors.textPrimary} />
              <Text style={styles.actionButtonText}>Edit</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="sentence-detail-delete"
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

          {enrichError ? (
            <Text role="alert" style={styles.errorText} testID="sentence-detail-enrich-error">
              {enrichError}
            </Text>
          ) : null}

          {SECTIONS.map(section => {
            const values = sentence[section.key] ?? [];
            return (
              <View
                key={section.key}
                style={styles.section}
                testID={`sentence-detail-${section.key}`}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {values.length === 0 ? (
                  <Text style={styles.emptyText}>None yet.</Text>
                ) : (
                  renderEntries(values)
                )}
              </View>
            );
          })}
        </ScreenScrollView>
      )}

      <SentenceEnrichReviewModal
        proposal={proposal}
        current={{
          meanings: sentence?.meanings ?? [],
          situations: sentence?.situations ?? [],
          alternatives: sentence?.alternatives ?? [],
          registers: sentence?.registers ?? [],
          grammar_notes: sentence?.grammar_notes ?? [],
        }}
        applying={applying}
        error={enrichError}
        onCancel={cancelEnrichment}
        onApply={() => {
          // handleApplyEnrichment handles its own errors, so it never rejects.
          handleApplyEnrichment();
        }}
      />

      <ConfirmModal
        visible={deleteOpen}
        title="Delete sentence?"
        message={`"${sentence?.text ?? ''}" and its practice history will be permanently deleted.`}
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
        testID="sentence-detail-delete-confirm"
      />
    </Screen>
  );
}
