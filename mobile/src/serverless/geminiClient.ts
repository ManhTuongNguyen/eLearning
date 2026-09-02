/**
 * Mobile-side Google Gemini client for serverless mode (TASK-AUDIT-013).
 *
 * Proof that the mobile provider abstraction accommodates integrations whose
 * API surface genuinely differs from OpenAI-compatible vendors: distinct
 * paths (`generateContent` / `streamGenerateContent?alt=sse`), role mapping
 * (`assistant` → `model`, `system` → `systemInstruction`), key
 * authentication via the `x-goog-api-key` header (the key is only ever sent
 * toward Google — never logged, never sent to the eLearning backend), and
 * SSE chunks without a `[DONE]` terminator.
 *
 * The fallback-chain and streaming semantics mirror the shared
 * OpenAI-compatible strategy exactly (see ./openAICompatibleClient): only
 * retryable failures advance the chain, streaming falls back only before
 * the first event, and exactly one terminal event is delivered per stream.
 */
import {
  LLMError,
  LLMAvailabilityError,
  LLMRequestError,
  LLMResponseError,
  LLMTimeoutError,
  normalizeHttpFailure,
} from './errors';
import {
  failedEvent,
  type CompletionRequest,
  type CompletionResult,
  type LLMClient,
  type LLMClientConfig,
  type ModelInfo,
  type ServerlessStreamEvent,
  type StreamCompletionOptions,
  type StreamHandle,
} from './types';
import {DEFAULT_TIMEOUT_MS, buildModelChain, extractErrorMessage} from './openAICompatibleClient';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const MODEL_NAME_PREFIX = 'models/';

/** Build the Gemini request body from the normalized completion request. */
export function buildGeminiPayload(request: CompletionRequest): Record<string, unknown> {
  const contents: Array<{role: string; parts: Array<{text: string}>}> = [];
  const systemParts: string[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{text: message.content}],
    });
  }
  const payload: Record<string, unknown> = {contents};
  if (systemParts.length > 0) {
    payload.systemInstruction = {parts: [{text: systemParts.join('\n\n')}]};
  }
  if (request.temperature !== null && request.temperature !== undefined) {
    payload.generationConfig = {temperature: request.temperature};
  }
  return payload;
}

/** Normalize one Gemini catalog entry onto the shared ModelInfo shape. */
export function normalizeGeminiModelEntry(entry: unknown): ModelInfo | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  let id = typeof record.name === 'string' ? record.name.trim() : '';
  if (!id) {
    return null;
  }
  if (id.startsWith(MODEL_NAME_PREFIX)) {
    id = id.slice(MODEL_NAME_PREFIX.length);
  }
  if (!id) {
    return null;
  }
  const supportedGenerationMethods = Array.isArray(record.supportedGenerationMethods)
    ? record.supportedGenerationMethods.filter(
        (method): method is string => typeof method === 'string',
      )
    : [];
  return {
    id,
    name: typeof record.displayName === 'string' ? record.displayName : '',
    canonicalSlug: null,
    description: typeof record.description === 'string' ? record.description : null,
    contextLength:
      typeof record.inputTokenLimit === 'number' && Number.isInteger(record.inputTokenLimit)
        ? record.inputTokenLimit
        : null,
    created: null,
    architecture: null,
    pricing: null,
    topProvider: null,
    supportedParameters: supportedGenerationMethods,
  };
}

/**
 * Create a Gemini client bound to one user configuration. Config problems
 * are programmer errors and throw synchronously.
 */
