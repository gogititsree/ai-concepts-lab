import type { ChatMessage, ChatRequest, ChatResponse, ModelHealth, ToolCall } from '@lab/shared';

import { AppError } from '../lib/errors.js';
import { modelTimeout, modelUnavailable, type ModelProvider } from './provider.js';

/**
 * The Ollama adapter — **the only file in this repository that knows Ollama exists.**
 *
 * Everything peculiar about the local model is absorbed here, and most of it was measured
 * rather than read in a manual (docs/spike-notes.md, M0 + the 2026-09-19 follow-up):
 *
 *  - `think: false` on every request. On `gemma4:latest`, enabling thinking makes the
 *    model **ignore a `format` JSON schema entirely** — 0/5 valid JSON with it on, 5/5
 *    with it off, and roughly half the latency (decision 16). This is not a tuning
 *    preference; it is the difference between structured output working and not.
 *  - `tool_calls[].function.arguments` arrives as an already-parsed **object** on this
 *    model, though the wire format allows a JSON string. Both are handled.
 *  - `message.thinking` and `prompt_eval_cached_count` appear in responses and are in no
 *    specification we control. They go to `providerMeta`; nothing crashes on them.
 *  - `keep_alive: '10m'` matters more than it looks: a cold load costs 20–40 s, which is
 *    most of the 90 s budget.
 */

export interface OllamaProviderOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  timeoutMs: number;
  /** Injected in unit tests so the mapping can be exercised against the M0 fixtures. */
  fetchImpl?: typeof fetch;
}

/** How long the model stays resident after a call. A cold reload costs 20–40 s. */
export const KEEP_ALIVE = '10m';

/** `GET /api/tags` is a trivial call; it must not sit on the 90 s inference budget. */
const HEALTH_TIMEOUT_MS = 5_000;

// ------------------------------------------------------------- wire-shape types ----

interface OllamaToolCall {
  id?: string;
  function?: {
    index?: number;
    name?: string;
    /** Object on `gemma4:latest`; a JSON string on other models/providers. */
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role?: string;
  content?: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  message?: OllamaMessage;
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string }[];
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
}

// ------------------------------------------------------------------- pure parts ----

/**
 * `think: true` together with `format` is a configuration that silently produces prose
 * instead of JSON. Rather than let it through and be flaky, the adapter refuses it.
 * The route schema rejects it first; this is the belt under the braces, and it is what
 * the unit test asserts on.
 */
export function assertThinkFormatExclusive(req: ChatRequest): void {
  if (req.format !== undefined && req.options?.think === true) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'think and format are mutually exclusive on this model: with thinking enabled the ' +
        'JSON schema is ignored and the reply comes back as prose (docs/07-open-decisions.md, decision 16)',
    );
  }
}

/** Provider-neutral messages -> Ollama's wire shape. */
export function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    const wire: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.toolCalls?.length) {
      wire.tool_calls = message.toolCalls.map((call, index) => ({
        id: call.id,
        function: { index, name: call.name, arguments: call.args },
      }));
    }
    // Ollama names this `tool_name`, not `name`; the M0 spike confirmed the round trip.
    if (message.toolName) wire.tool_name = message.toolName;
    return wire;
  });
}

/** Neutral sampling options -> Ollama's `options` block. Omitted entirely when empty. */
export function toOllamaOptions(req: ChatRequest): Record<string, number> | undefined {
  const options: Record<string, number> = {};
  if (req.options?.temperature !== undefined) options.temperature = req.options.temperature;
  if (req.options?.topP !== undefined) options.top_p = req.options.topP;
  if (req.options?.maxTokens !== undefined) options.num_predict = req.options.maxTokens;
  if (req.options?.seed !== undefined) options.seed = req.options.seed;
  return Object.keys(options).length > 0 ? options : undefined;
}

