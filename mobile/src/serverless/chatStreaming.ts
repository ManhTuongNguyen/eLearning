/**
 * Serverless chat streaming over direct OpenRouter (SPEC TASK-086).
 *
 * Mobile analogue of the backend application service in conversations/chat.py
 * (TASK-040/041/042), so both modes share one write-side chat contract:
 *
 * 1. The user message is validated and persisted locally together with its
 *    `pending` assistant generation slot — both rows inside ONE database
 *    transaction that also refreshes the session's recency stamp, exactly
 *    like the backend turn creation.
 * 2. The LLM completion request is assembled by an injected
 *    `buildRequest` seam INSIDE that same transaction (TASK-087 owns the
 *    real conversation-context strategy), so a failing assembly rolls the
 *    whole turn back and never leaves orphaned rows behind.
 * 3. The stream runs through the TASK-083 OpenRouter client. Non-terminal
 *    events (`start`, `delta`) are forwarded verbatim as they arrive;
 *    terminal outcomes are persisted onto the pending row FIRST and only
 *    then delivered downstream, mirroring backend `finalize_turn`: a
 *    consumer observing `completed` can rely on the full message already
 *    being committed. Partial output is never persisted as a complete
 *    message; a `failed` outcome marks only the status, keeping the row
 *    retryable while the committed user message stays untouched.
 * 4. `retryServerlessTurn` re-arms one FAILED assistant row in place (same
 *    primary key, same sequence position), reuses the original user message
 *    verbatim and rebuilds the request — retrying never duplicates prompts
 *    nor reorders the conversation.
 *
 * An abandoned stream (abort before any terminal event) leaves the row
 * `pending`, matching backend semantics; nothing is written for events that
 * never arrived. After `abort()` no further callbacks reach the consumer.
 *
 * Message text and API keys are never logged.
 */
import {getLocalDatabase} from '../db/database';
import type {SqlDriver} from '../db/driver';
import * as messageStore from '../db/messageStore';
import {getSession, touchSession} from '../db/sessionStore';
import type {LocalMessage, LocalSession} from '../db/types';
import type {
  CompletionRequest,
  ServerlessStreamEvent,
  StreamCompletionOptions,
  StreamHandle,
} from './types';

/** A turn could not be started (bad input, missing session, bad retry target). */
export class ServerlessTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerlessTurnError';
  }
}

/** Everything needed to stream one prepared chat turn to completion. */
export interface PreparedTurn {
  session: LocalSession;
  /** Committed user prompt (`complete`). */
  userMessage: LocalMessage;
  /**
   * Assistant generation slot. Starts `pending`; streaming settles it to
   * `complete` or `failed` before the terminal event reaches consumers.
   */
  assistantMessage: LocalMessage;
}

/** Assembles the LLM request for one prepared turn (TASK-087 strategy). */
export type TurnRequestBuilder = (turn: PreparedTurn) => CompletionRequest;

/** Streaming seam so tests script outcomes directly (client.streamCompletion). */
export type StreamFn = (options: StreamCompletionOptions) => StreamHandle;

/** Handle for one in-flight serverless turn; abort suppresses all callbacks. */
export interface ServerlessTurnHandle {
  abort(): void;
}

const BLANK_TEXT_MESSAGE = 'Message text must not be empty.';
const SESSION_MISSING_MESSAGE = 'Conversation not found.';
const RETRY_NOT_FAILED_MESSAGE =
  'Only failed assistant responses can be retried.';
const RETRY_NO_PROMPT_MESSAGE =
  'The failed response has no user message to retry.';
const SAVE_FAILURE_MESSAGE =
  'The response could not be saved on this device.';

export interface ServerlessTurnOptions {
  /** DB opener; defaults to the shared auto-initialized local database. */
  openDb?: () => Promise<SqlDriver>;
  /** Streaming transport (client.streamCompletion or a test fake). */
  stream: StreamFn;
  /** Request assembly seam; supplied by the mode wiring / tests. */
  buildRequest: TurnRequestBuilder;
  sessionId: number;
  /** Application events in wire order, terminal events post-persistence. */
  onEvent: (event: ServerlessStreamEvent) => void;
}

/**
 * Send one chat turn in serverless mode: persist the user message plus its
 * pending assistant slot atomically, then stream the replacement attempt.
 * Rejects with {@link ServerlessTurnError} before anything is written when
 * the text is blank or the session does not exist.
 */
export async function streamServerlessTurn(
  options: ServerlessTurnOptions & {text: string},
): Promise<ServerlessTurnHandle> {
  const openDb = options.openDb ?? getLocalDatabase;
  const db = await openDb();
  const prepared = await prepareNewTurn(db, options.sessionId, options.text, options.buildRequest);
  return runTurn(openDb, options.stream, prepared.turn, prepared.request, options.onEvent);
}

/**
 * Retry one failed assistant generation in place (MVP rule: only failed
 * responses are retryable). The row is reset to `pending` inside the same
 * transaction that rebuilds the request, then the replacement attempt
 * streams into that exact row.
 */
