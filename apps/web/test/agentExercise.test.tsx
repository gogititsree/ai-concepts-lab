import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentExercise } from '../src/features/exercises/agent/AgentExercise';
import { exerciseDetail } from './fixtures/content';
import { HAPPY_STEPS, runDetail, RUN_ID } from './fixtures/runs';
import { renderWithProviders } from './harness';

/**
 * The Module 5 playground against a mocked API and a stub `EventSource`.
 *
 * No test here calls a model, or the real API. What is being exercised is the part of
 * the feature that is genuinely tricky: a three-phase run (create → stream → settle)
 * where the interesting states are the waiting and the cancelling, plus a task that only
 * ticks once the *persisted* run says it should.
 */

const HEALTH_UP = {
  provider: 'ollama',
  ok: true,
  models: ['gemma4:latest'],
  model: 'gemma4:latest',
};
const HEALTH_DOWN = {
  provider: 'none',
  ok: false,
  models: [],
  model: 'gemma4:latest',
  detail: 'MODEL_PROVIDER=none: this deployment has no model attached.',
};

// ------------------------------------------------------- the EventSource stub ----

/**
 * jsdom has no `EventSource`, and mocking `fetch` would not help: the hook uses the real
 * browser API precisely so the browser's own reconnect-with-`Last-Event-ID` does the
 * resumption. So the test provides one, and the test drives it.
 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  static readonly CLOSED = 2;
  readonly CLOSED = 2;
  readyState = 1;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(name: string, data: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) {
      fn(new MessageEvent(name, { data: JSON.stringify(data) }));
    }
  }

  static last(): StubEventSource {
    const found = StubEventSource.instances.at(-1);
    if (!found) throw new Error('no EventSource was opened');
    return found;
  }
}

interface StubOptions {
  health?: unknown;
  /** The run returned by the settle-time GET. */
  finishedRun?: unknown;
  /** Makes POST /model/runs fail, e.g. the 409 semaphore. */
  createStatus?: number;
  createBody?: unknown;
}

