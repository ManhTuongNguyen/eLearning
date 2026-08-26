/**
 * Mobile-side OpenRouter client for serverless mode (SPEC TASK-083).
 *
 * This module is the only place on mobile that knows OpenRouter's HTTP
 * surface (chat completions, SSE streaming, model catalog). It talks to
 * OpenRouter directly with the user's own API key — the key is only ever
 * placed in the Authorization header toward openrouter.ai and never reaches
 * the eLearning backend. Every failure is normalized into the hierarchy in
 * ./errors before it escapes, mirroring backend llm/openrouter.py.
 *
 * Model fallback mirrors backend llm/fallback.py: an ordered chain
 * (primary first, then fallbacks) where only retryable failures advance to
 * the next entry. Streaming falls back only while probing for the first
 * event — once any event has been delivered the attempt is committed and
 * mid-stream failures surface as the terminal `failed` event carrying the
 * partial text.
 *
 * Transport: plain fetch for JSON requests and XMLHttpRequest for streams,
 * matching src/api/chatStream.ts (React Native's fetch buffers response
 * bodies, while XHR progress events expose incremental text). Streams carry
 * no client-side total timeout: OpenRouter sends keep-alive comments and a
 * stalled connection eventually fails through onerror/ontimeout instead.
 */
import {
  OpenRouterAvailabilityError,
  OpenRouterError,
  OpenRouterRequestError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
  normalizeHttpFailure,
} from './errors';
import {
  failedEvent,
  type CompletionRequest,
  type CompletionResult,
  type ModelInfo,
  type OpenRouterClient,
  type OpenRouterClientConfig,
  type ServerlessStreamEvent,
  type StreamCompletionOptions,
  type StreamHandle,
} from './types';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_ERROR_SNIPPET_LENGTH = 300;

/** Build the ordered attempt chain: primary plus unique non-blank fallbacks. */
export function buildModelChain(
  primaryModel: string,
  fallbackModels?: readonly string[],
): string[] {
  const chain = [primaryModel.trim()];
  for (const candidate of fallbackModels ?? []) {
    const model = candidate.trim();
    if (model && !chain.includes(model)) {
      chain.push(model);
    }
  }
  return chain;
}

/**
 * Create an OpenRouter client bound to one user configuration. Config
 * problems are programmer errors and throw synchronously.
 */
