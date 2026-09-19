import { ExerciseKindSchema, QuizQuestionSchema } from '@lab/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseExerciseConfig } from '../src/features/content/exerciseConfig';
import {
  useExercise,
  useLesson,
  useModule,
  useModules,
  useProgress,
  useQuiz,
  useSaveExerciseProgress,
  useSetLessonStatus,
  useSubmitQuizAttempt,
} from '../src/features/content/queries';
import { ApiError } from '../src/lib/apiClient';
import {
  exerciseDetail,
  FIXTURE_MODULES,
  fixtureModule,
  installApiMock,
  lessonDetail,
  moduleDetail,
  moduleList,
  progressSummary,
  quizDetail,
  SERVER_ERROR,
  UNAUTHENTICATED,
} from './fixtures/content';
import { Providers } from './harness';

/**
 * The query layer, against a mocked `fetch`.
 *
 * Two kinds of assertion live here, and the second is the one that used to be
 * `staticContent.test.ts`:
 *
 *  1. the hooks hit the documented URLs, parse the response with the shared schemas, and
 *     surface an `ApiError` (not a crash) when the API says no; and
 *  2. the curriculum itself still has the shape the UI assumes — six modules in order,
 *     every module with lessons, an exercise and a quiz, and typed configs for the two
 *     kinds M3 implements. The files are the same files; only the reader moved.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const wrapper = Providers;

describe('the curriculum content the API serves', () => {
  it('is six modules in reading order', () => {
    expect(FIXTURE_MODULES).toHaveLength(6);
    expect(FIXTURE_MODULES.map((module) => module.orderIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(FIXTURE_MODULES.map((module) => module.slug)).toEqual([
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ]);
  });

  it('gives every module a quiz, an exercise and at least one lesson', () => {
    for (const module of FIXTURE_MODULES) {
      expect(module.lessons.length).toBeGreaterThan(0);
      expect(module.exercises.length).toBeGreaterThan(0);
      expect(module.quiz.questions.length).toBeGreaterThan(0);
      expect(ExerciseKindSchema.parse(module.exercises[0]?.kind)).toBeTruthy();
      for (const question of module.quiz.questions) {
        expect(QuizQuestionSchema.safeParse(question).success).toBe(true);
      }
    }
  });

  it('has the written-out curriculum for modules 1 and 2', () => {
    expect(fixtureModule('neurons').lessons).toHaveLength(3);
    expect(fixtureModule('neural-networks').lessons).toHaveLength(4);
    expect(fixtureModule('neurons').quiz.questions.length).toBeGreaterThanOrEqual(6);
    expect(fixtureModule('neural-networks').quiz.questions.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the frontmatter out of the lesson body the API returns', () => {
    const lesson = lessonDetail('neurons', 'what-a-neuron-computes');
    expect(lesson.title).toBe('What a neuron computes');
    expect(lesson.estimatedMinutes).toBeGreaterThan(0);
    expect(lesson.bodyMd).toContain('# What a neuron computes');
    expect(lesson.bodyMd.startsWith('---')).toBe(false);
  });

  it('carries the KaTeX and callout conventions the renderer relies on', () => {
    const written = [
      ...fixtureModule('neurons').lessons,
      ...fixtureModule('neural-networks').lessons,
    ];
    expect(written).toHaveLength(7);
    for (const lesson of written) {
      expect(lesson.bodyMd).toMatch(/\$/);
      expect(lesson.bodyMd).toContain('Where is this in the code?');
    }
    expect(fixtureModule('neurons').lessons.at(-1)?.bodyMd).toContain('What to measure');
    expect(fixtureModule('neural-networks').lessons.at(-1)?.bodyMd).toContain('What to measure');
  });

  it('exposes typed exercise configs for the kinds M3 implements', () => {
    const perceptron = parseExerciseConfig('perceptron', exerciseDetail('neurons').config);
    expect(perceptron.datasets).toContain('xor');
    expect(perceptron.tasks.map((task) => task.id)).toEqual(['separate-blobs', 'try-xor']);

    const mlp = parseExerciseConfig('mlp', exerciseDetail('neural-networks').config);
    expect(mlp.hiddenSizes).toContain(2);
    expect(mlp.tasks.map((task) => task.id)).toEqual([
      'xor-converge',
      'circle-hidden-size',
      'step-through',
    ]);
  });

  it('never carries an answer in the public quiz payload', () => {
    const serialised = JSON.stringify(quizDetail('neurons'));
    expect(serialised.toLowerCase()).not.toContain('explanation');
    expect(serialised).not.toContain('"correct"');
  });
});

describe('read hooks', () => {
  it('useModules fetches /modules and parses it', async () => {
    const api = installApiMock({ 'GET /api/v1/modules': { body: moduleList() } });
    const { result } = renderHook(() => useModules(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.modules).toHaveLength(6);
    expect(api.calls).toEqual(['GET /api/v1/modules']);
  });

  it('useModule fetches by slug', async () => {
    const api = installApiMock({
      'GET /api/v1/modules/neurons': { body: moduleDetail('neurons') },
    });
    const { result } = renderHook(() => useModule('neurons'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.module.slug).toBe('neurons');
    expect(result.current.data?.lessons).toHaveLength(3);
    expect(api.calls).toEqual(['GET /api/v1/modules/neurons']);
  });

  it('does not fetch a detail route until it has an id', async () => {
    const api = installApiMock({
      'GET /api/v1/lessons/*': { body: lessonDetail('neurons', 'what-a-neuron-computes') },
    });
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useLesson(id), {
      wrapper,
      initialProps: { id: undefined as string | undefined },
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(api.calls).toEqual([]);

    rerender({ id: lessonDetail('neurons', 'what-a-neuron-computes').id });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.bodyMd).toContain('# What a neuron computes');
  });

  it('useExercise and useQuiz parse their payloads', async () => {
    const exercise = exerciseDetail('neurons', { state: { reflection: 'hello' } });
    const quiz = quizDetail('neurons');
    installApiMock({
      'GET /api/v1/exercises/*': { body: exercise },
      'GET /api/v1/quizzes/*': { body: quiz },
    });

    const ex = renderHook(() => useExercise(exercise.id), { wrapper });
    await waitFor(() => expect(ex.result.current.isSuccess).toBe(true));
    expect(ex.result.current.data?.state).toEqual({ reflection: 'hello' });

    const qz = renderHook(() => useQuiz(quiz.id), { wrapper });
    await waitFor(() => expect(qz.result.current.isSuccess).toBe(true));
    expect(qz.result.current.data?.questions).toHaveLength(quiz.questions.length);
  });

  it('useProgress surfaces the per-module rollup', async () => {
    installApiMock({
      'GET /api/v1/progress': { body: progressSummary({ neurons: { lessonsDone: 2 } }) },
    });
    const { result } = renderHook(() => useProgress(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.modules[0]?.progress.lessonsDone).toBe(2);
    // The view's NULLs never reach here: the API coalesces them.
    expect(result.current.data?.modules[0]?.progress.exerciseDone).toBe(false);
  });

  it('surfaces UNAUTHENTICATED as an ApiError rather than throwing', async () => {
    installApiMock({ 'GET /api/v1/modules': UNAUTHENTICATED });
    const { result } = renderHook(() => useModules(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).isUnauthenticated).toBe(true);
  });

  it('surfaces a server failure as an ApiError too', async () => {
    installApiMock({ 'GET /api/v1/progress': SERVER_ERROR });
    const { result } = renderHook(() => useProgress(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiError).status).toBe(500);
  });
});

describe('write hooks', () => {
  it('useSetLessonStatus PUTs the status', async () => {
    const lesson = lessonDetail('neurons', 'what-a-neuron-computes');
    const api = installApiMock({
      'PUT /api/v1/progress/lessons/*': {
        body: {
          lessonId: lesson.id,
          status: 'completed',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const { result } = renderHook(() => useSetLessonStatus(), { wrapper });
    result.current.mutate({ lessonId: lesson.id, status: 'completed' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls).toContain(`PUT /api/v1/progress/lessons/${lesson.id}`);
    expect(api.bodies[0]).toEqual({ status: 'completed' });
  });

  it('useSaveExerciseProgress PUTs only the fields it was given', async () => {
    const exercise = exerciseDetail('neurons');
    const api = installApiMock({ 'PUT /api/v1/progress/exercises/*': { body: {} } });

    const { result } = renderHook(() => useSaveExerciseProgress(), { wrapper });
    result.current.mutate({ exerciseId: exercise.id, state: { reflection: 'a sentence' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls).toEqual([`PUT /api/v1/progress/exercises/${exercise.id}`]);
    expect(api.bodies[0]).toEqual({ state: { reflection: 'a sentence' } });
  });

  it('useSubmitQuizAttempt POSTs answers and parses the graded result', async () => {
    const quiz = quizDetail('neurons');
    const question = quiz.questions[0]!;
    const api = installApiMock({
      'POST /api/v1/quizzes/*': {
        status: 201,
        body: {
          attemptId: quiz.id,
          quizId: quiz.id,
          submittedAt: new Date().toISOString(),
          scorePoints: 1,
          maxPoints: 1,
          fraction: 1,
          passThreshold: 0.7,
          passed: true,
          questions: [
            {
              questionId: question.id,
              orderIndex: 1,
              isCorrect: true,
              pointsAwarded: 1,
              points: 1,
              answer: { optionIds: ['b'] },
              correct: { optionIds: ['b'] },
              explanationMd: 'because z = 0',
            },
          ],
        },
      },
    });

    const { result } = renderHook(() => useSubmitQuizAttempt(), { wrapper });
    result.current.mutate({
      quizId: quiz.id,
      answers: [{ questionId: question.id, answer: { optionIds: ['b'] } }],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls).toContain(`POST /api/v1/quizzes/${quiz.id}/attempts`);
    expect(result.current.data?.passed).toBe(true);
    expect(result.current.data?.questions[0]?.explanationMd).toBe('because z = 0');
  });
});
