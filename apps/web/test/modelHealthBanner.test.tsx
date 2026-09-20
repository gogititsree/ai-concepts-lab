import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentExercise } from '../src/features/exercises/agent/AgentExercise';
import { PromptExercise } from '../src/features/exercises/prompt/PromptExercise';
import { exerciseDetail } from './fixtures/content';
import { HAPPY_STEPS, runDetail, RUN_ID } from './fixtures/runs';
import { renderWithProviders } from './harness';

/**
 * The banner, as a **transition**.
 *
 * On 2026-09-20 Ollama was killed under a live Module 5 run. The run failed correctly in
 * 0.6 s, the trace was durable and complete, `model_provider_up` went to 0 in under two
 * seconds and the Grafana alert fired on schedule. The one thing that did not happen was
 * the thing the learner was looking at: the "no model attached" banner never appeared, in
 * 24 checks over 121 seconds, until the page was reloaded. See
 * `docs/postmortems/2026-09-20-ollama-down-mid-run.md`, action items 1 and 2.
 *
 * The tests that existed asserted the two *steady states* — banner absent when
 * `/model/health` says `ok`, banner present when it says it is not — and both passed
 * throughout, because the bug was never in either state. It was in the change between
 * them: `useModelHealth` had no `refetchInterval`, `refetchOnWindowFocus` is off
 * globally, and nothing invalidated the query when a call came back `MODEL_UNAVAILABLE`,
 * so a page mounted while the provider was healthy could never learn otherwise.
 *
 * So every test in this file changes the answer while the page stays mounted. None of
 * them would have passed before the fix, and none of them can be satisfied by a steady
 * state. The E2E cannot cover any of it: it runs `MODEL_PROVIDER=fake`, which is healthy
 * by construction and has no way to stop being healthy — that is *why* this lives here.
 */

const HEALTH_UP = {
  provider: 'ollama',
  ok: true,
  models: ['gemma4:latest'],
  model: 'gemma4:latest',
};
const HEALTH_DOWN = {
  provider: 'ollama',
  ok: false,
  models: [],
  model: 'gemma4:latest',
  detail: 'Could not reach the local model. Is Ollama running? Start it with `ollama serve`.',
};

/** The interval in `useChatRun.ts`. Asserted against, never relied on to make a test pass. */
const POLL_MS = 30_000;

const chatResponse = {
  message: { role: 'assistant', content: 'hello' },
  usage: { promptTokens: 12, completionTokens: 34 },
  latencyMs: 8200,
  runId: RUN_ID,
  provider: 'ollama',
  model: 'gemma4:latest',
};

/**
 * Just enough `EventSource` for `useAgentRun` to reach its settle step: jsdom has none,
 * and the agent path's whole point here is that the failure arrives on the *run row*
 * after a 202, not as a rejected POST.
 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  static readonly CLOSED = 2;
  readonly CLOSED = 2;
  readyState = 1;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }

  close(): void {
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
  /** Answers `POST /model/chat` with this status and body instead of a reply. */
  chatFailure?: { status: number; code: string; message: string };
  /** The run `GET /model/runs/:id` returns once the stream ends. */
  finishedRun?: unknown;
}

/**
 * A fetch stub whose `/model/health` answer can be changed **while the page is mounted**.
 * That single mutable variable is the whole difference between this file and the steady
 * -state tests it was written to replace.
 */
function installStub(options: StubOptions = {}) {
  const state = { health: HEALTH_UP as unknown };
  let healthCalls = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/v1/model/health') {
      healthCalls += 1;
      return json(state.health);
    }
    if (url.pathname === '/api/v1/model/chat') {
      const failure = options.chatFailure;
      if (failure) {
        return json({ error: { code: failure.code, message: failure.message } }, failure.status);
      }
      return json(chatResponse);
    }
    if (url.pathname === '/api/v1/model/runs' && method === 'POST') {
      // 202 even with the provider down: finding A of the postmortem, and the reason the
      // agent path needs the run row rather than a rejected promise.
      return json({ runId: RUN_ID, kind: 'agent', status: 'running' }, 202);
    }
    if (url.pathname === `/api/v1/model/runs/${RUN_ID}`) {
      return json(options.finishedRun ?? runDetail(HAPPY_STEPS));
    }
    if (url.pathname.startsWith('/api/v1/progress/exercises/')) return json({});
    return json({ error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
  });

  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', StubEventSource);
  StubEventSource.instances = [];
  return {
    setHealth: (value: unknown) => {
      state.health = value;
    },
    healthCalls: () => healthCalls,
  };
}

/** Run the poll timer forward one interval and let the refetch settle. */
async function tickPoll(times = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS * times + 100);
  });
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the mocked clock moving with real time, which is what lets
  // Testing Library's own `waitFor` (which does not know about vitest's fake timers) still
  // poll. The fake clock is here to jump the 30 s health interval, not to freeze the world.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  StubEventSource.instances = [];
});

// --------------------------------------------------------------- the poll ----

