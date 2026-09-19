import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

/**
 * Every component under test sits inside the same two providers the real app mounts:
 * a router and a query client. Retries and caching are off so a failing request surfaces
 * immediately as an error state instead of being retried past the assertion.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function Providers({
  children,
  path = '/',
  queryClient = createTestQueryClient(),
}: {
  children: ReactNode;
  path?: string;
  queryClient?: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  { path = '/', queryClient }: { path?: string; queryClient?: QueryClient } = {},
): RenderResult {
  return render(
    <Providers path={path} queryClient={queryClient}>
      {ui}
    </Providers>,
  );
}
