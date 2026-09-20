import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE_DEBOUNCE_MS } from '../src/features/content/useExercisePersistence';
import { HarnessExercise } from '../src/features/exercises/harness/HarnessExercise';
import type {
  PageToWorkerMessage,
  StartMessage,
  WorkerToPageMessage,
} from '../src/features/exercises/harness/protocol';
import {
  BROKEN_NO_TOOL_MESSAGE,
  REFERENCE_SOLUTION,
} from '../src/features/exercises/harness/reference';
import { runScriptedScenario } from '../src/features/exercises/harness/scriptedRunner';
import { exerciseDetail, installApiMock } from './fixtures/content';
import { runDetail, RUN_ID, step } from './fixtures/runs';
import { renderWithProviders } from './harness';

/**
 * The Module 6 exercise, mounted, against a mocked API and a simulated `Worker`.
 *
 * jsdom has no `Worker`, so the stub below does what the real one does — it runs
 * `runScriptedScenario` — only on this thread. That is an honest substitution for *this*
 * suite's purpose, which is the component: the code goes in, three checks come back,
 * ticks appear, progress is saved. The two properties the substitution cannot show (that
 * the loop is on another thread, and that the message protocol is correct) are covered
 * where they can be: `harnessCore.test.ts` runs the real machinery, and
 * `harnessWorkerProtocol.test.ts` drives the real `driveWorker` against a recording stub.
 */

const exercise = exerciseDetail('harnesses');
const SAVE_ROUTE = `PUT /api/v1/progress/exercises/${exercise.id}`;

const HEALTH_UP = {
  body: { provider: 'ollama', ok: true, models: ['gemma4:latest'], model: 'gemma4:latest' },
};
const HEALTH_DOWN = {
  body: {
    provider: 'none',
    ok: false,
    models: [],
    model: 'gemma4:latest',
    detail: 'MODEL_PROVIDER=none: this deployment has no model attached.',
  },
};

// ------------------------------------------------------------------- the stub ----

class ScriptedStubWorker {
  static instances: ScriptedStubWorker[] = [];
  static hang = false;

  terminated = false;
  private listeners: ((event: Event) => void)[] = [];

