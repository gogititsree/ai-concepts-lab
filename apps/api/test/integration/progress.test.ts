import type { QuizAnswer } from '@lab/shared';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { contentId } from '../../src/db/uuid5.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { EXERCISE_STATE_MAX_BYTES } from '../../src/progress/grading.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * Progress writes and quiz attempts, end to end against the seeded curriculum.
 *
 * Two properties are worth naming because they are the reason this file is not a unit
 * test: the view's NULLs (`bool_or` over zero rows) only exist in Postgres, and the
 * "one transaction" promise for an attempt can only be checked by looking at the rows.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

const NEURONS_LESSONS = [
  'what-a-neuron-computes',
  'the-perceptron-rule',
  'reading-the-code',
] as const;
const EXERCISE_ID = contentId.exercise('neurons', 'perceptron-playground');
const QUIZ_ID = contentId.quiz('neurons');

let ctx: TestDb;
let app: FastifyInstance;
let cookie: string;

function sessionCookie(res: InjectResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const sid = list.find((entry) => entry.startsWith('sid='));
  if (!sid) throw new Error(`No sid cookie in response: ${JSON.stringify(raw)}`);
  return sid.split(';')[0] as string;
}

const get = (url: string, auth = true) =>
  app.inject({ method: 'GET', url, headers: auth ? { cookie } : {} });

const put = (url: string, payload: unknown, auth = true) =>
  app.inject({
    method: 'PUT',
    url,
    headers: auth ? { ...WRITE_HEADERS, cookie } : WRITE_HEADERS,
    payload,
  });

const post = (url: string, payload: unknown, auth = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: auth ? { ...WRITE_HEADERS, cookie } : WRITE_HEADERS,
    payload,
  });

/**
 * Builds a correct answer from the stored `correct`, so the test asserts on the grader
 * rather than on a hard-coded answer key that would rot the next time a quiz is edited.
 */
function correctAnswerFor(kind: string, correct: Record<string, unknown>): QuizAnswer {
  if (kind === 'numeric') return { value: correct.value as number };
  if (kind === 'short_text') return { text: (correct.acceptable as string[])[0] as string };
  return { optionIds: correct.optionIds as string[] };
}

interface StoredQuestion {
  id: string;
  kind: string;
  correct: Record<string, unknown>;
  points: number;
  order_index: number;
}

async function storedQuestions(quizId: string): Promise<StoredQuestion[]> {
  const rows = await ctx.sql`
    SELECT id, kind, correct, points, order_index
    FROM quiz_questions WHERE quiz_id = ${quizId} ORDER BY order_index
  `;
  return rows as unknown as StoredQuestion[];
}

beforeAll(async () => {
  ctx = await setupTestDb();
  app = await buildApp({
    config: loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: ctx.url,
      SESSION_SECRET: 'integration-test-session-secret-0123456789',
      APP_ORIGIN,
    }),
    db: ctx.db,
    rateLimits: false,
    checks: { checkDb: async () => ({ ok: true }) },
  });
  await app.ready();

  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: WRITE_HEADERS,
    payload: { email: 'progress@example.test', password: PASSWORD, displayName: 'Progress' },
  });
  expect(registered.statusCode).toBe(201);
  cookie = sessionCookie(registered);
});

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

