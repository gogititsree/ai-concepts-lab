import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './apiClient';

/**
 * Shared query defaults. Retrying an authentication or validation failure just delays the
 * error the UI already knows how to show, so only genuine server/transport faults retry.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Query keys in one place so an invalidation in a mutation cannot drift from the query
 * that produced the data.
 */
export const queryKeys = {
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  health: ['health'] as const,
  modules: ['modules'] as const,
  module: (slug: string) => ['module', slug] as const,
  lesson: (id: string) => ['lesson', id] as const,
  exercise: (id: string) => ['exercise', id] as const,
  quiz: (id: string) => ['quiz', id] as const,
  quizAttempts: (id: string) => ['quiz', id, 'attempts'] as const,
  progress: ['progress'] as const,
  modelHealth: ['model', 'health'] as const,
  runs: ['runs'] as const,
  run: (id: string) => ['run', id] as const,
} as const;
