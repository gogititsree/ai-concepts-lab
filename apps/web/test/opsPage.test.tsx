import type { SliResponse } from '@lab/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpsPage } from '../src/routes/OpsPage';
import { renderWithProviders } from './harness';

/**
 * `/ops`.
 *
 * The page is a dashboard, so the assertions are about the three things a dashboard can
 * get wrong in a way nobody notices:
 *
 *  - **An empty window must not read as a failing one.** `successRate: null` is "no runs
 *    finished", and rendering it as `0 %` in red would be a lie told to every learner on
 *    their first visit.
 *  - **The thresholds must match the SLOs.** A meter that turns red at the wrong number
 *    is worse than no meter.
 *  - **Nothing is knowable by hue alone.** Every segment of the outcome bar also appears
 *    as a named count in the legend, which is what the data-viz method requires when an
 *    adjacent colour pair sits in the CVD warn band (see `features/ops/palette.ts`).
 */

const emptySli: SliResponse = {
  window: { hours: 24, from: '2026-09-18T12:00:00.000Z', to: '2026-09-19T12:00:00.000Z' },
  runs: {
    total: 0,
    terminal: 0,
    byStatus: { running: 0, completed: 0, failed: 0, cancelled: 0, maxIterations: 0 },
    successRate: null,
    badOutcomeShare: null,
  },
  modelCalls: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
  tools: [],
  iterations: {
    buckets: [
      { le: 1, count: 0 },
      { le: 2, count: 0 },
      { le: 3, count: 0 },
      { le: 5, count: 0 },
      { le: 8, count: 0 },
      { le: 15, count: 0 },
      { le: null, count: 0 },
    ],
    total: 0,
    meanPerRun: null,
  },
  errorCodes: [],
  tokens: { promptTotal: 0, completionTotal: 0, perRunAvg: null },
};

const busySli: SliResponse = {
  ...emptySli,
  runs: {
    total: 11,
    terminal: 10,
    byStatus: { running: 1, completed: 7, failed: 2, cancelled: 0, maxIterations: 1 },
    successRate: 0.7,
    badOutcomeShare: 0.3,
  },
  modelCalls: { count: 24, p50Ms: 9_100, p95Ms: 41_200, maxMs: 71_200 },
  tools: [
    { tool: 'calculator', calls: 8, parseFailures: 2, errors: 1, parseFailureRate: 0.25 },
    { tool: 'get_current_time', calls: 4, parseFailures: 0, errors: 0, parseFailureRate: 0 },
  ],
  iterations: {
    buckets: [
      { le: 1, count: 1 },
      { le: 2, count: 6 },
      { le: 3, count: 2 },
      { le: 5, count: 0 },
      { le: 8, count: 1 },
      { le: 15, count: 0 },
      { le: null, count: 0 },
    ],
    total: 10,
    meanPerRun: 2.3,
  },
  errorCodes: [
    { code: 'MODEL_UNAVAILABLE', count: 2 },
    { code: 'MAX_ITERATIONS', count: 1 },
  ],
  tokens: { promptTotal: 5_300, completionTotal: 440, perRunAvg: 574 },
};

function installStub(sliByHours: Record<number, SliResponse>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/v1/ops/sli') {
      const hours = Number(url.searchParams.get('hours') ?? '24');
      const body = sliByHours[hours];
      if (!body) return json({ error: { code: 'NOT_FOUND', message: String(hours) } }, 404);
      return json({ ...body, window: { ...body.window, hours } });
    }
    if (url.pathname === '/api/v1/health') {
      return json({ status: 'ok', version: 'test', checks: { db: { ok: true } } });
    }
    if (url.pathname === '/api/v1/model/health') {
      return json({
        provider: 'ollama',
        ok: true,
        models: ['gemma4:latest'],
        model: 'gemma4:latest',
      });
    }
    return json({ error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/ops', () => {
  it('shows an empty state and em dashes, not zeros, when nothing has run', async () => {
    installStub({ 24: emptySli });
    renderWithProviders(<OpsPage />, { path: '/ops' });

    expect(await screen.findByTestId('ops-empty')).toBeInTheDocument();

    const successTile = screen.getByTestId('tile-success-rate');
    expect(within(successTile).getByText('—')).toBeInTheDocument();
    expect(within(successTile).queryByText(/0\.0 %/)).not.toBeInTheDocument();

    // The empty window is explained rather than left as a blank panel.
    expect(screen.getByText(/nothing to compute an SLI over/i)).toBeInTheDocument();
  });

  it('renders the SLI tiles, the outcome legend and the tool table from real numbers', async () => {
    installStub({ 24: busySli });
    renderWithProviders(<OpsPage />, { path: '/ops' });

    const successTile = await screen.findByTestId('tile-success-rate');
    expect(within(successTile).getByText('70.0 %')).toBeInTheDocument();
    // The threshold quoted on the tile is the SLO in docs/slo.md.
    expect(within(successTile).getByText(/SLO ≥ 90 %/)).toBeInTheDocument();

    const p95Tile = screen.getByTestId('tile-model-p95');
    expect(within(p95Tile).getByText('41.2 s')).toBeInTheDocument();
    expect(within(p95Tile).getByText(/SLO < 30\.0 s/)).toBeInTheDocument();

    // Every outcome is named with its own count: identity never depends on hue.
    for (const label of ['completed', 'failed', 'cancelled', 'max iterations']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // Parse failures and tool errors are separate columns (ADR 0002).
    expect(screen.getByText('calculator')).toBeInTheDocument();
    expect(screen.getByText('25 %')).toBeInTheDocument();
    expect(screen.getByText(/One tool is over it right now/)).toBeInTheDocument();

    const errors = screen.getByTestId('ops-error-codes');
    expect(within(errors).getByText('MODEL_UNAVAILABLE')).toBeInTheDocument();

    // The iteration histogram has one bar per bucket, including the +Inf overflow.
    const chart = screen.getByTestId('iteration-chart');
    expect(chart.children).toHaveLength(7);
  });

  it('refetches with the selected window', async () => {
    const oneHour: SliResponse = {
      ...emptySli,
      runs: { ...emptySli.runs, total: 1, terminal: 1, successRate: 1, badOutcomeShare: 0 },
    };
    const fetchMock = installStub({ 24: busySli, 1: oneHour });
    renderWithProviders(<OpsPage />, { path: '/ops' });

    await screen.findByText('70.0 %');
    fireEvent.click(screen.getByRole('button', { name: '1 hour' }));

    await waitFor(() => {
      expect(screen.getByTestId('tile-success-rate')).toHaveTextContent('100.0 %');
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('/ops/sli?hours=1'))).toBe(true);
  });

  it('renders the sign-in panel rather than an error when the session has gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'No session cookie' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    renderWithProviders(<OpsPage />, { path: '/ops' });
    expect(await screen.findByTestId('sign-in-panel')).toBeInTheDocument();
  });
});