describe('authentication and CSRF', () => {
  it('401s the progress routes without a session', async () => {
    expect((await get('/api/v1/progress', false)).statusCode).toBe(401);
    expect(
      (
        await put(
          `/api/v1/progress/lessons/${contentId.lesson('neurons', NEURONS_LESSONS[0])}`,
          { status: 'completed' },
          false,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (await post(`/api/v1/quizzes/${QUIZ_ID}/attempts`, { answers: [] }, false)).statusCode,
    ).toBe(401);
  });

  it('403s a write without the X-Requested-With header', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/progress/lessons/${contentId.lesson('neurons', NEURONS_LESSONS[0])}`,
      headers: { cookie, origin: APP_ORIGIN },
      payload: { status: 'completed' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /progress', () => {
  it('returns false, not null, for a module nobody has touched', async () => {
    const res = await get('/api/v1/progress');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.modules).toHaveLength(6);
    for (const entry of body.modules) {
      // The view returns NULL here (bool_or over zero rows); the API must not.
      expect(entry.progress.exerciseDone, entry.moduleSlug).toBe(false);
      expect(entry.progress.quizPassed, entry.moduleSlug).toBe(false);
      expect(entry.progress.moduleCompleted, entry.moduleSlug).toBe(false);
      expect(entry.progress.lessonsDone).toBe(0);
    }
    expect(body.nextModuleSlug).toBe('neurons');
  });

  it('proves the raw view really does return NULL there', async () => {
    // If this ever starts returning `false`, the coalesce in the repository is dead code
    // and should be deleted — but until then it is load-bearing.
    const rows = await ctx.sql`
      SELECT exercise_done, quiz_passed FROM v_user_module_progress
      WHERE module_id = ${contentId.module('harnesses')} LIMIT 1
    `;
    expect(rows[0]?.exercise_done).toBeNull();
    expect(rows[0]?.quiz_passed).toBeNull();
  });
});

describe('PUT /progress/lessons/:id', () => {
  it('marks a lesson complete and the modules list reflects it', async () => {
    const lessonId = contentId.lesson('neurons', NEURONS_LESSONS[0]);

    const res = await put(`/api/v1/progress/lessons/${lessonId}`, { status: 'completed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lessonId, status: 'completed' });
    expect(res.json().completedAt).not.toBeNull();

    const modules = (await get('/api/v1/modules')).json().modules;
    const neurons = modules.find((m: { slug: string }) => m.slug === 'neurons');
    expect(neurons.progress.lessonsDone).toBe(1);
    expect(neurons.progress.lessonsTotal).toBe(3);
    // 1 of (3 lessons + 1 exercise + 1 quiz).
    expect(neurons.progress.fraction).toBeCloseTo(1 / 5);

    const detail = (await get('/api/v1/modules/neurons')).json();
    expect(detail.lessons[0].status).toBe('completed');
  });

  it('is idempotent and reversible, clearing completedAt on the way back', async () => {
    const lessonId = contentId.lesson('neurons', NEURONS_LESSONS[0]);
    await put(`/api/v1/progress/lessons/${lessonId}`, { status: 'completed' });
    const back = await put(`/api/v1/progress/lessons/${lessonId}`, { status: 'in_progress' });
    expect(back.json()).toMatchObject({ status: 'in_progress', completedAt: null });

    // Put it back for the "module completed" assertion at the end of the file.
    await put(`/api/v1/progress/lessons/${lessonId}`, { status: 'completed' });
  });

  it('404s an unknown lesson and 400s an unknown status', async () => {
    expect(
      (
        await put('/api/v1/progress/lessons/11111111-1111-4111-8111-111111111111', {
          status: 'completed',
        })
      ).statusCode,
    ).toBe(404);
    const bad = await put(
      `/api/v1/progress/lessons/${contentId.lesson('neurons', NEURONS_LESSONS[1])}`,
      { status: 'finished' },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('PUT /progress/exercises/:id', () => {
  it('round-trips `state` and returns it from GET /exercises/:id', async () => {
    const state = { reflection: 'the line kept trading off two points', records: { xor: 4 } };
    const saved = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, { state });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().state).toEqual(state);

    const reloaded = await get(`/api/v1/exercises/${EXERCISE_ID}`);
    expect(reloaded.json().state).toEqual(state);

    // A save that carries only tasks must not wipe the state.
    const tasks = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {
      tasksCompleted: ['separate-blobs'],
    });
    expect(tasks.json().state).toEqual(state);
  });

  it('derives status from completion_rule, ignoring what the client claims', async () => {
    // The rule for this exercise is {type:'tasks', required:2}.
    const claimed = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {
      status: 'completed',
    });
    expect(claimed.json().status).toBe('in_progress'); // one task recorded so far
    expect(claimed.json().completedAt).toBeNull();

    const second = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {
      tasksCompleted: ['try-xor'],
    });
    expect(second.json().status).toBe('completed');
    expect(second.json().tasksCompleted).toEqual(['separate-blobs', 'try-xor']);
    expect(second.json().completedAt).not.toBeNull();

    const modules = (await get('/api/v1/modules')).json().modules;
    expect(modules[0].progress.exerciseDone).toBe(true);
  });

  it('never un-completes an exercise or drops a recorded task', async () => {
    const res = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {
      status: 'not_started',
      tasksCompleted: [],
    });
    expect(res.json().status).toBe('completed');
    expect(res.json().tasksCompleted).toEqual(['separate-blobs', 'try-xor']);
  });

  it('rejects a state over 64 KB with PAYLOAD_TOO_LARGE', async () => {
    const tooBig = { s: 'x'.repeat(EXERCISE_STATE_MAX_BYTES) };
    const res = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, { state: tooBig });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');

    // And the stored state is untouched.
    const reloaded = await get(`/api/v1/exercises/${EXERCISE_ID}`);
    expect(reloaded.json().state.reflection).toContain('trading off');
  });

  it('accepts a state just under the limit', async () => {
    const wrapper = '{"s":""}'.length;
    const justUnder = { s: 'x'.repeat(EXERCISE_STATE_MAX_BYTES - wrapper) };
    const res = await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, { state: justUnder });
    expect(res.statusCode).toBe(200);

    // Put the readable state back for the rest of the file.
    await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {
      state: { reflection: 'the line kept trading off two points' },
    });
  });

  it('400s an empty body and 404s an unknown exercise', async () => {
    expect((await put(`/api/v1/progress/exercises/${EXERCISE_ID}`, {})).statusCode).toBe(400);
    expect(
      (
        await put('/api/v1/progress/exercises/11111111-1111-4111-8111-111111111111', {
          status: 'in_progress',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('POST /quizzes/:id/attempts', () => {
  it('grades a perfect attempt, persists it, and returns the explanations', async () => {
    const questions = await storedQuestions(QUIZ_ID);
    const answers = questions.map((question) => ({
      questionId: question.id,
      answer: correctAnswerFor(question.kind, question.correct),
    }));

    const res = await post(`/api/v1/quizzes/${QUIZ_ID}/attempts`, { answers });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    const maxPoints = questions.reduce((sum, q) => sum + q.points, 0);
    expect(body.scorePoints).toBe(maxPoints);
    expect(body.maxPoints).toBe(maxPoints);
    expect(body.fraction).toBe(1);
    expect(body.passed).toBe(true);
    expect(body.passThreshold).toBe(0.7);
    expect(body.questions).toHaveLength(questions.length);
    // Explanations are released here and only here.
    expect(body.questions.every((q: { explanationMd: string }) => q.explanationMd.length > 0)).toBe(
      true,
    );
    expect(body.questions[0].correct).toEqual(questions[0]!.correct);

    const attemptRows = await ctx.sql`
      SELECT * FROM quiz_attempts WHERE id = ${body.attemptId}
    `;
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]?.passed).toBe(true);
    const answerRows = await ctx.sql`
      SELECT * FROM quiz_attempt_answers WHERE attempt_id = ${body.attemptId}
    `;
    expect(answerRows).toHaveLength(questions.length);
    expect(answerRows.every((row) => row.is_correct === true)).toBe(true);
  });

  it('grades a partial attempt per question kind', async () => {
    const questions = await storedQuestions(QUIZ_ID);
    const first = questions[0]!;
    const second = questions[1]!;

    const res = await post(`/api/v1/quizzes/${QUIZ_ID}/attempts`, {
      answers: [
        { questionId: first.id, answer: correctAnswerFor(first.kind, first.correct) },
        // Deliberately wrong: an option id that is not the answer.
        { questionId: second.id, answer: { optionIds: ['zzz'] } },
      ],
    });
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.scorePoints).toBe(first.points);
    expect(body.passed).toBe(false);
    const graded = body.questions as { questionId: string; isCorrect: boolean }[];
    expect(graded.find((q) => q.questionId === first.id)?.isCorrect).toBe(true);
    expect(graded.find((q) => q.questionId === second.id)?.isCorrect).toBe(false);
    // Unanswered questions are still reported, and still wrong.
    expect(graded).toHaveLength(questions.length);

    // Only the two submitted answers are stored.
    const answerRows = await ctx.sql`
      SELECT * FROM quiz_attempt_answers WHERE attempt_id = ${body.attemptId}
    `;
    expect(answerRows).toHaveLength(2);
  });

  it('rejects an answer for a question from another quiz', async () => {
    const other = (await storedQuestions(contentId.quiz('agents')))[0]!;
    const res = await post(`/api/v1/quizzes/${QUIZ_ID}/attempts`, {
      answers: [{ questionId: other.id, answer: { optionIds: ['a'] } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('404s an unknown quiz', async () => {
    const res = await post('/api/v1/quizzes/11111111-1111-4111-8111-111111111111/attempts', {
      answers: [],
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /quizzes/:id/attempts', () => {
  it('lists this learner’s attempts, newest first', async () => {
    const res = await get(`/api/v1/quizzes/${QUIZ_ID}/attempts`);
    expect(res.statusCode).toBe(200);

    const { attempts } = res.json();
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    const times = attempts.map((a: { submittedAt: string }) => Date.parse(a.submittedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(attempts.some((a: { passed: boolean }) => a.passed)).toBe(true);
  });

  it('surfaces the best attempt on the module, not the latest one', async () => {
    // The latest attempt above was the failing partial one; the best is still the perfect.
    const detail = (await get('/api/v1/modules/neurons')).json();
    expect(detail.quiz.bestAttempt.passed).toBe(true);
    expect(detail.quiz.bestAttempt.fraction).toBe(1);

    const quiz = (await get(`/api/v1/quizzes/${QUIZ_ID}`)).json();
    expect(quiz.bestAttempt.passed).toBe(true);
  });
});

describe('the whole module', () => {
  it('reports moduleCompleted once every lesson, the exercise and the quiz are done', async () => {
    for (const slug of NEURONS_LESSONS) {
      const res = await put(`/api/v1/progress/lessons/${contentId.lesson('neurons', slug)}`, {
        status: 'completed',
      });
      expect(res.statusCode).toBe(200);
    }

    const summary = (await get('/api/v1/progress')).json();
    const neurons = summary.modules.find((m: { moduleSlug: string }) => m.moduleSlug === 'neurons');
    expect(neurons.progress).toMatchObject({
      lessonsTotal: 3,
      lessonsDone: 3,
      exerciseDone: true,
      quizPassed: true,
      moduleCompleted: true,
      fraction: 1,
    });
    // "Continue where you left off" moves on.
    expect(summary.nextModuleSlug).toBe('neural-networks');
  });

  it('keeps one learner’s progress out of another’s', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: WRITE_HEADERS,
      payload: { email: 'other@example.test', password: PASSWORD, displayName: 'Other' },
    });
    const otherCookie = sessionCookie(other);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/progress',
      headers: { cookie: otherCookie },
    });
    const neurons = res
      .json()
      .modules.find((m: { moduleSlug: string }) => m.moduleSlug === 'neurons');
    expect(neurons.progress).toMatchObject({
      lessonsDone: 0,
      exerciseDone: false,
      quizPassed: false,
    });
  });
});
