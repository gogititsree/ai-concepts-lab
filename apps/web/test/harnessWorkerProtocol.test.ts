import type { ToolDefinition } from '@lab/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PageToWorkerMessage,
  StartMessage,
  WorkerToPageMessage,
} from '../src/features/exercises/harness/protocol';
import { driveWorker, toChatMessages } from '../src/features/exercises/harness/useHarnessRunner';

/**
 * The page's half of the worker protocol, against a stub `Worker`.
 *
 * **jsdom has no `Worker`.** There is no polyfill worth having either — a fake that ran
 * the module on the same thread would prove nothing about the one property the worker
 * exists for, which is that the learner's code is on a *different* thread. So the split
 * is: `harnessCore.test.ts` runs the real compile-and-loop machinery directly (the
 * worker's payload), and this file runs the real `driveWorker` against a stub that
 * records every message and can be made to reply (the worker's wiring). The only line
 * neither covers is `postMessage` itself.
 *
 * The stub is deliberately dumb: it records, and the test decides what the worker
 * "says". That is what makes the cancel and timeout paths testable at all — a real
 * worker would have to actually hang.
 */

class StubWorker {
  static instances: StubWorker[] = [];

  readonly sent: PageToWorkerMessage[] = [];
  terminated = false;
  private listeners = new Map<string, ((event: Event) => void)[]>();

  constructor() {
    StubWorker.instances.push(this);
  }

