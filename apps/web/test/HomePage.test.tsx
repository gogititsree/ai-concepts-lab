import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from '../src/routes/HomePage';
import { HEALTH_OK, installApiMock, progressSummary, SERVER_ERROR } from './fixtures/content';
import { Providers } from './harness';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderHome(routes: Parameters<typeof installApiMock>[0]) {
  installApiMock(routes);
  return render(
    <Providers>
      <HomePage />
    </Providers>,
  );
}

describe('HomePage', () => {
  it('renders the status and version returned by /api/v1/health', async () => {
    renderHome({
      'GET /api/v1/health': HEALTH_OK,
      'GET /api/v1/progress': { body: progressSummary() },
    });

    expect(await screen.findByTestId('health-status')).toHaveTextContent('ok');
    expect(screen.getByTestId('health-version')).toHaveTextContent('test1234');
  });

  it('says the API is unreachable rather than hanging', async () => {
    renderHome({
      'GET /api/v1/health': SERVER_ERROR,
      'GET /api/v1/progress': { body: progressSummary() },
    });

    expect(await screen.findByText(/API unreachable/i)).toBeInTheDocument();
  });

  it('draws one ring per module and reports the lessons done', async () => {
    renderHome({
      'GET /api/v1/health': HEALTH_OK,
      'GET /api/v1/progress': {
        body: progressSummary({ neurons: { lessonsDone: 2 } }),
      },
    });

    const cards = await screen.findAllByTestId('dashboard-module');
    expect(cards).toHaveLength(6);
    expect(cards[0]).toHaveTextContent('2/3 lessons');
    // 2 of (3 lessons + exercise + quiz).
    expect(cards[0]?.querySelector('svg')).toHaveAttribute('aria-label', '40% complete');
  });
});