function installStub(options: StubOptions = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/v1/model/health') return json(options.health ?? HEALTH_UP);
    if (url.pathname === '/api/v1/model/runs' && method === 'POST') {
      if (options.createStatus) return json(options.createBody, options.createStatus);
      return json({ runId: RUN_ID, kind: 'agent', status: 'running' }, 202);
    }
    if (url.pathname === `/api/v1/model/runs/${RUN_ID}/cancel`)
      return json({ runId: RUN_ID, status: 'cancelled' });
    if (url.pathname === `/api/v1/model/runs/${RUN_ID}`) {
      return json(options.finishedRun ?? runDetail(HAPPY_STEPS));
    }
    if (url.pathname.startsWith('/api/v1/progress/exercises/')) return json({});
    return json({ error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', StubEventSource);
  StubEventSource.instances = [];
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubEventSource.instances = [];
});

const exercise = exerciseDetail('agents');

const render = () => renderWithProviders(<AgentExercise exercise={exercise} />);

// -------------------------------------------------------------------- the tests ----

describe('mounting', () => {
  it('shows the prompts, the whole tool catalog and the four tasks', async () => {
    installStub();
    render();

    expect(screen.getByLabelText('System prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('User message')).toBeInTheDocument();
    expect(screen.getByLabelText('Max iterations')).toHaveValue(6);
    for (const tool of ['calculator', 'get_current_time', 'lookup_glossary', 'flaky_service']) {
      expect(screen.getByLabelText(tool)).toBeInTheDocument();
    }
    for (const id of ['compound-interest', 'must-check-time', 'mock-tool', 'observe-failure']) {
      expect(screen.getByTestId(`task-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/2 to complete');
    expect(screen.getByTestId('agent-trace')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('model-unavailable-banner')).toBeNull());
  });

  it('shows the run-it-locally banner when no model is attached', async () => {
    installStub({ health: HEALTH_DOWN });
    render();
    const banner = await screen.findByTestId('model-unavailable-banner');
    expect(banner).toHaveTextContent('MODEL_PROVIDER=none');
  });
});

describe('running an agent', () => {
  it('posts the prompts and the ticked tools, then streams the trace and settles', async () => {
    const { calls } = installStub();
    render();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(
        calls.some((call) => call.method === 'POST' && call.path === '/api/v1/model/runs'),
      ).toBe(true);
    });
    const created = calls.find((call) => call.path === '/api/v1/model/runs')?.body as {
      kind: string;
      tools: { catalog: string[] };
      maxIterations: number;
      exerciseId: string;
    };
    expect(created.kind).toBe('agent');
    expect(created.tools.catalog).toEqual(['calculator']);
    expect(created.maxIterations).toBe(6);
    expect(created.exerciseId).toBe(exercise.id);

    // The elapsed counter is up while we wait: a two-minute run with no feedback is a
    // hang as far as anyone looking at it is concerned.
    expect(await screen.findByTestId('elapsed')).toBeInTheDocument();

    const source = await waitFor(() => StubEventSource.last());
    expect(source.url).toContain(`/model/runs/${RUN_ID}/events`);

    for (const entry of HAPPY_STEPS) source.emit('step', entry);
    expect(await screen.findByTestId('step-0')).toBeInTheDocument();
    expect(screen.getByTestId('trace-count')).toHaveTextContent('5 steps');

    source.emit('end', { id: RUN_ID, status: 'completed' });
    // The stream must be closed on `end`, or EventSource reconnects forever.
    expect(source.closed).toBe(true);

    const answer = await screen.findByTestId('final-answer');
    expect(answer).toHaveTextContent('The balance after 8 years is $4295.47.');
    expect(within(answer).getByText('completed')).toBeInTheDocument();
  });

  it('ticks compound-interest against the persisted run and saves it', async () => {
    const { calls } = installStub();
    render();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const source = await waitFor(() => StubEventSource.last());
    source.emit('end', { id: RUN_ID, status: 'completed' });

    await waitFor(() =>
      expect(screen.getByTestId('task-list')).toHaveTextContent('1/2 to complete'),
    );
    await waitFor(() => {
      const saved = calls.find(
        (call) => call.method === 'PUT' && call.path.startsWith('/api/v1/progress/exercises/'),
      );
      expect((saved?.body as { tasksCompleted?: string[] })?.tasksCompleted).toContain(
        'compound-interest',
      );
    });
  });

  it('cancels a run in flight and reports what the server says happened', async () => {
    const { calls } = installStub({
      finishedRun: runDetail(HAPPY_STEPS.slice(0, 2), {
        status: 'cancelled',
        finalOutput: null,
        errorCode: 'RUN_CANCELLED',
        errorMessage: 'Cancelled by the user',
      }),
    });
    render();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const source = await waitFor(() => StubEventSource.last());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(calls.some((call) => call.path === `/api/v1/model/runs/${RUN_ID}/cancel`)).toBe(true),
    );
    source.emit('end', { id: RUN_ID, status: 'cancelled' });

    const answer = await screen.findByTestId('final-answer');
    expect(answer).toHaveTextContent(/ended as\s*cancelled/);
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/2 to complete');
  });

  it('shows the 409 when another run of theirs is already going', async () => {
    installStub({
      createStatus: 409,
      createBody: {
        error: { code: 'RUN_IN_PROGRESS', message: 'You already have an agent run in progress.' },
      },
    });
    render();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('run-error')).toHaveTextContent(/already have an agent run/);
  });
});

describe('loading a task', () => {
  it('fills the prompts and ticks exactly the tools that task needs', async () => {
    installStub();
    render();

    fireEvent.click(screen.getByRole('button', { name: 'must-check-time' }));
    expect(screen.getByLabelText('User message')).toHaveValue(
      'What day of the week is it today in London?',
    );
    expect(screen.getByLabelText('get_current_time')).toBeChecked();
    expect(screen.getByLabelText('calculator')).not.toBeChecked();
    expect(screen.getByLabelText('Max iterations')).toHaveValue(4);
  });
});

describe('the mock-tool builder', () => {
  it('refuses an invalid draft and accepts a good one, then sends it with the run', async () => {
    const { calls } = installStub();
    render();

    fireEvent.click(screen.getByTestId('toggle-mock-tool'));
    fireEvent.change(screen.getByLabelText('Mock tool name'), { target: { value: '2bad' } });
    fireEvent.click(screen.getByTestId('add-mock-tool'));
    expect(screen.getByTestId('mock-tool-invalid')).toBeInTheDocument();

    // The template pre-fills a valid description, schema and response; fix the name.
    fireEvent.change(screen.getByLabelText('Mock tool name'), {
      target: { value: 'get_order_status' },
    });
    fireEvent.click(screen.getByTestId('add-mock-tool'));
    expect(await screen.findByTestId('mock-tool-get_order_status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => {
      const body = calls.find((call) => call.path === '/api/v1/model/runs')?.body as {
        tools: { mock: { name: string }[] };
      };
      expect(body.tools.mock.map((tool) => tool.name)).toEqual(['get_order_status']);
    });
  });
});