describe('the health poll (Module 4 playground)', () => {
  it('raises the banner on a page that was opened while the model was still up', async () => {
    const stub = installStub();
    renderWithProviders(<PromptExercise exercise={exerciseDetail('prompting')} />);

    // The state the incident started in: a healthy page, already mounted.
    await waitFor(() => expect(stub.healthCalls()).toBeGreaterThan(0));
    expect(screen.queryByTestId('model-unavailable-banner')).toBeNull();

    // 02:26:46Z: `taskkill /F /IM ollama.exe`.
    stub.setHealth(HEALTH_DOWN);
    await tickPoll();

    const banner = await screen.findByTestId('model-unavailable-banner');
    // The server's sentence, not one assembled in the browser.
    expect(banner).toHaveTextContent('ollama serve');
  });

  it('clears the banner when the provider comes back, without a reload', async () => {
    const stub = installStub();
    stub.setHealth(HEALTH_DOWN);
    renderWithProviders(<PromptExercise exercise={exerciseDetail('prompting')} />);

    await screen.findByTestId('model-unavailable-banner');

    // 02:33:15Z: `ollama serve`. The original `staleTime` comment called this "the
    // interesting transition"; it was the one direction that was never tested either.
    stub.setHealth(HEALTH_UP);
    await tickPoll();

    await waitFor(() => expect(screen.queryByTestId('model-unavailable-banner')).toBeNull());
  });

  it('keeps polling, so a provider that dies on the third interval is still caught', async () => {
    const stub = installStub();
    renderWithProviders(<PromptExercise exercise={exerciseDetail('prompting')} />);
    await waitFor(() => expect(stub.healthCalls()).toBeGreaterThan(0));

    await tickPoll(3);
    expect(screen.queryByTestId('model-unavailable-banner')).toBeNull();

    stub.setHealth(HEALTH_DOWN);
    await tickPoll();
    await screen.findByTestId('model-unavailable-banner');
  });
});

// ------------------------------------------------- the immediate refresh ----

describe('a failed call refreshes health immediately', () => {
  it('raises the banner from a 503 MODEL_UNAVAILABLE without waiting for the poll', async () => {
    const stub = installStub({
      chatFailure: {
        status: 503,
        code: 'MODEL_UNAVAILABLE',
        message: 'Could not reach the local model.',
      },
    });
    renderWithProviders(<PromptExercise exercise={exerciseDetail('prompting')} />);
    await waitFor(() => expect(stub.healthCalls()).toBe(1));

    const startedAt = Date.now();
    stub.setHealth(HEALTH_DOWN);
    fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await screen.findByTestId('model-unavailable-banner');
    // The point of the assertion: the clock has not reached the next poll. The app knew
    // the provider was gone the moment the request came back and said so then, which is
    // the half of action item 1 the postmortem calls "the important one".
    expect(Date.now() - startedAt).toBeLessThan(POLL_MS);
    expect(stub.healthCalls()).toBe(2);
  });

  it('ignores a failure that says nothing about the provider', async () => {
    const stub = installStub({
      chatFailure: { status: 500, code: 'INTERNAL', message: 'Internal server error' },
    });
    renderWithProviders(<PromptExercise exercise={exerciseDetail('prompting')} />);
    await waitFor(() => expect(stub.healthCalls()).toBe(1));

    // Health flipped, but nothing should have asked: a 500 from the chat route is not
    // evidence about Ollama, and a banner that appears on any error is a banner nobody
    // believes.
    stub.setHealth(HEALTH_DOWN);
    fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await screen.findByTestId('run-error');
    expect(stub.healthCalls()).toBe(1);
    expect(screen.queryByTestId('model-unavailable-banner')).toBeNull();
  });
});

// ------------------------------------------------------ the agent exercise ----

describe('the Module 5 agent exercise', () => {
  it('raises the banner from a run that failed with MODEL_UNAVAILABLE', async () => {
    // The incident's own run row: failed, partial trace, `error_code=MODEL_UNAVAILABLE`.
    const failed = runDetail(HAPPY_STEPS.slice(0, 3), {
      status: 'failed',
      finalOutput: null,
      errorCode: 'MODEL_UNAVAILABLE',
      errorMessage: 'Could not reach the local model. Is Ollama running?',
    });
    const stub = installStub({ finishedRun: failed });
    renderWithProviders(<AgentExercise exercise={exerciseDetail('agents')} />);
    await waitFor(() => expect(stub.healthCalls()).toBe(1));

    const startedAt = Date.now();
    stub.setHealth(HEALTH_DOWN);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    // `POST /model/runs` answered 202, so the only signal is the terminal run row that
    // arrives after the stream ends.
    await waitFor(() => expect(StubEventSource.instances).toHaveLength(1));
    await act(async () => {
      StubEventSource.last().emit('end', { ...failed, steps: undefined });
      await vi.advanceTimersByTimeAsync(50);
    });

    await screen.findByTestId('model-unavailable-banner');
    expect(Date.now() - startedAt).toBeLessThan(POLL_MS);
  });

  it('still catches a dead provider on the poll when no run is in flight', async () => {
    const stub = installStub();
    renderWithProviders(<AgentExercise exercise={exerciseDetail('agents')} />);
    await waitFor(() => expect(stub.healthCalls()).toBeGreaterThan(0));
    expect(screen.queryByTestId('model-unavailable-banner')).toBeNull();

    stub.setHealth(HEALTH_DOWN);
    await tickPoll();

    await screen.findByTestId('model-unavailable-banner');
  });
});