  constructor() {
    ScriptedStubWorker.instances.push(this);
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    if (name === 'message') this.listeners.push(fn);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(message: PageToWorkerMessage): void {
    if (message.type !== 'start') return;
    if (ScriptedStubWorker.hang) return; // never answers: the cancel/timeout path
    void this.run(message);
  }

  private async run(message: StartMessage): Promise<void> {
    const outcome = await runScriptedScenario({
      scenario: message.scenario ?? 'single-tool',
      code: message.code,
      maxIterations: message.maxIterations,
      onLog: (level, text) => this.emit({ type: 'log', level, text }),
    });
    if (this.terminated) return;
    this.emit(
      outcome.ok
        ? {
            type: 'done',
            finalText: outcome.finalText,
            messages: outcome.messages,
            modelCalls: outcome.modelCalls,
          }
        : {
            type: 'error',
            message: outcome.error ?? 'failed',
            stack: null,
            modelCalls: outcome.modelCalls,
            messages: [],
          },
    );
  }

  private emit(data: WorkerToPageMessage): void {
    for (const fn of this.listeners) fn(new MessageEvent('message', { data }) as Event);
  }
}

const createWorker = () => new ScriptedStubWorker() as unknown as Worker;

const render = (over: Parameters<typeof exerciseDetail>[1] = {}) =>
  renderWithProviders(
    <HarnessExercise exercise={exerciseDetail('harnesses', over)} createWorker={createWorker} />,
  );

const setCode = (code: string): void => {
  fireEvent.change(screen.getByTestId('code-editor'), { target: { value: code } });
};

beforeEach(() => {
  ScriptedStubWorker.instances = [];
  ScriptedStubWorker.hang = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// -------------------------------------------------------------------- the tests ----

describe('mounting', () => {
  it('opens with the starter code, the four tasks and the buttons', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render();

    const editor = screen.getByTestId('code-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('async function runAgent');
    expect(editor.value).toContain('TODO 1');
    // The starter must not be a working loop, or every check is green on arrival.
    expect(editor.value).not.toContain("role: 'tool'");

    for (const id of [
      'check-terminates',
      'check-appends-tool-message',
      'check-max-iterations',
      'real-run',
    ]) {
      expect(screen.getByTestId(`task-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/3 to complete');
    expect(screen.getByTestId('run-scripted')).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('run-real')).toBeEnabled());
  });

  it('restores the learner s saved code instead of the starter', () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render({ state: { code: '// my work in progress\n' } });
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe(
      '// my work in progress\n',
    );
  });

  it('keeps the scripted checks available when no model is attached', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_DOWN, [SAVE_ROUTE]: { body: {} } });
    render();

    const banner = await screen.findByTestId('model-unavailable-banner');
    expect(banner).toHaveTextContent('MODEL_PROVIDER=none');
    // The whole point of the scripted fake: the module stays completable.
    expect(screen.getByTestId('run-scripted')).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('run-real')).toBeDisabled());
  });
});

describe('running the scripted checks', () => {
  it('passes all three for the reference solution and saves the task ids', async () => {
    const api = installApiMock({
      'GET /api/v1/model/health': HEALTH_UP,
      [SAVE_ROUTE]: { body: {} },
    });
    render();

    setCode(REFERENCE_SOLUTION);
    fireEvent.click(screen.getByTestId('run-scripted'));

    await waitFor(() =>
      expect(screen.getByTestId('task-list')).toHaveTextContent('3/3 to complete'),
    );
    // One worker per scenario, each terminated: a spinning loop in one must not take
    // the other two down with it.
    expect(ScriptedStubWorker.instances).toHaveLength(3);
    expect(ScriptedStubWorker.instances.every((worker) => worker.terminated)).toBe(true);

    await waitFor(() => {
      const saved = api.bodies.filter(
        (body) => (body as { tasksCompleted?: string[] }).tasksCompleted !== undefined,
      );
      expect((saved.at(-1) as { tasksCompleted: string[] }).tasksCompleted).toEqual([
        'check-appends-tool-message',
        'check-max-iterations',
        'check-terminates',
      ]);
    });
    // The optional real run is not one of them.
    expect(api.bodies.some((body) => JSON.stringify(body).includes('real-run'))).toBe(false);
  });

  it('shows the failing check s reason, not a bare red tick', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render();

    setCode(BROKEN_NO_TOOL_MESSAGE);
    fireEvent.click(screen.getByTestId('run-scripted'));

    await waitFor(() =>
      expect(screen.getByTestId('task-list')).toHaveTextContent('2/3 to complete'),
    );
    expect(screen.getByTestId('task-check-appends-tool-message')).toHaveTextContent(
      /No message with role 'tool'/,
    );
  });

  it('surfaces the learner s console.log in the console panel', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render();

    setCode(
      "async function runAgent() { console.log('hello from my loop'); return { finalText: '', messages: [] }; }",
    );
    fireEvent.click(screen.getByTestId('run-scripted'));

    await waitFor(() =>
      expect(screen.getByTestId('harness-console')).toHaveTextContent('hello from my loop'),
    );
    // Prefixed with the scenario, because three runs write into one panel.
    expect(screen.getByTestId('harness-console')).toHaveTextContent('[single-tool]');
  });

  it('reports a syntax error against every check rather than crashing', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render();

    setCode('async function runAgent( {');
    fireEvent.click(screen.getByTestId('run-scripted'));

    await waitFor(() =>
      expect(screen.getByTestId('task-check-terminates')).toHaveTextContent(/did not compile/),
    );
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/3 to complete');
  });
});

describe('cancelling', () => {
  it('terminates the worker and stops the run', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    ScriptedStubWorker.hang = true;
    render();

    fireEvent.click(screen.getByTestId('run-scripted'));
    await waitFor(() => expect(screen.getByTestId('elapsed')).toBeInTheDocument());
    expect(ScriptedStubWorker.instances).toHaveLength(1);

    fireEvent.click(screen.getByTestId('cancel'));
    expect(ScriptedStubWorker.instances[0]?.terminated).toBe(true);
    // And no second scenario was started: cancel stops the sweep, not just the run.
    expect(ScriptedStubWorker.instances).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId('elapsed')).toBeNull());
  });

  it('terminates the worker on unmount, so navigating away does not leak a thread', async () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    ScriptedStubWorker.hang = true;
    const view = render();

    fireEvent.click(screen.getByTestId('run-scripted'));
    await waitFor(() => expect(ScriptedStubWorker.instances).toHaveLength(1));
    view.unmount();
    expect(ScriptedStubWorker.instances[0]?.terminated).toBe(true);
  });
});

describe('the code survives', () => {
  it('round-trips through the debounced save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = installApiMock({
      'GET /api/v1/model/health': HEALTH_UP,
      [SAVE_ROUTE]: { body: {} },
    });
    render();

    setCode('// half an implementation\n');
    act(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS + 10));

    await waitFor(() => {
      const saved = api.bodies.filter((body) => (body as { state?: unknown }).state !== undefined);
      expect((saved.at(-1) as { state: { code: string } }).state.code).toBe(
        '// half an implementation\n',
      );
    });

    // And the saved value is what a fresh mount opens with.
    vi.useRealTimers();
    render({ state: { code: '// half an implementation\n' } });
    expect(
      screen.getAllByTestId('code-editor').map((node) => (node as HTMLTextAreaElement).value),
    ).toContain('// half an implementation\n');
  });

  it('only resets to the starter after a confirmation', () => {
    installApiMock({ 'GET /api/v1/model/health': HEALTH_UP, [SAVE_ROUTE]: { body: {} } });
    render({ state: { code: '// precious\n' } });

    fireEvent.click(screen.getByTestId('reset-code'));
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toBe('// precious\n');
    expect(screen.getByTestId('reset-code')).toHaveTextContent('Really reset?');

    fireEvent.click(screen.getByTestId('reset-code'));
    expect((screen.getByTestId('code-editor') as HTMLTextAreaElement).value).toContain('TODO 1');
  });
});

// ------------------------------------------------- the real run, end to end ----

/**
 * A stub that plays the real-mode protocol rather than the scripted one: it asks the
 * page for a model call, reports the three steps a one-tool run produces, and finishes.
 * What is being tested here is the *page's* side — that it opens a harness run, posts
 * the chat with the run id attached, files each step and reads the run back — which is
 * exactly the path `apps/api/test/integration/agent-runs.test.ts` verifies from the
 * other end.
 */
class RealStubWorker {
  static instances: RealStubWorker[] = [];
  terminated = false;
  private listeners: ((event: Event) => void)[] = [];

  constructor() {
    RealStubWorker.instances.push(this);
  }

  addEventListener(name: string, fn: (event: Event) => void): void {
    if (name === 'message') this.listeners.push(fn);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(message: PageToWorkerMessage): void {
    if (message.type === 'start') {
      this.emit({
        type: 'model-request',
        id: 1,
        messages: [{ role: 'user', content: message.userMessage }],
        toolDefs: message.toolDefs,
        iteration: 1,
      });
      return;
    }
    if (message.type !== 'model-response') return;
    this.emit({
      type: 'step',
      step: {
        clientStepId: 'c1',
        kind: 'tool_call',
        iteration: 1,
        toolName: 'calculator',
        toolArgs: { expression: '2500 * (1 + 0.07)^8' },
        isError: false,
      },
    });
    this.emit({
      type: 'step',
      step: {
        clientStepId: 'c2',
        kind: 'final',
        iteration: 2,
        content: 'The balance after 8 years is $4295.47.',
        isError: false,
      },
    });
    this.emit({
      type: 'done',
      finalText: 'The balance after 8 years is $4295.47.',
      messages: [],
      modelCalls: 2,
    });
  }

  private emit(data: WorkerToPageMessage): void {
    for (const fn of this.listeners) fn(new MessageEvent('message', { data }) as Event);
  }
}

describe('running against the real model', () => {
  const CHAT_RESPONSE = {
    body: {
      message: { role: 'assistant', content: 'The balance after 8 years is $4295.47.' },
      usage: { promptTokens: 227, completionTokens: 27 },
      latencyMs: 23548,
      runId: RUN_ID,
      provider: 'ollama',
      model: 'gemma4:latest',
    },
  };

  it('opens a harness run, files the steps and ticks the optional task', async () => {
    RealStubWorker.instances = [];
    const finalStep = step(1, 'final', {
      iteration: 2,
      content: 'The balance after 8 years is $4295.47.',
    });
    const api = installApiMock({
      'GET /api/v1/model/health': HEALTH_UP,
      [SAVE_ROUTE]: { body: {} },
      'POST /api/v1/model/runs': {
        status: 202,
        body: { runId: RUN_ID, kind: 'harness', status: 'running' },
      },
      'POST /api/v1/model/chat': CHAT_RESPONSE,
      [`POST /api/v1/model/runs/${RUN_ID}/steps`]: { status: 201, body: { steps: [finalStep] } },
      [`GET /api/v1/model/runs/${RUN_ID}`]: {
        body: runDetail([step(0, 'model_call', { latencyMs: 23548 }), finalStep], {
          kind: 'harness',
        }),
      },
    });

    renderWithProviders(
      <HarnessExercise
        exercise={exerciseDetail('harnesses')}
        createWorker={() => new RealStubWorker() as unknown as Worker}
      />,
    );

    fireEvent.click(screen.getByTestId('run-real'));

    await waitFor(() => expect(screen.getByTestId('real-run-summary')).toBeInTheDocument());

    const created = api.bodies.find((body) => (body as { kind?: string }).kind === 'harness') as {
      kind: string;
      maxIterations: number;
      exerciseId: string;
    };
    expect(created.kind).toBe('harness');
    expect(created.maxIterations).toBe(4);

    // Every model call carries the run id, so the *server* writes the `model_call` step
    // with the latency and tokens it measured. The client never reports one.
    const chat = api.bodies.find((body) => (body as { runId?: string }).runId === RUN_ID) as {
      runId: string;
      tools: { name: string }[];
    };
    expect(chat.tools.map((tool) => tool.name)).toEqual(['calculator', 'get_current_time']);

    const reported = api.bodies.filter(
      (body) => (body as { steps?: unknown[] }).steps !== undefined,
    ) as { steps: { kind: string }[] }[];
    expect(reported.flatMap((body) => body.steps.map((entry) => entry.kind))).toEqual([
      'tool_call',
      'final',
    ]);

    expect(screen.getByTestId('real-run-summary')).toHaveTextContent('$4295.47');
    await waitFor(() =>
      expect(screen.getByTestId('task-list')).toHaveTextContent('1/3 to complete'),
    );
    expect(RealStubWorker.instances[0]?.terminated).toBe(true);
  });
});