/** The exact JSON body posted to `POST /api/chat`. Pure, so a test can assert on it. */
export function buildChatBody(req: ChatRequest, defaultModel: string): Record<string, unknown> {
  assertThinkFormatExclusive(req);

  const body: Record<string, unknown> = {
    model: req.model ?? defaultModel,
    stream: false,
    // Always present, always false unless a caller explicitly opted in. See the header.
    think: req.options?.think === true,
    keep_alive: KEEP_ALIVE,
    messages: toOllamaMessages(req.messages),
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (req.format !== undefined) body.format = req.format;
  const options = toOllamaOptions(req);
  if (options) body.options = options;
  return body;
}

/**
 * `arguments` may be an object (this model) or a JSON string (the documented shape).
 * A string that does not parse is not an error: it is a `parseOk:false` tool call whose
 * raw text is preserved, because the agent loop's job is to hand the model its own
 * mistake back rather than to 500.
 */
function normaliseArgs(raw: unknown): { args: unknown; rawArgs?: string; parseOk: boolean } {
  if (typeof raw !== 'string') return { args: raw ?? {}, parseOk: true };
  try {
    return { args: JSON.parse(raw), rawArgs: raw, parseOk: true };
  } catch {
    return { args: undefined, rawArgs: raw, parseOk: false };
  }
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * The parse-failure fallback from docs/01-architecture.md.
 *
 * Some models describe the call they meant to make instead of making it, emitting a
 * fenced block like:
 *
 * ```json
 * { "name": "calculator", "arguments": { "expression": "2+2" } }
 * ```
 *
 * Rather than treat that as "no tool call" and let the loop stall, the content is mined
 * for such a block and the call is reconstructed — flagged `parseOk:false,
 * recovered:true` so it is visibly a recovery in the trace and counts towards
 * `tool_call_parse_failures_total{recovered="true"}` when M14 adds the metric.
 *
 * Guarded by "the request actually offered tools": without that, a structured-output
 * response that happens to contain a `name`/`arguments` object would be misread as a
 * tool call.
 */
export function recoverToolCallsFromContent(content: string): ToolCall[] {
  const candidates: string[] = [];
  for (const match of content.matchAll(FENCE)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  // A model that emitted bare JSON and no prose counts as a fenced block of one.
  const trimmed = content.trim();
  if (candidates.length === 0 && trimmed.startsWith('{')) candidates.push(trimmed);

  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      // `tool_name` is the spelling gemma4's own thinking block uses for the same idea.
      const name = record.name ?? record.tool_name;
      if (typeof name !== 'string' || !('arguments' in record)) continue;
      calls.push({
        id: `call_recovered_${calls.length}`,
        name,
        args: record.arguments,
        rawArgs: candidate,
        parseOk: false,
        recovered: true,
      });
    }
  }
  return calls;
}

/**
 * The response mapping, as a pure function of (wire response, latency, request) so the
 * M0 fixtures can be replayed through it with no network and no server.
 */
export function mapChatResponse(
  raw: OllamaChatResponse,
  latencyMs: number,
  req: ChatRequest,
): ChatResponse {
  const content = raw.message?.content ?? '';
  const native = raw.message?.tool_calls ?? [];

  let toolCalls: ToolCall[] = native.map((call, index) => {
    const { args, rawArgs, parseOk } = normaliseArgs(call.function?.arguments);
    return {
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? 'unknown',
      args,
      ...(rawArgs === undefined ? {} : { rawArgs }),
      parseOk,
    };
  });

  if (toolCalls.length === 0 && req.tools?.length) {
    toolCalls = recoverToolCallsFromContent(content);
  }

  const message: ChatMessage = {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  // Everything the wire carries that the neutral contract does not model. `thinking` is
  // the big one: it is the dominant latency cost on this model and the reason the
  // `think` flag exists at all, so it is kept for the trace viewer rather than dropped.
  const providerMeta: Record<string, unknown> = {};
  const passthrough: (keyof OllamaChatResponse)[] = [
    'model',
    'created_at',
    'done',
    'done_reason',
    'total_duration',
    'load_duration',
    'prompt_eval_count',
    'prompt_eval_cached_count',
    'prompt_eval_duration',
    'eval_count',
    'eval_duration',
  ];
  for (const key of passthrough) {
    if (raw[key] !== undefined) providerMeta[key] = raw[key];
  }
  if (raw.message?.thinking !== undefined) providerMeta.thinking = raw.message.thinking;

  return {
    message,
    usage: {
      promptTokens: raw.prompt_eval_count ?? 0,
      completionTokens: raw.eval_count ?? 0,
    },
    latencyMs: Math.max(0, Math.round(latencyMs)),
    providerMeta,
  };
}

/**
 * Maps a thrown fetch/abort failure onto the app's error vocabulary.
 *
 * Note what the messages do *not* contain: the base URL. `/model/health` is public and a
 * 503 body is the sort of thing that gets pasted into a screenshot, so the internal
 * address stays server-side.
 */
export function mapRequestError(
  error: unknown,
  timedOut: boolean,
  callerAborted: boolean,
): AppError {
  if (timedOut) {
    return modelTimeout(
      'The model did not respond within the timeout. Local inference on CPU can take a minute; try a shorter prompt or a smaller max-tokens.',
    );
  }
  if (callerAborted) {
    return new AppError(499, 'REQUEST_ABORTED', 'The request was cancelled by the client');
  }
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    error instanceof TypeError
  ) {
    return modelUnavailable(
      'Could not reach the local model. Is Ollama running? Start it with `ollama serve`.',
    );
  }
  return modelUnavailable(
    error instanceof Error ? `Model request failed: ${error.name}` : 'Model request failed',
  );
}

// -------------------------------------------------------------------- the class ----

export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama' as const;

  private readonly baseUrl: string;
  private readonly chatModel: string;
  private readonly embedModel: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    // Trailing slashes in an env var are the classic source of `//api/chat`.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.chatModel = options.chatModel;
    this.embedModel = options.embedModel;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * One POST, with two independent reasons to give up: our own deadline and the caller's
   * `AbortSignal` (the browser's cancel button). They are combined rather than raced so
   * the *reason* survives — a timeout is `MODEL_TIMEOUT`, a cancel is not an error the
   * user needs to see.
   */
  private async post<T>(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      throw mapRequestError(error, deadline.aborted, signal?.aborted === true);
    }

    if (!response.ok) {
      // A 404 here is nearly always "that model tag is not pulled", which is a far more
      // useful thing to say than "HTTP 404".
      const hint =
        response.status === 404
          ? `The model is not available locally. Try \`ollama pull ${this.chatModel}\`.`
          : `The model server returned HTTP ${response.status}.`;
      throw modelUnavailable(hint);
    }
    return (await response.json()) as T;
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = buildChatBody(req, this.chatModel);
    const startedAt = Date.now();
    const raw = await this.post<OllamaChatResponse>('/api/chat', body, signal, this.timeoutMs);
    return mapChatResponse(raw, Date.now() - startedAt, req);
  }

  async embed(texts: string[], model?: string): Promise<number[][]> {
    // `/api/embed` (singular), not `/api/embeddings` — verified in the M0 spike — and
    // the response field is `embeddings` (plural), one vector per input, in order.
    const raw = await this.post<OllamaEmbedResponse>(
      '/api/embed',
      { model: model ?? this.embedModel, input: texts },
      undefined,
      this.timeoutMs,
    );
    return raw.embeddings ?? [];
  }

  /**
   * Liveness via `GET /api/tags`: it is ~20 ms, it needs no model loaded, and it answers
   * the question the banner actually asks ("is the chat model pulled?") rather than just
   * "is the port open".
   *
   * This method never throws. A health check that can throw turns a missing dependency
   * into a 500 on the page that was trying to explain the missing dependency.
   */
  async health(): Promise<ModelHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, models: [], detail: `Model server returned HTTP ${response.status}` };
      }
      const raw = (await response.json()) as OllamaTagsResponse;
      const models = (raw.models ?? [])
        .map((entry) => entry.model ?? entry.name)
        .filter((entry): entry is string => typeof entry === 'string');
      const hasChatModel = models.includes(this.chatModel);
      return {
        ok: hasChatModel,
        models,
        ...(hasChatModel ? {} : { detail: `Model "${this.chatModel}" is not pulled` }),
      };
    } catch {
      // Deliberately swallowed and generic: this response is public.
      return { ok: false, models: [], detail: 'Could not reach the local model server' };
    }
  }
}
