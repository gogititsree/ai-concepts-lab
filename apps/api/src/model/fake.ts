import type { ChatMessage, ChatRequest, ChatResponse, ModelHealth, ToolCall } from '@lab/shared';

import { AppError } from '../lib/errors.js';
import { sampleFromJsonSchema } from './jsonSchema.js';
import { modelTimeout, modelUnavailable, type ModelProvider } from './provider.js';

/**
 * The deterministic test double behind the same `ModelProvider` interface.
 *
 * This is the provider **CI runs**, so it is not a stub that returns "hello": it is the
 * only way the agent loop (M10), the harness exercise (M11) and the structured-output
 * retry logic get exercised at all, and every branch those need must be reachable from
 * here. Hence a scenario table rather than one canned reply.
 *
 * Three properties are non-negotiable and are asserted by `test/model-fake.test.ts`:
 *
 *  1. **Determinism.** Same request in, byte-identical response out, including token
 *     counts and `latencyMs`. Nothing reads the clock (`slow` sleeps, but still reports
 *     a fixed latency) and nothing calls `Math.random()`.
 *  2. **No real timers** beyond a few milliseconds, except `slow`, which exists precisely
 *     to test the pending/cancel UI and names its own delay.
 *  3. **Shape parity with the real adapter.** A scenario returns the same `ChatResponse`
 *     an `OllamaProvider` would, `providerMeta` and all, so a test passing against the
 *     fake is evidence about the code under test rather than about the fake.
 *
 * Scenario selection, in order:
 *   1. `options.scenario` — explicit, and what tests use.
 *   2. a keyword in the system prompt (`scenario: tool-call-once`, or just the bare name)
 *      — how the Playwright E2E and manual demos pick one without a bespoke API.
 *   3. `plain-answer`.
 */

