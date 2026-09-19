import {
  ExerciseDetailSchema,
  LessonDetailSchema,
  ModuleDetailSchema,
  ModuleListResponseSchema,
  ProgressSummarySchema,
  QuizAttemptHistorySchema,
  QuizAttemptResultSchema,
  QuizDetailSchema,
  type ExerciseDetail,
  type ExerciseProgressUpdate,
  type ExerciseState,
  type LessonDetail,
  type ModuleDetail,
  type ModuleListResponse,
  type ProgressStatus,
  type ProgressSummary,
  type QuizAttemptHistory,
  type QuizAttemptRequest,
  type QuizAttemptResult,
  type QuizDetail,
} from '@lab/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiGet, apiPost, apiPut, type ApiError } from '../../lib/apiClient';
import { queryKeys } from '../../lib/queryClient';

/**
 * Every read and write of curriculum content and learner progress.
 *
 * This file replaces two M3 stopgaps at once: `src/content/static.ts` (the curriculum
 * inlined into the bundle by `import.meta.glob`) and `src/lib/localProgress.ts`
 * (progress in localStorage). Both are deleted; the API is now the only source of truth,
 * which is what makes progress survive a different browser and what keeps quiz answers
 * out of the bundle.
 *
 * Conventions:
 *  - Detail hooks take an **id**, because that is what the API is keyed by, and the ids
 *    come from `useModule(slug)`. The router is keyed by slug, so a page typically runs
 *    `useModule(slug)` first and then the detail query with `enabled` gated on the id.
 *  - Every mutation invalidates `['progress']` and `['modules']`, because both summarise
 *    something a write can change, plus the detail key it touched.
 *  - Nothing here catches errors. `ApiError.isUnauthenticated` is a state the *pages*
 *    render ("sign in to track your progress"), not something to swallow here.
 */

type Query<T> = UseQueryResult<T, ApiError | Error>;

export function useModules(): Query<ModuleListResponse> {
  return useQuery({
    queryKey: queryKeys.modules,
    queryFn: ({ signal }) => apiGet('/modules', ModuleListResponseSchema, { signal }),
  });
}

export function useModule(slug: string | undefined): Query<ModuleDetail> {
  return useQuery({
    queryKey: queryKeys.module(slug ?? ''),
    queryFn: ({ signal }) =>
      apiGet(`/modules/${encodeURIComponent(slug ?? '')}`, ModuleDetailSchema, { signal }),
    enabled: Boolean(slug),
  });
}

export function useLesson(id: string | undefined): Query<LessonDetail> {
  return useQuery({
    queryKey: queryKeys.lesson(id ?? ''),
    queryFn: ({ signal }) => apiGet(`/lessons/${id ?? ''}`, LessonDetailSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useExercise(id: string | undefined): Query<ExerciseDetail> {
  return useQuery({
    queryKey: queryKeys.exercise(id ?? ''),
    queryFn: ({ signal }) => apiGet(`/exercises/${id ?? ''}`, ExerciseDetailSchema, { signal }),
    enabled: Boolean(id),
    // The exercise carries the learner's saved `state`, and the playground seeds itself
    // from it on mount. Refetching it underneath a running playground would be a
    // surprise, so it stays fresh for the length of a visit.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useQuiz(id: string | undefined): Query<QuizDetail> {
  return useQuery({
    queryKey: queryKeys.quiz(id ?? ''),
    queryFn: ({ signal }) => apiGet(`/quizzes/${id ?? ''}`, QuizDetailSchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useQuizAttempts(id: string | undefined): Query<QuizAttemptHistory> {
  return useQuery({
    queryKey: queryKeys.quizAttempts(id ?? ''),
    queryFn: ({ signal }) =>
      apiGet(`/quizzes/${id ?? ''}/attempts`, QuizAttemptHistorySchema, { signal }),
    enabled: Boolean(id),
  });
}

export function useProgress(): Query<ProgressSummary> {
  return useQuery({
    queryKey: queryKeys.progress,
    queryFn: ({ signal }) => apiGet('/progress', ProgressSummarySchema, { signal }),
  });
}

// ------------------------------------------------------------------- mutations ----

/** What every write invalidates: the two summaries plus every module detail. */
function useProgressInvalidation(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.progress }),
      queryClient.invalidateQueries({ queryKey: queryKeys.modules }),
      // Prefix match: `['module', slug]` for every slug. A write knows an id, not a
      // slug, and invalidating one extra cached module costs a request nobody waits on.
      queryClient.invalidateQueries({ queryKey: ['module'] }),
    ]);
  };
}

export interface SetLessonStatusInput {
  lessonId: string;
  status: ProgressStatus;
}

export function useSetLessonStatus(): UseMutationResult<
  unknown,
  ApiError | Error,
  SetLessonStatusInput
> {
  const queryClient = useQueryClient();
  const invalidate = useProgressInvalidation();

  return useMutation({
    mutationFn: ({ lessonId, status }: SetLessonStatusInput) =>
      apiPut(`/progress/lessons/${lessonId}`, { body: { status } }),
    onSuccess: async (_data, { lessonId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.lesson(lessonId) });
      await invalidate();
    },
  });
}

export interface SaveExerciseProgressInput {
  exerciseId: string;
  status?: ProgressStatus;
  state?: ExerciseState;
  tasksCompleted?: string[];
}

/**
 * Saves a slice of exercise progress. Debouncing is the **caller's** job: the perceptron
 * playground saves `state` on a 2-second debounce but reports `tasksCompleted` the
 * instant a task passes, and a hook that decided that for everyone would be wrong for
 * one of the two.
 *
 * Note that the server may return a different `status` than was asked for — the
 * completion rule decides — so the response is written straight back into the exercise
 * cache rather than assumed.
 */
export function useSaveExerciseProgress(): UseMutationResult<
  unknown,
  ApiError | Error,
  SaveExerciseProgressInput
> {
  const queryClient = useQueryClient();
  const invalidate = useProgressInvalidation();

  return useMutation({
    mutationFn: ({ exerciseId, ...body }: SaveExerciseProgressInput) => {
      const payload: ExerciseProgressUpdate = body;
      return apiPut(`/progress/exercises/${exerciseId}`, { body: payload });
    },
    onSuccess: async (_data, { exerciseId, tasksCompleted }) => {
      // A `state` save happens every two seconds while someone types; re-fetching six
      // queries each time would be silly. Only a task change can move a progress ring.
      if (tasksCompleted && tasksCompleted.length > 0) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.exercise(exerciseId) });
        await invalidate();
      }
    },
  });
}

export interface SubmitQuizAttemptInput extends QuizAttemptRequest {
  quizId: string;
}

export function useSubmitQuizAttempt(): UseMutationResult<
  QuizAttemptResult,
  ApiError | Error,
  SubmitQuizAttemptInput
> {
  const queryClient = useQueryClient();
  const invalidate = useProgressInvalidation();

  return useMutation({
    mutationFn: ({ quizId, answers }: SubmitQuizAttemptInput) =>
      apiPost<QuizAttemptResult>(`/quizzes/${quizId}/attempts`, {
        body: { answers },
        schema: QuizAttemptResultSchema,
      }),
    onSuccess: async (_result, { quizId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.quizAttempts(quizId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.quiz(quizId) });
      await invalidate();
    },
  });
}
