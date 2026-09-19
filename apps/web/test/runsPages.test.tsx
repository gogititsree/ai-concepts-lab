import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunDetailPage } from '../src/routes/runs/RunDetailPage';
import { RunsPage } from '../src/routes/runs/RunsPage';
import { HAPPY_STEPS, runDetail, runSummary, RUN_ID } from './fixtures/runs';
import { renderWithProviders } from './harness';

/**
 * `/runs` and `/runs/:id`.
 *
 * The detail page is the shared trace viewer with a header on it, so these tests are
 * about the wiring rather than the rendering (which `agentTrace.test.tsx` covers): the
 * right run is fetched, a missing one is a 404 rather than a crash, a failed run shows
 * its error, and a run that is still going opens a stream instead of showing a snapshot.
 */

class StubEventSource {
  static opened: string[] = [];
  static readonly CLOSED = 2;
  readonly CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) {
    StubEventSource.opened.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

function installStub(routes: Record<string, { body: unknown; status?: number }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${url.pathname}${url.search}`;
    const match = routes[key] ?? routes[url.pathname];
    if (!match) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', StubEventSource);
  StubEventSource.opened = [];
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  StubEventSource.opened = [];
});

const detailAt = (path: string) =>
  renderWithProviders(
    <Routes>
      <Route path="/runs/:id" element={<RunDetailPage />} />
    </Routes>,
    { path },
  );

describe('/runs', () => {
  it('lists runs newest first with kind, status, counters and a link', async () => {
    installStub({
      '/api/v1/model/runs': {
        body: {
          runs: [
            runSummary({ id: RUN_ID }),
            runSummary({
              id: '22222222-3333-4444-8555-666666666666',
              kind: 'prompt',
              status: 'failed',
              errorCode: 'MODEL_TIMEOUT',
              iterationCount: 1,
              toolCallCount: 0,
            }),
          ],
          nextCursor: null,
        },
      },
    });
    renderWithProviders(<RunsPage />);

    const list = await screen.findByTestId('runs-list');
    expect(list.children).toHaveLength(2);
    const first = screen.getByTestId(`run-${RUN_ID}`);
    expect(first).toHaveTextContent('completed');
    expect(first).toHaveTextContent('agent');
    expect(first).toHaveTextContent('2 iter · 1 tools');
    expect(first).toHaveTextContent('574 tok');
    expect(first).toHaveTextContent('32.0 s');
    expect(first.querySelector('a')).toHaveAttribute('href', `/runs/${RUN_ID}`);
  });

  it('says so when there are none, rather than showing an empty box', async () => {
    installStub({ '/api/v1/model/runs': { body: { runs: [], nextCursor: null } } });
    renderWithProviders(<RunsPage />);
    expect(await screen.findByTestId('runs-empty')).toBeInTheDocument();
  });

  it('asks a signed-out visitor to sign in', async () => {
    installStub({
      '/api/v1/model/runs': {
        body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        status: 401,
      },
    });
    renderWithProviders(<RunsPage />);
    expect(await screen.findByTestId('sign-in-panel')).toBeInTheDocument();
  });
});

describe('/runs/:id', () => {
  it('shows the prompts, the tools, the rollups and the trace', async () => {
    installStub({ [`/api/v1/model/runs/${RUN_ID}`]: { body: runDetail(HAPPY_STEPS) } });
    detailAt(`/runs/${RUN_ID}`);

    const summary = await screen.findByTestId('run-summary');
    expect(summary).toHaveTextContent('completed');
    expect(summary).toHaveTextContent('2/6');
    expect(summary).toHaveTextContent('530/44');
    expect(summary).toHaveTextContent('31.6 s');

    expect(screen.getByTestId('run-tools')).toHaveTextContent('calculator');
    expect(screen.getByTestId('run-final')).toHaveTextContent('$4295.47');
    expect(screen.getByTestId('step-0')).toBeInTheDocument();
    expect(screen.getByTestId('step-4')).toBeInTheDocument();
    // A finished run must not open a stream: EventSource would reconnect forever.
    expect(StubEventSource.opened).toEqual([]);
  });

  it('shows the error code and message of a failed run', async () => {
    installStub({
      [`/api/v1/model/runs/${RUN_ID}`]: {
        body: runDetail([], {
          status: 'failed',
          errorCode: 'MODEL_UNAVAILABLE',
          errorMessage: 'Ollama went away',
          finalOutput: null,
        }),
      },
    });
    detailAt(`/runs/${RUN_ID}`);
    expect(await screen.findByTestId('run-error')).toHaveTextContent('MODEL_UNAVAILABLE');
    expect(screen.getByTestId('trace-empty')).toBeInTheDocument();
  });

  it('tails a run that is still going', async () => {
    installStub({
      [`/api/v1/model/runs/${RUN_ID}`]: {
        body: runDetail(HAPPY_STEPS.slice(0, 1), { status: 'running', finishedAt: null }),
      },
    });
    detailAt(`/runs/${RUN_ID}`);
    await screen.findByTestId('run-summary');
    await waitFor(() =>
      expect(StubEventSource.opened).toEqual([`/api/v1/model/runs/${RUN_ID}/events`]),
    );
  });

  it('renders a not-found page for a run that is not yours', async () => {
    installStub({});
    detailAt('/runs/99999999-9999-4999-8999-999999999999');
    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
  });
});