export async function retryServerlessTurn(
  options: ServerlessTurnOptions & {messageId: number},
): Promise<ServerlessTurnHandle> {
  const openDb = options.openDb ?? getLocalDatabase;
  const db = await openDb();
  const prepared = await prepareRetry(db, options.sessionId, options.messageId, options.buildRequest);
  return runTurn(openDb, options.stream, prepared.turn, prepared.request, options.onEvent);
}

async function prepareNewTurn(
  db: SqlDriver,
  sessionId: number,
  text: string,
  buildRequest: TurnRequestBuilder,
): Promise<{turn: PreparedTurn; request: CompletionRequest}> {
  const stripped = typeof text === 'string' ? text.trim() : '';
  if (!stripped) {
    throw new ServerlessTurnError(BLANK_TEXT_MESSAGE);
  }
  return db.transaction(async tx => {
    const session = await getSession(tx, sessionId);
    if (!session) {
      throw new ServerlessTurnError(SESSION_MISSING_MESSAGE);
    }
    const userMessage = await messageStore.appendMessage(tx, {
      session_id: sessionId,
      role: 'user',
      content: stripped,
    });
    const assistantMessage = await messageStore.appendMessage(tx, {
      session_id: sessionId,
      role: 'assistant',
      content: '',
      status: 'pending',
    });
    await touchSession(tx, sessionId);
    const turn: PreparedTurn = {session, userMessage, assistantMessage};
    // Assembled inside the transaction like backend chat.py: a failing
    // builder rolls the whole turn back.
    return {turn, request: buildRequest(turn)};
  });
}

async function prepareRetry(
  db: SqlDriver,
  sessionId: number,
  messageId: number,
  buildRequest: TurnRequestBuilder,
): Promise<{turn: PreparedTurn; request: CompletionRequest}> {
  return db.transaction(async tx => {
    const session = await getSession(tx, sessionId);
    if (!session) {
      throw new ServerlessTurnError(SESSION_MISSING_MESSAGE);
    }
    const messages = await messageStore.listMessages(tx, sessionId);
    const target = messages.find(message => message.id === messageId);
    if (!target || target.role !== 'assistant' || target.status !== 'failed') {
      throw new ServerlessTurnError(RETRY_NOT_FAILED_MESSAGE);
    }
    const userMessage = findPromptingUserMessage(messages, target.sequence);
    if (!userMessage) {
      throw new ServerlessTurnError(RETRY_NO_PROMPT_MESSAGE);
    }
    await messageStore.updateMessageStatus(tx, target.id, 'pending', '');
    await touchSession(tx, sessionId);
    const turn: PreparedTurn = {
      session,
      userMessage,
      assistantMessage: {...target, status: 'pending', content: ''},
    };
    return {turn, request: buildRequest(turn)};
  });
}

function findPromptingUserMessage(
  messages: readonly LocalMessage[],
  assistantSequence: number,
): LocalMessage | null {
  let prompt: LocalMessage | null = null;
  for (const message of messages) {
    if (message.role === 'user' && message.sequence < assistantSequence) {
      prompt = message;
    }
  }
  return prompt;
}

/**
 * Run one prepared turn to its single terminal outcome. Start/delta events
 * pass straight through; completed/failed are persisted onto the pending
 * row before delivery. Abort suppresses every further callback but never
 * rolls back a terminal persistence that is already running.
 */
function runTurn(
  openDb: () => Promise<SqlDriver>,
  stream: StreamFn,
  turn: PreparedTurn,
  request: CompletionRequest,
  onEvent: (event: ServerlessStreamEvent) => void,
): ServerlessTurnHandle {
  let aborted = false;
  const assistantId = turn.assistantMessage.id;

  const upstream = stream({
    request,
    onEvent: event => {
      if (aborted) {
        return;
      }
      if (event.type === 'start' || event.type === 'delta') {
        onEvent(event);
        return;
      }
      // Fire-and-forget settlement: it handles its own persistence errors,
      // and a throwing consumer callback must not become an unhandled
      // rejection inside the transport.
      settleTerminal(openDb, assistantId, event, () => aborted, onEvent).catch(() => {
        /* terminal settlement never surfaces */
      });
    },
  });

  return {
    abort() {
      if (aborted) {
        return;
      }
      aborted = true;
      upstream.abort();
    },
  };
}

async function settleTerminal(
  openDb: () => Promise<SqlDriver>,
  messageId: number,
  event: Extract<ServerlessStreamEvent, {type: 'completed'} | {type: 'failed'}>,
  isAborted: () => boolean,
  onEvent: (event: ServerlessStreamEvent) => void,
): Promise<void> {
  if (event.type === 'completed') {
    try {
      const db = await openDb();
      await messageStore.updateMessageStatus(db, messageId, 'complete', event.text);
    } catch {
      // Never claim completion without the commit backing it: degrade to a
      // retryable failure carrying the received text.
      if (!isAborted()) {
        onEvent({
          type: 'failed',
          message: SAVE_FAILURE_MESSAGE,
          retryable: true,
          text: event.text,
        });
      }
      return;
    }
  } else {
    try {
      const db = await openDb();
      await messageStore.updateMessageStatus(db, messageId, 'failed');
    } catch {
      // Best-effort status write; surface the original provider failure.
    }
  }
  if (!isAborted()) {
    onEvent(event);
  }
}