  postMessage(message: PageToWorkerMessage): void {
    this.sent.push(message);
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Pretend the worker posted this to the page. */
  emit(data: WorkerToPageMessage): void {
    for (const fn of this.listeners.get('message') ?? []) {
      fn(new MessageEvent('message', { data }) as Event);
    }
  }

  emitError(message: string): void {
    for (const fn of this.listeners.get('error') ?? []) {
      fn(new ErrorEvent('error', { message }) as Event);
    }
  }

  get start(): StartMessage {
    const found = this.sent.find((message) => message.type === 'start');
    if (!found) throw new Error('the worker was never started');
    return found as StartMessage;
  }

  static last(): StubWorker {
    const found = StubWorker.instances.at(-1);
    if (!found) throw new Error('no worker was created');
    return found;
  }
}

const TOOL: ToolDefinition = {
  name: 'calculator',
  description: 'x',
  parameters: { type: 'object' },
};

const startMessage = (over: Partial<StartMessage> = {}): StartMessage => ({
  type: 'start',
  code: 'async function runAgent() { return { finalText: "", messages: [] }; }',
  mode: 'real',
  runId: '11111111-2222-4333-8444-555555555555',
  scenario: null,
  maxIterations: 4,
  userMessage: 'What is 17 * 23?',
  systemPrompt: '',
  toolDefs: [TOOL],
  deadlineMs: 5000,
  ...over,
});

interface Recorded {
  logs: { level: string; text: string }[];
  steps: unknown[];
  modelRequests: number;
}

function drive(
  over: Partial<Parameters<typeof driveWorker>[0]> = {},
  recorded: Recorded = { logs: [], steps: [], modelRequests: 0 },
) {
  const handle = driveWorker({
    createWorker: () => new StubWorker() as unknown as Worker,
    start: startMessage(),
    timeoutMs: 5000,
    onLog: (level, text) => recorded.logs.push({ level, text }),
    onStep: (step) => recorded.steps.push(step),
    onModelRequest: async () => {
      recorded.modelRequests += 1;
      return { content: 'It is 391.', toolCalls: [] };
    },
    ...over,
  });
  return { handle, worker: StubWorker.last(), recorded };
}

beforeEach(() => {
  StubWorker.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('starting a worker', () => {
  it('posts exactly one start message carrying the code and the mode', async () => {
    const { handle, worker } = drive();
    expect(worker.sent).toHaveLength(1);
    expect(worker.start.mode).toBe('real');
    expect(worker.start.code).toContain('runAgent');
    expect(worker.start.toolDefs).toEqual([TOOL]);

    worker.emit({ type: 'done', finalText: 'It is 391.', messages: [], modelCalls: 2 });
    await expect(handle.outcome).resolves.toMatchObject({ ok: true, finalText: 'It is 391.' });
  });

  it('always terminates the worker, on every path', async () => {
    for (const finish of [
      (worker: StubWorker) =>
        worker.emit({ type: 'done', finalText: '', messages: [], modelCalls: 0 }),
      (worker: StubWorker) =>
        worker.emit({ type: 'error', message: 'boom', stack: null, modelCalls: 1, messages: [] }),
      (worker: StubWorker) => worker.emitError('failed to load'),
    ]) {
      StubWorker.instances = [];
      const { handle, worker } = drive();
      finish(worker);
      await handle.outcome;
      expect(worker.terminated).toBe(true);
    }
  });
});

describe('the model round trip', () => {
  it('answers a model-request through the page and never lets the worker fetch', async () => {
    const seen: { messages: unknown; defs: unknown; iteration: number }[] = [];
    const { handle, worker } = drive({
      onModelRequest: async (messages, defs, iteration) => {
        seen.push({ messages, defs, iteration });
        return { content: 'It is 391.', toolCalls: [] };
      },
    });

    worker.emit({
      type: 'model-request',
      id: 1,
      messages: [{ role: 'user', content: 'What is 17 * 23?' }],
      toolDefs: [TOOL],
      iteration: 1,
    });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));

    const reply = worker.sent[1] as Extract<PageToWorkerMessage, { type: 'model-response' }>;
    expect(reply).toMatchObject({ type: 'model-response', id: 1, ok: true });
    expect(reply.reply?.content).toBe('It is 391.');
    expect(seen[0]?.defs).toEqual([TOOL]);
    // Passed through to POST /model/chat, so the server's `model_call` row lands in the
    // same iteration group as the tool rows this pass reports.
    expect(seen[0]?.iteration).toBe(1);

    worker.emit({ type: 'done', finalText: 'It is 391.', messages: [], modelCalls: 1 });
    await handle.outcome;
  });

  it('sends a failed model call back as an error rather than dropping it', async () => {
    const { handle, worker } = drive({
      onModelRequest: () => Promise.reject(new Error('503 model unavailable')),
    });
    worker.emit({ type: 'model-request', id: 7, messages: [], toolDefs: [], iteration: 1 });
    await vi.waitFor(() => expect(worker.sent).toHaveLength(2));
    expect(worker.sent[1]).toMatchObject({
      type: 'model-response',
      id: 7,
      ok: false,
      error: '503 model unavailable',
    });
    worker.emit({
      type: 'error',
      message: '503 model unavailable',
      stack: null,
      modelCalls: 1,
      messages: [],
    });
    await expect(handle.outcome).resolves.toMatchObject({ ok: false });
  });
});

describe('steps and logs', () => {
  it('forwards each step and each console line to the page', async () => {
    const { handle, worker, recorded } = drive();
    worker.emit({
      type: 'step',
      step: { kind: 'tool_call', iteration: 1, toolName: 'calculator', isError: false },
    });
    worker.emit({ type: 'log', level: 'log', text: 'iteration 1' });
    worker.emit({ type: 'log', level: 'error', text: 'oops' });
    expect(recorded.steps).toHaveLength(1);
    expect(recorded.logs).toEqual([
      { level: 'log', text: 'iteration 1' },
      { level: 'error', text: 'oops' },
    ]);
    worker.emit({ type: 'done', finalText: '', messages: [], modelCalls: 1 });
    await handle.outcome;
  });
});

describe('stopping', () => {
  it('cancel asks politely, then takes the thread away', async () => {
    const { handle, worker } = drive();
    handle.cancel();
    expect(worker.sent[1]).toEqual({ type: 'cancel' });
    expect(worker.terminated).toBe(true);
    await expect(handle.outcome).resolves.toMatchObject({ ok: false, error: 'Cancelled.' });
  });

  it('ignores anything the worker says after it has been cancelled', async () => {
    const { handle, worker } = drive();
    handle.cancel();
    worker.emit({ type: 'done', finalText: 'too late', messages: [], modelCalls: 9 });
    await expect(handle.outcome).resolves.toMatchObject({ error: 'Cancelled.' });
  });

  it('terminates a worker that never answers, because nothing else can', async () => {
    vi.useFakeTimers();
    const { handle, worker } = drive({ timeoutMs: 60_000 });
    vi.advanceTimersByTime(60_001);
    expect(worker.terminated).toBe(true);
    const result = await handle.outcome;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/still running after 60 seconds/);
  });

  it('reports a worker that failed to start instead of hanging for the whole timeout', async () => {
    const { handle, worker } = drive();
    worker.emitError('Failed to construct Worker');
    await expect(handle.outcome).resolves.toMatchObject({
      ok: false,
      error: 'Failed to construct Worker',
    });
  });
});

describe('toChatMessages', () => {
  it('passes a well-formed transcript through unchanged in substance', () => {
    const out = toChatMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'calculator', args: { expression: '1+1' }, parseOk: true }],
      },
      { role: 'tool', toolName: 'calculator', content: '{"result":2}' },
    ]);
    expect(out.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[1]?.toolCalls?.[0]?.name).toBe('calculator');
    expect(out[2]?.toolName).toBe('calculator');
  });

  it('repairs what a learner s loop might plausibly get wrong', () => {
    const out = toChatMessages([
      { role: 'user', content: { text: 'an object' } as unknown as string },
      { role: 'wizard', content: 'x' } as unknown as { role: 'user'; content: string },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '', name: 'calculator', args: null, parseOk: false }],
      },
    ]);
    // The bogus role is dropped rather than sent: the API would 400 the whole request
    // and the learner would see a validation error instead of their own bug.
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe('{"text":"an object"}');
    expect(out[1]?.toolCalls?.[0]?.id).toBe('call_1');
  });
});
