/**
 * Automatic grammar checking of newly sent user messages (opt-in).
 *
 * When the user enables "Grammar auto-check" in Settings, every user
 * message SENT while the chat screen is open is checked through the same
 * improvement pipeline the manual action uses — server mode asks the
 * backend improvement endpoint (TASK-063), serverless mode runs the local
 * provider port (TASK-089). One request per message, exactly like a manual
 * improvement: this is why the setting warns that it consumes extra
 * tokens and why it defaults to off.
 *
 * Results are PERSISTED per message and reloaded with the conversation:
 * - Server mode — the backend stores the improvement on the message row and
 *   embeds it in every message payload (`improvement` field).
 * - Serverless mode — the local SQLite row stores it (migration v2).
 * Once a check exists for a message, neither the endpoint nor the local
 * service is called again for that message — reopening the conversation (or
 * the app) restores the badge and the suggestion from the store with zero
 * provider traffic. Only the LIVE view (this hook's cache) adds nothing: it
 * is seeded from the persisted rows on load.
 *
 * Display mapping: severity "none" → no badge; "minor" → small warning
 * badge; "critical" → error badge. Badges hand the cached result to the
 * improvement sheet, so showing the suggestion never performs a second API
 * call. Only messages that ARRIVE while the hook watches are checked — the
 * already-checked history is seeded as settled, so opening old chats never
 * triggers a burst of hidden provider requests. Failures are silent (the
 * badge simply never appears); the manual "Improve my English" action
 * remains available with its explicit error surface.
 */
import {useCallback, useEffect, useRef, useState} from 'react';

import type {ChatMessage, ImprovementSeverity, MessageImprovement} from '../api/sessions';
import {improveMessage} from '../api/sessions';
import type {AuthedRequester} from '../auth/authedRequest';
import {getLocalDatabase} from '../db/database';
import {getLearningProfile} from '../db/profileStore';
import {saveMessageImprovement} from '../db/messageStore';
import type {ApplicationMode} from '../mode/types';
import {generateImprovement} from '../serverless/improvement';
import {createProviderClient} from '../serverless/providerRegistry';
import {loadServerlessOpenRouterConfig} from '../serverless/settings';

/** One finished check, tied to its source message. */
export type GrammarCheckResult = MessageImprovement & {messageId: number};

/** Severity values that render a badge (severity "none" stays invisible). */
export function badgeSeverity(severity: ImprovementSeverity): ImprovementSeverity | null {
  return severity === 'none' ? null : severity;
}

export interface UseGrammarAutoCheckOptions {
  sessionId: number | undefined;
  mode: ApplicationMode;
  authedRequest: AuthedRequester;
  /** Live conversation rows; newly arrived user messages trigger checks. */
  messages: ChatMessage[];
  /**
   * Master switch (Settings). Messages that arrive while it is off are
   * permanently skipped — turning it on never retro-checks history.
   */
  enabled: boolean;
  /**
   * True once the session's initial history load has settled; its rows are
   * seeded as "already settled" so only subsequently arriving messages are
   * auto-checked.
   */
  historySettled: boolean;
}

export interface UseGrammarAutoCheckResult {
  /** Finished checks keyed by message id (only checked messages appear). */
  checks: Record<number, GrammarCheckResult>;
  /** Stable accessor for one message's check result (null when none). */
  getResult(messageId: number): GrammarCheckResult | null;
}

/** Collect the persisted improvement of one row, if it has one. */
function persistedCheckOf(message: ChatMessage): GrammarCheckResult | null {
  if (
    message.role === 'user' &&
    message.improvement &&
    message.improvement.improved.trim().length > 0
  ) {
    return {...message.improvement, messageId: message.id};
  }
  return null;
}