export const FAKE_SCENARIOS = [
  /** Replies with the last user message, verbatim. The "is it wired up" scenario. */
  'echo',
  /** A short assistant sentence, no tools, no JSON. The default. */
  'plain-answer',
  /** Valid JSON derived from the request's `format` schema. */
  'structured-valid',
  /** Prose despite `format`, mirroring the real `think:true` failure. Fails on retry too. */
  'structured-invalid',
  /** Prose first, valid JSON once the validation error has been fed back (decision 16). */
  'structured-retry-ok',
  /** One `calculator` tool call, then a final answer once the tool result comes back. */
  'tool-call-once',
  /** A tool call whose `arguments` are not JSON: `parseOk:false` with the raw text kept. */
  'tool-call-malformed-args',
  /** A call to a tool that is not in the allow-list, to exercise the loop's rejection. */
  'tool-call-unknown-tool',
  /** Always calls a tool, so the loop hits `maxIterations`. */
  'tool-call-never-stops',
  /** Sleeps before answering. `slow:2500` sets the delay in ms (default 1500). */
  'slow',
  /** Throws `MODEL_TIMEOUT`. */
  'error-timeout',
  /** Throws `MODEL_UNAVAILABLE`. */
  'error-unavailable',
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const DEFAULT_SCENARIO: FakeScenario = 'plain-answer';
const DEFAULT_SLOW_MS = 1500;

/** The marker the structured-output retry appends; scenarios branch on seeing it. */
export const RETRY_MARKER = 'did not match the requested JSON schema';

export interface FakeProviderOptions {
  /** Reported as the model name so traces look like the real thing. */
  model?: string;
}

// ------------------------------------------------------------------- selection ----

export interface ScenarioSelection {
  scenario: FakeScenario;
  /** The `:N` suffix on `slow:2500`, in milliseconds. */
  delayMs: number;
}

function parseScenarioToken(token: string): ScenarioSelection | null {
  const [name, argument] = token.split(':');
  const match = FAKE_SCENARIOS.find((scenario) => scenario === name);
  if (!match) return null;
  const parsed = Number.parseInt(argument ?? '', 10);
  return {
    scenario: match,
    delayMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_MS,
  };
}

/**
 * Explicit option first, then the system prompt, then the default.
 *
 * The system-prompt path scans for the longest matching name, so `tool-call-never-stops`
 * is not shadowed by `tool-call-once` sharing a prefix with nothing — the sort below is
 * what makes that robust rather than lucky.
 */
export function selectScenario(req: ChatRequest): ScenarioSelection {
  const explicit = req.options?.scenario;
  if (explicit) {
    const parsed = parseScenarioToken(explicit.trim());
    if (parsed) return parsed;
    throw new AppError(400, 'VALIDATION_FAILED', `Unknown fake scenario "${explicit}"`);
  }

  const system = req.messages.find((message) => message.role === 'system')?.content ?? '';
  const tagged = /scenario:\s*([a-z0-9-]+(?::\d+)?)/i.exec(system);
  if (tagged?.[1]) {
    const parsed = parseScenarioToken(tagged[1].toLowerCase());
    if (parsed) return parsed;
  }
  const byName = [...FAKE_SCENARIOS]
    .sort((a, b) => b.length - a.length)
    .find((scenario) => system.toLowerCase().includes(scenario));
  if (byName) return { scenario: byName, delayMs: DEFAULT_SLOW_MS };

  return { scenario: DEFAULT_SCENARIO, delayMs: DEFAULT_SLOW_MS };
}

// -------------------------------------------------------------------- helpers ----

const lastUserMessage = (req: ChatRequest): string =>
  [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

const hasToolResult = (req: ChatRequest): boolean =>
  req.messages.some((message) => message.role === 'tool');

const hasRetryFeedback = (req: ChatRequest): boolean =>
  req.messages.some((message) => message.content.includes(RETRY_MARKER));

/**
 * Token counts that are *made up but consistent*: four characters per token is the usual
 * rule of thumb, and using it here means a test can assert on the arithmetic rather than
 * on a magic constant, and that the rollup columns in `agent_runs` get plausible numbers.
 */
const tokensFor = (text: string): number => Math.ceil(text.length / 4);

const promptTokens = (req: ChatRequest): number =>
  req.messages.reduce((total, message) => total + tokensFor(message.content), 0);

/** Fixed, not measured: a fake whose latency varied would fail its own determinism test. */
const FAKE_LATENCY_MS = 42;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(499, 'REQUEST_ABORTED', 'The request was cancelled by the client'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AppError(499, 'REQUEST_ABORTED', 'The request was cancelled by the client'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const toolCall = (overrides: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall => ({
  id: 'call_fake_0',
  args: {},
  parseOk: true,
  ...overrides,
});

// ------------------------------------------------------------------- the class ----

export class FakeProvider implements ModelProvider {
  readonly name = 'fake' as const;
  private readonly model: string;

  constructor(options: FakeProviderOptions = {}) {
    this.model = options.model ?? 'fake-model';
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { scenario, delayMs } = selectScenario(req);

    if (scenario === 'error-timeout') {
      throw modelTimeout('Fake provider: simulated timeout');
    }
    if (scenario === 'error-unavailable') {
      throw modelUnavailable('Fake provider: simulated outage');
    }
    if (scenario === 'slow') {
      await sleep(delayMs, signal);
    }

    const message = this.messageFor(scenario, req);
    return {
      message,
      usage: {
        promptTokens: promptTokens(req),
        completionTokens: tokensFor(message.content),
      },
      latencyMs: FAKE_LATENCY_MS,
      providerMeta: {
        provider: 'fake',
        scenario,
        model: req.model ?? this.model,
        done_reason: message.toolCalls?.length ? 'tool_calls' : 'stop',
      },
    };
  }

  /** The scenario table proper. Pure: `(scenario, request) -> assistant message`. */
  private messageFor(scenario: FakeScenario, req: ChatRequest): ChatMessage {
    switch (scenario) {
      case 'echo':
        return { role: 'assistant', content: lastUserMessage(req) };

      case 'plain-answer':
      case 'slow':
        return {
          role: 'assistant',
          content:
            'A language model is a function from a list of messages to one more message. ' +
            'Everything else is bookkeeping.',
        };

      case 'structured-valid':
        return {
          role: 'assistant',
          content: JSON.stringify(
            typeof req.format === 'object' ? sampleFromJsonSchema(req.format) : { ok: true },
            null,
            2,
          ),
        };

      case 'structured-invalid':
        // The exact failure mode measured on gemma4:latest with `think:true`: three dates
        // as prose, `done_reason: "stop"`, no error, and not JSON at all.
        return { role: 'assistant', content: '2024-03-15\n2024-06-01\n2024-11-20' };

      case 'structured-retry-ok':
        return hasRetryFeedback(req)
          ? {
              role: 'assistant',
              content: JSON.stringify(
                typeof req.format === 'object' ? sampleFromJsonSchema(req.format) : { ok: true },
                null,
                2,
              ),
            }
          : { role: 'assistant', content: '2024-03-15\n2024-06-01\n2024-11-20' };

      case 'tool-call-once':
        return hasToolResult(req)
          ? { role: 'assistant', content: '12345 multiplied by 6789 is 83,810,205.' }
          : {
              role: 'assistant',
              content: '',
              toolCalls: [toolCall({ name: 'calculator', args: { expression: '12345 * 6789' } })],
            };

      case 'tool-call-malformed-args':
        return {
          role: 'assistant',
          content: '',
          toolCalls: [
            toolCall({
              name: 'calculator',
              args: undefined,
              rawArgs: '{"expression": "12345 *',
              parseOk: false,
            }),
          ],
        };

      case 'tool-call-unknown-tool':
        return {
          role: 'assistant',
          content: '',
          toolCalls: [toolCall({ name: 'definitely_not_a_tool', args: { anything: 1 } })],
        };

      case 'tool-call-never-stops':
        // No terminating branch on purpose: the loop must stop it, not the model.
        return {
          role: 'assistant',
          content: '',
          toolCalls: [
            toolCall({
              id: `call_fake_${req.messages.length}`,
              name: 'calculator',
              args: { expression: `1 + ${req.messages.length}` },
            }),
          ],
        };

      // Handled before this function is reached; listed so the switch stays exhaustive.
      case 'error-timeout':
      case 'error-unavailable':
        throw new AppError(500, 'INTERNAL_ERROR', 'unreachable');
    }
  }

  /**
   * Deterministic pseudo-embeddings: an FNV-1a hash of the text seeds a tiny LCG, and the
   * vector is normalised. They mean nothing semantically, but they are stable, the right
   * shape (768-dim, as `nomic-embed-text` returns), and identical inputs give identical
   * vectors — enough for a test that asserts cosine similarity is symmetric.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < text.length; i += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
      }
      let state = hash || 1;
      const vector: number[] = [];
      for (let i = 0; i < 768; i += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        vector.push(state / 0xffffffff - 0.5);
      }
      // Not `Math.hypot(...vector)`: spreading 768 arguments is a stack risk for no gain.
      let sumOfSquares = 0;
      for (const value of vector) sumOfSquares += value * value;
      const norm = Math.sqrt(sumOfSquares) || 1;
      return vector.map((value) => value / norm);
    });
  }

  async health(): Promise<ModelHealth> {
    return { ok: true, models: [this.model, 'nomic-embed-text'], detail: 'fake provider' };
  }
}