export function createGeminiClient(config: LLMClientConfig): LLMClient {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new Error('A Gemini API key is required.');
  }
  const primaryModel = config.primaryModel.trim();
  if (!primaryModel) {
    throw new Error('A primary Gemini model is required.');
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_GEMINI_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The Gemini base URL must be a non-empty string.');
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The Gemini timeout must be greater than zero.');
  }
  const models = buildModelChain(primaryModel, config.fallbackModels);

  function authHeaders(): Record<string, string> {
    return {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    };
  }

  function chainFor(request: CompletionRequest): string[] {
    const pin = request.model?.trim();
    return pin ? [pin] : models;
  }

  function aggregateFailure(errors: readonly (readonly [string, string])[]): LLMAvailabilityError {
    const detail = errors.map(([model, message]) => `${model}: ${message}`).join('; ');
    return new LLMAvailabilityError(`all ${errors.length} configured model(s) failed: ${detail}`);
  }

  function firstText(record: Record<string, unknown>): string | null {
    const candidates = record.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }
    const candidate = candidates[0];
    if (typeof candidate !== 'object' || candidate === null) {
      return null;
    }
    const content = (candidate as Record<string, unknown>).content;
    if (typeof content !== 'object' || content === null) {
      return null;
    }
    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) {
      return null;
    }
    const pieces = parts
      .filter(
        (part): part is Record<string, unknown> =>
          typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string',
      )
      .map(part => (part as Record<string, unknown>).text as string);
    return pieces.length > 0 ? pieces.join('') : null;
  }

  /** Run one non-streaming generateContent attempt against one model. */
  async function attemptComplete(
    request: CompletionRequest,
    model: string,
  ): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/models/${model}:generateContent`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(buildGeminiPayload(request)),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw normalizeHttpFailure(
          response.status,
          extractErrorMessage(bodyText),
          model,
          'Gemini',
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new LLMResponseError('Malformed JSON from provider.', model);
      }
      if (typeof body !== 'object' || body === null) {
        throw new LLMResponseError('Provider returned a non-object JSON payload.', model);
      }
      const record = body as Record<string, unknown>;
      const text = firstText(record);
      if (text === null) {
        throw new LLMResponseError('Response candidate has no text parts.', model);
      }
      const modelVersion = record.modelVersion;
      const responseId = record.responseId;
      let finishReason: string | null = null;
      const candidates = record.candidates;
      if (Array.isArray(candidates) && candidates.length > 0) {
        const candidate = candidates[0];
        if (typeof candidate === 'object' && candidate !== null) {
          const reason = (candidate as Record<string, unknown>).finishReason;
          finishReason = typeof reason === 'string' ? reason : null;
        }
      }
      return {
        text,
        model: typeof modelVersion === 'string' ? modelVersion : model,
        finishReason,
        requestId:
          typeof responseId === 'string'
            ? responseId
            : response.headers.get('x-request-id'),
      };
    } catch (error) {
      if (error instanceof LLMError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new LLMTimeoutError(`request exceeded timeout of ${timeoutMs}ms`, model);
      }
      throw new LLMRequestError(
        'Network request failed. Check your connection and try again.',
        model,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    const chain = chainFor(request);
    const failures: [string, string][] = [];
    for (const model of chain) {
      try {
        return await attemptComplete(request, model);
      } catch (error) {
        const llmError =
          error instanceof LLMError
            ? error
            : new LLMResponseError(error instanceof Error ? error.message : String(error), model);
        failures.push([model, llmError.message]);
        if (!llmError.retryable) {
          throw llmError;
        }
      }
    }
    throw aggregateFailure(failures);
  }

  /**
   * Stream one completion across the chain with the same contract as the
   * shared strategy: exactly one terminal outcome per stream; retryable
   * failures before the first event advance to the next model.
   */
  function streamCompletion(options: StreamCompletionOptions): StreamHandle {
    const {request, onEvent} = options;
    const chain = chainFor(request);
    const failures: [string, string][] = [];

    let aborted = false;
    let terminalSeen = false;
    let index = 0;
    let xhr: XMLHttpRequest | null = null;

    let committed = false;
    let started = false;
    let receivedChunk = false;
    let effectiveModel = '';
    let pieces: string[] = [];
    let deltaCount = 0;
    let cursor = 0;
    let pending = '';

    function partialText(): string {
      return pieces.join('');
    }

    function emit(event: ServerlessStreamEvent): void {
      if (aborted || terminalSeen) {
        return;
      }
      committed = true;
      if (event.type === 'completed' || event.type === 'failed') {
        terminalSeen = true;
      }
      onEvent(event);
    }

    function failWith(error: LLMError): void {
      if (aborted || terminalSeen) {
        return;
      }
      emit(failedEvent(error, partialText()));
    }

    function handleAttemptFailure(error: LLMError): void {
      if (aborted || terminalSeen) {
        return;
      }
      failures.push([effectiveModel || chain[index], error.message]);
      const hasNext = index + 1 < chain.length;
      if (!committed && error.retryable && hasNext) {
        index += 1;
        startAttempt();
        return;
      }
      if (!committed && error.retryable) {
        failWith(aggregateFailure(failures));
        return;
      }
      failWith(error);
    }

    function finishCompleted(): void {
      if (aborted || terminalSeen) {
        return;
      }
      if (!receivedChunk) {
        failWith(
          new LLMResponseError(
            'Provider closed the stream without sending any events.',
            effectiveModel,
          ),
        );
        return;
      }
      emit({
        type: 'completed',
        text: partialText(),
        model: effectiveModel,
        deltaCount,
      });
    }

    function handleFrame(raw: string): void {
      if (aborted || terminalSeen) {
        return;
      }
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim());
        }
      }
      if (dataLines.length === 0) {
        return;
      }
      const data = dataLines.join('\n');
      // Gemini SSE has no [DONE] marker; the end of the response completes
      // the stream through onload. An empty data line is ignored.

      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        failWith(new LLMResponseError('Malformed JSON chunk from provider.', effectiveModel));
        return;
      }
      if (typeof chunk !== 'object' || chunk === null) {
        failWith(new LLMResponseError('Provider sent a non-object chunk.', effectiveModel));
        return;
      }
      const record = chunk as Record<string, unknown>;

      // Mid-stream error payloads arrive as {"error": {...}}.
      const inlineError = record.error;
      if (inlineError !== undefined) {
        if (typeof inlineError === 'object' && inlineError !== null) {
          const errorRecord = inlineError as Record<string, unknown>;
          const message =
            typeof errorRecord.message === 'string'
              ? errorRecord.message
              : 'Provider reported a mid-stream error.';
          const code = typeof errorRecord.code === 'number' ? errorRecord.code : null;
          failWith(
            code !== null
              ? normalizeHttpFailure(code, message, effectiveModel, 'Gemini')
              : new LLMResponseError(message, effectiveModel),
          );
        } else {
          failWith(new LLMResponseError(String(inlineError), effectiveModel));
        }
        return;
      }

      receivedChunk = true;
      if (typeof record.modelVersion === 'string' && record.modelVersion) {
        effectiveModel = record.modelVersion;
      }
      if (!started) {
        started = true;
        emit({type: 'start', model: effectiveModel});
      }

      const piece = firstText(record);
      if (piece) {
        pieces.push(piece);
        deltaCount += 1;
        emit({type: 'delta', text: piece});
      }
    }

    function consumeBuffer(): void {
      if (!xhr) {
        return;
      }
      const total = xhr.responseText.length;
      if (total > cursor) {
        // Gemini terminates SSE lines with CRLF, so the raw stream never
        // contains a bare "\n\n" frame separator. Normalize CR to LF before
        // splitting (raw CR never appears inside JSON payloads; JSON strings
        // escape it as "\\r") so each `data:` line stays one complete JSON
        // object instead of the whole body collapsing into a single frame.
        pending += xhr.responseText.slice(cursor, total).replace(/\r/g, '');
        cursor = total;
        let separator = pending.indexOf('\n\n');
        while (separator !== -1) {
          handleFrame(pending.slice(0, separator));
          pending = pending.slice(separator + 2);
          separator = pending.indexOf('\n\n');
        }
      }
    }

    function startAttempt(): void {
      const model = chain[index];
      committed = false;
      started = false;
      receivedChunk = false;
      effectiveModel = model;
      pieces = [];
      deltaCount = 0;
      cursor = 0;
      pending = '';

      const attempt = new XMLHttpRequest();
      xhr = attempt;
      attempt.open('POST', `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`);
      attempt.setRequestHeader('Content-Type', 'application/json');
      attempt.setRequestHeader('Accept', 'text/event-stream');
      for (const [name, value] of Object.entries(authHeaders())) {
        if (name !== 'Content-Type') {
          attempt.setRequestHeader(name, value);
        }
      }

      attempt.onprogress = () => {
        if (!aborted && !terminalSeen) {
          consumeBuffer();
        }
      };

      attempt.onload = () => {
        if (aborted || terminalSeen) {
          return;
        }
        if (attempt.status < 200 || attempt.status >= 300) {
          handleAttemptFailure(
            normalizeHttpFailure(
              attempt.status,
              extractErrorMessage(attempt.responseText),
              model,
              'Gemini',
            ),
          );
          return;
        }
        consumeBuffer();
        if (pending.trim()) {
          handleFrame(pending);
          pending = '';
        }
        finishCompleted();
      };

      attempt.onerror = () => {
        handleAttemptFailure(
          new LLMRequestError(
            'Network request failed. Check your connection and try again.',
            model,
          ),
        );
      };

      attempt.ontimeout = () => {
        handleAttemptFailure(
          new LLMTimeoutError(`request exceeded timeout of ${timeoutMs}ms`, model),
        );
      };

      attempt.send(JSON.stringify(buildGeminiPayload(request)));
    }

    startAttempt();

    return {
      abort() {
        if (aborted) {
          return;
        }
        aborted = true;
        terminalSeen = true;
        xhr?.abort();
        xhr = null;
      },
    };
  }

  /** Retrieve the Gemini model catalog; discovery requires the user's key. */
  const listModels = (): Promise<ModelInfo[]> =>
    listGeminiModels({baseUrl, timeoutMs, apiKey});

  return {complete, streamCompletion, listModels};
}

/**
 * Retrieve the Gemini model catalog directly. Discovery is authenticated
 * (unlike OpenRouter's public catalog): the user's key is required and is
 * sent only toward Google in the `x-goog-api-key` header — never logged.
 */
export async function listGeminiModels(
  options: GeminiModelListingOptions = {},
): Promise<ModelInfo[]> {
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The Gemini base URL must be a non-empty string.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The Gemini timeout must be greater than zero.');
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error('A Gemini API key is required for model discovery.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
      },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw normalizeHttpFailure(response.status, extractErrorMessage(bodyText), null, 'Gemini');
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new LLMResponseError('Malformed JSON from provider.');
    }
    const entries =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).models
        : undefined;
    if (!Array.isArray(entries)) {
      throw new LLMResponseError('Models response contains no models list.');
    }
    const catalog: ModelInfo[] = [];
    for (const entry of entries) {
      const parsed = normalizeGeminiModelEntry(entry);
      if (parsed) {
        catalog.push(parsed);
      }
    }
    return catalog;
  } catch (error) {
    if (error instanceof LLMError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new LLMTimeoutError(`request exceeded timeout of ${timeoutMs}ms`);
    }
    throw new LLMRequestError('Network request failed. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

/** Options for fetching the Gemini model catalog outside a full client config. */
export interface GeminiModelListingOptions {
  baseUrl?: string;
  timeoutMs?: number;
  apiKey?: string;
}