export function useGrammarAutoCheck(
  options: UseGrammarAutoCheckOptions,
): UseGrammarAutoCheckResult {
  const {sessionId, mode, authedRequest, messages, enabled, historySettled} = options;

  const [checks, setChecks] = useState<Record<number, GrammarCheckResult>>({});
  // Ref mirror of `checks` so the badge press handler can read results
  // through a stable callback without re-creating on every check.
  const checksRef = useRef<Record<number, GrammarCheckResult>>({});
  const applyChecks = useCallback(
    (next: Record<number, GrammarCheckResult>) => {
      checksRef.current = next;
      setChecks(next);
    },
    [],
  );
  const mergeChecks = useCallback(
    (additions: Record<number, GrammarCheckResult>) => {
      applyChecks({...checksRef.current, ...additions});
    },
    [applyChecks],
  );

  // Message ids that never trigger auto-checks: the seeded history plus
  // every row already scanned (checked or skipped at arrival time).
  const settledIdsRef = useRef<Set<number>>(new Set());
  const inFlightRef = useRef<Set<number>>(new Set());
  // Session generation: results from an abandoned session never apply.
  const epochRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  /** Session switch (or landing reset): drop every trace and start over. */
  useEffect(() => {
    epochRef.current += 1;
    settledIdsRef.current = new Set();
    inFlightRef.current = new Set();
    applyChecks({});
  }, [sessionId, applyChecks]);

  /** Seed the history as settled and restore its persisted checks. */
  const seededSessionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!historySettled || sessionId === undefined) {
      return;
    }
    if (seededSessionRef.current === sessionId) {
      return;
    }
    seededSessionRef.current = sessionId;
    settledIdsRef.current = new Set(messages.map(message => message.id));
    const restored: Record<number, GrammarCheckResult> = {};
    for (const message of messages) {
      const check = persistedCheckOf(message);
      if (check) {
        restored[message.id] = check;
      }
    }
    if (Object.keys(restored).length > 0) {
      mergeChecks(restored);
    }
    // `messages` is deliberately not a dependency: the seed captures the
    // snapshot that arrives together with historySettled; later snapshots
    // are handled by the watch effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySettled, sessionId, mergeChecks]);

  /**
   * Run the check for one message through the active mode's improvement
   * pipeline and persist the result onto the message's store. Stale
   * outcomes (session switched or feature disabled while in flight) are
   * dropped; failures stay silent.
   */
  const checkMessage = useCallback(
    async (sid: number, messageId: number, content: string, epoch: number) => {
      const inFlight = inFlightRef.current;
      if (inFlight.has(messageId)) {
        return;
      }
      inFlight.add(messageId);
      try {
        let result: MessageImprovement;
        if (mode === 'serverless') {
          const config = await loadServerlessOpenRouterConfig();
          if (!config) {
            return;
          }
          const client = createProviderClient(config);
          const db = await getLocalDatabase();
          const profile = await getLearningProfile(db);
          result = await generateImprovement(client, {
            level: profile.level,
            originalMessage: content,
          });
          // Persist BEFORE surfacing: a crash right after the request must
          // never lose the paid-for result (it would re-cost on next visit).
          await saveMessageImprovement(db, messageId, {
            improved: result.improved,
            explanation: result.explanation,
            severity: result.severity,
          });
        } else {
          // Server mode: the endpoint itself caches the improvement on the
          // message row and returns it verbatim on every later call.
          result = await improveMessage(authedRequest, sid, messageId);
        }
        if (epochRef.current !== epoch || sessionIdRef.current !== sid) {
          return;
        }
        if (!enabledRef.current) {
          return;
        }
        mergeChecks({[messageId]: {...result, messageId}});
      } catch {
        // Silent by design: an auto-check failure must never disturb the
        // chat; the manual improvement action surfaces errors explicitly.
      } finally {
        inFlight.delete(messageId);
      }
    },
    [mergeChecks, authedRequest, mode],
  );

  /** Watch the live rows: scan arrivals, check the qualifying ones. */
  useEffect(() => {
    if (seededSessionRef.current !== sessionId) {
      return;
    }
    const settled = settledIdsRef.current;
    const arrivals: ChatMessage[] = [];
    for (const message of messages) {
      if (settled.has(message.id)) {
        continue;
      }
      // Mark every arrival as settled immediately: each row is considered
      // exactly once, at the moment it first appears.
      settled.add(message.id);
      if (
        message.id > 0 &&
        message.role === 'user' &&
        message.status === 'complete' &&
        message.content.trim().length > 0
      ) {
        arrivals.push(message);
      }
    }
    if (!enabled || arrivals.length === 0) {
      return;
    }
    const epoch = epochRef.current;
    const sid = sessionId;
    for (const arrival of arrivals) {
      // Fire-and-forget like the post-turn summary maintenance: failures
      // are handled (silently) inside checkMessage itself.
      checkMessage(sid, arrival.id, arrival.content, epoch).catch(() => undefined);
    }
  }, [messages, enabled, sessionId, checkMessage]);

  const getResult = useCallback(
    (messageId: number): GrammarCheckResult | null => checksRef.current[messageId] ?? null,
    [],
  );

  return {checks, getResult};
}
