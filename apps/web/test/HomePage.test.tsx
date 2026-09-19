import { render, screen } from '@testing-library/react';

import { Providers } from './harness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from '../src/routes/HomePage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('renders the status and version returned by /api/v1/health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ status: 'ok', version: 'abc1234', checks: {} }, { status: 200 }),
      ),
    );

    render(
      <Providers>
        <HomePage />
      </Providers>,
    );

    expect(await screen.findByTestId('health-status')).toHaveTextContent('ok');
    expect(screen.getByTestId('health-version')).toHaveTextContent('abc1234');
  });
});