export function createOpenRouterClient(config: OpenRouterClientConfig): OpenRouterClient {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new Error('An OpenRouter API key is required.');
  }
  const primaryModel = config.primaryModel.trim();
  if (!primaryModel) {
    throw new Error('A primary OpenRouter model is required.');
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('The OpenRouter base URL must be a non-empty string.');
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('The OpenRouter timeout must be greater than zero.');
  }
  const models = buildModelChain(primaryModel, config.fallbackModels);

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /** Extract a human-readable message from an error body; never logs secrets. */
  function extractErrorMessage(bodyText: string): string {
    const snippet = bodyText.trim().slice(0, MAX_ERROR_SNIPPET_LENGTH);
    let payload: unknown = null;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return snippet || 'empty error body';
    }
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      const error = record.error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) {
          return message.slice(0, MAX_ERROR_SNIPPET_LENGTH);
        }
      }
      if (typeof record.message === 'string' && record.message.trim()) {
        return (record.message as string).slice(0, MAX_ERROR_SNIPPET_LENGTH);
      }
    }
    return snippet || 'unrecognized error body';
  }

  function buildPayload(request: CompletionRequest, model: string, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model,
      messages: request.messages.map(message => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };
    if (request.temperature !== null && request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    return JSON.stringify(payload);
  }

  /** Chain for one request; an explicit model pin replaces the whole chain. */
  function chainFor(request: CompletionRequest): string[] {
    const pin = request.model?.trim();
    return pin ? [pin] : models;
  }

  function aggregateFailure(errors: readonly (readonly [string, string])[]): OpenRouterAvailabilityError {
    const detail = errors.map(([model, message]) => `${model}: ${message}`).join('; ');
    return new OpenRouterAvailabilityError(
      `all ${errors.length} configured model(s) failed: ${detail}`,
    );
  }

  /** Run one non-streaming completion attempt against one model. */
  async function attemptComplete(
    request: CompletionRequest,
    model: string,
  ): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(),
        body: buildPayload(request, model, false),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw normalizeHttpFailure(response.status, extractErrorMessage(bodyText), model);
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new OpenRouterResponseError('Malformed JSON from provider.', model);
      }
      if (typeof body !== 'object' || body === null) {
        throw new OpenRouterResponseError('Provider returned a non-object JSON payload.', model);
      }
      const record = body as Record<string, unknown>;
      const choices = record.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new OpenRouterResponseError('Response contains no choices.', model);
      }
      const choice = choices[0];
      if (typeof choice !== 'object' || choice === null) {
        throw new OpenRouterResponseError('Response contains no choices.', model);
      }
      const message = (choice as Record<string, unknown>).message;
      const content =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>).content
          : undefined;
      if (typeof content !== 'string') {
        throw new OpenRouterResponseError('Response choice has no string message content.', model);
      }

      const headerRequestId = response.headers.get('x-request-id');
      const bodyId = record.id;
      const finishReason = (choice as Record<string, unknown>).finish_reason;
      return {
        text: content,
        model: typeof record.model === 'string' ? record.model : model,
        finishReason: typeof finishReason === 'string' ? finishReason : null,
        requestId: headerRequestId ?? (typeof bodyId === 'string' ? bodyId : null),
      };
    } catch (error) {
      if (error instanceof OpenRouterError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new OpenRouterTimeoutError(`request exceeded timeout of ${timeoutMs}ms`, model);
      }
      throw new OpenRouterRequestError(
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
          error instanceof OpenRouterError
            ? error
            : new OpenRouterResponseError(error instanceof Error ? error.message : String(error), model);
        failures.push([model, llmError.message]);
        if (!llmError.retryable) {
          throw llmError;
        }
      }
    }
    throw aggregateFailure(failures);
  }

  /**
   * Stream one completion across the chain. Exactly one terminal outcome is
   * delivered: a `completed` or `failed` event (never both, none after
   * abort). Retryable failures before the first event silently advance to
   * the next model, mirroring backend FallbackProvider probing.
   */
  function streamCompletion(options: StreamCompletionOptions): StreamHandle {
    const {request, onEvent} = options;
    const chain = chainFor(request);
    const failures: [string, string][] = [];

    let aborted = false;
    let terminalSeen = false;
    let index = 0;
    let xhr: XMLHttpRequest | null = null;

    // Per-attempt state, reset by startAttempt.
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

    function failWith(error: OpenRouterError): void {
      if (aborted || terminalSeen) {
        return;
      }
      emit(failedEvent(error, partialText()));
    }

    function handleAttemptFailure(error: OpenRouterError): void {
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
          new OpenRouterResponseError(
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

    /** Process one raw SSE frame: `data:` payloads only, comments ignored. */
    function handleFrame(raw: string): void {
      if (aborted || terminalSeen) {
        return;
      }
      const dataLines: string[] = [];
      for (const line of raw.replace(/\r/g, '').split('\n')) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trim());
        }
      }
      if (dataLines.length === 0) {
        // Blank separators and OpenRouter keep-alive comments.
        return;
      }
      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        finishCompleted();
        return;
      }

      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        failWith(new OpenRouterResponseError('Malformed JSON chunk from provider.', effectiveModel));
        return;
      }
      if (typeof chunk !== 'object' || chunk === null) {
        failWith(new OpenRouterResponseError('Provider sent a non-object chunk.', effectiveModel));
        return;
      }
      const record = chunk as Record<string, unknown>;

      // Mid-stream OpenRouter error payloads arrive as {"error": {...}}.
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
              ? normalizeHttpFailure(code, message, effectiveModel)
              : new OpenRouterResponseError(message, effectiveModel),
          );
        } else {
          failWith(new OpenRouterResponseError(String(inlineError), effectiveModel));
        }
        return;
      }

      receivedChunk = true;
      if (typeof record.model === 'string' && record.model) {
        effectiveModel = record.model;
      }
      if (!started) {
        started = true;
        emit({type: 'start', model: effectiveModel});
      }

      const choices = record.choices;
      let piece = '';
      if (Array.isArray(choices) && choices.length > 0) {
        const choice = choices[0];
        if (typeof choice === 'object' && choice !== null) {
          const delta = (choice as Record<string, unknown>).delta;
          if (typeof delta === 'object' && delta !== null) {
            const content = (delta as Record<string, unknown>).content;
            if (typeof content === 'string') {
              piece = content;
            }
          }
        }
      }
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
        pending += xhr.responseText.slice(cursor, total);
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
      attempt.open('POST', `${baseUrl}/chat/completions`);
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
            normalizeHttpFailure(attempt.status, extractErrorMessage(attempt.responseText), model),
          );
          return;
        }
        consumeBuffer();
        if (pending.trim()) {
          // Tolerate a server that closes without the trailing blank line.
          handleFrame(pending);
          pending = '';
        }
        finishCompleted();
      };

      attempt.onerror = () => {
        handleAttemptFailure(
          new OpenRouterRequestError(
            'Network request failed. Check your connection and try again.',
            model,
          ),
        );
      };

      attempt.ontimeout = () => {
        handleAttemptFailure(
          new OpenRouterTimeoutError(`request exceeded timeout of ${timeoutMs}ms`, model),
        );
      };

      attempt.send(buildPayload(request, model, true));
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

  /** Normalize one model-catalog entry; malformed entries are skipped. */
  function parseModelEntry(entry: unknown): ModelInfo | null {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || !id.trim()) {
      return null;
    }
    const intOrNull = (value: unknown): number | null =>
      typeof value === 'number' && Number.isInteger(value) ? value : null;
    return {
      id: id.trim(),
      name: typeof record.name === 'string' ? record.name : '',
      description: typeof record.description === 'string' ? record.description : null,
      contextLength: intOrNull(record.context_length),
      created: intOrNull(record.created),
    };
  }

  async function listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw normalizeHttpFailure(response.status, extractErrorMessage(bodyText), null);
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new OpenRouterResponseError('Malformed JSON from provider.');
      }
      const entries =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>).data
          : undefined;
      if (!Array.isArray(entries)) {
        throw new OpenRouterResponseError('Models response contains no data list.');
      }
      const catalog: ModelInfo[] = [];
      for (const entry of entries) {
        const parsed = parseModelEntry(entry);
        if (parsed) {
          catalog.push(parsed);
        }
      }
      return catalog;
    } catch (error) {
      if (error instanceof OpenRouterError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new OpenRouterTimeoutError(`request exceeded timeout of ${timeoutMs}ms`);
      }
      throw new OpenRouterRequestError(
        'Network request failed. Check your connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {complete, streamCompletion, listModels};
}
