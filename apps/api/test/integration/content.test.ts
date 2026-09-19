import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { contentId } from '../../src/db/uuid5.js';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../src/plugins/csrf.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The content read API against a real Postgres and the real seeded curriculum.
 *
 * The headline test here is the last one: `GET /quizzes/:id` must not leak `correct` or
 * `explanation_md`, and it is asserted against the **raw response body**, not against the
 * parsed object. An assertion on `body.questions[0].correct === undefined` would pass
 * even if the answers were hiding under a different key.
 */

const APP_ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct horse battery staple';
const WRITE_HEADERS = { [CSRF_HEADER]: CSRF_HEADER_VALUE, origin: APP_ORIGIN };

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

beforeAll(async () => {
  // Seeded: these tests are about the real curriculum, not about fixtures.
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
    payload: { email: 'content@example.test', password: PASSWORD, displayName: 'Content' },
  });
  expect(registered.statusCode).toBe(201);
  cookie = sessionCookie(registered);
});

afterAll(async () => {
  await app?.close();
  await ctx?.teardown();
});

describe('authentication', () => {
  it('401s every content route without a session', async () => {
    for (const url of [
      '/api/v1/modules',
      '/api/v1/modules/neurons',
      `/api/v1/lessons/${contentId.lesson('neurons', 'what-a-neuron-computes')}`,
      `/api/v1/exercises/${contentId.exercise('neurons', 'perceptron-playground')}`,
      `/api/v1/quizzes/${contentId.quiz('neurons')}`,
    ]) {
      const res = await get(url, false);
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('leaves GET /health public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /modules', () => {
  it('lists the six published modules in reading order with counts and zeroed progress', async () => {
    const res = await get('/api/v1/modules');
    expect(res.statusCode).toBe(200);

    const { modules } = res.json();
    expect(modules.map((m: { slug: string }) => m.slug)).toEqual([
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ]);

    const neurons = modules[0];
    expect(neurons.counts).toEqual({ lessons: 3, exercises: 1, quizQuestions: 8 });
    // The NULL-coalescing rule: `bool_or` over zero rows is NULL in the view.
    expect(neurons.progress).toMatchObject({
      lessonsTotal: 3,
      lessonsDone: 0,
      exerciseDone: false,
      quizPassed: false,
      moduleCompleted: false,
      fraction: 0,
    });
  });
});

describe('GET /modules/:slug', () => {
  it('returns ordered lessons, exercises and a quiz summary', async () => {
    const res = await get('/api/v1/modules/neurons');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.module.title).toBe('Neurons & perceptrons');
    expect(body.lessons.map((l: { slug: string }) => l.slug)).toEqual([
      'what-a-neuron-computes',
      'the-perceptron-rule',
      'reading-the-code',
    ]);
    expect(body.lessons.every((l: { status: string }) => l.status === 'not_started')).toBe(true);

    expect(body.exercises).toHaveLength(1);
    expect(body.exercises[0]).toMatchObject({
      slug: 'perceptron-playground',
      kind: 'perceptron',
      status: 'not_started',
      tasksCompleted: [],
      state: null,
      completionRule: { type: 'tasks', required: 2 },
    });
    expect(body.exercises[0].config.datasets).toContain('xor');

    expect(body.quiz).toMatchObject({
      id: contentId.quiz('neurons'),
      passThreshold: 0.7,
      questionCount: 8,
      bestAttempt: null,
    });
  });

  it('404s an unknown slug', async () => {
    const res = await get('/api/v1/modules/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('GET /lessons/:id', () => {
  it('returns the Markdown body and the module it belongs to', async () => {
    const id = contentId.lesson('neurons', 'what-a-neuron-computes');
    const res = await get(`/api/v1/lessons/${id}`);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toMatchObject({
      id,
      slug: 'what-a-neuron-computes',
      moduleSlug: 'neurons',
      status: 'not_started',
    });
    expect(body.bodyMd).toContain('# What a neuron computes');
    // Frontmatter is stripped by the seed, not by the client.
    expect(body.bodyMd.startsWith('---')).toBe(false);
  });

  it('404s an unknown id and 400s a non-uuid', async () => {
    expect((await get('/api/v1/lessons/11111111-1111-4111-8111-111111111111')).statusCode).toBe(
      404,
    );
    const badly = await get('/api/v1/lessons/not-a-uuid');
    expect(badly.statusCode).toBe(400);
    expect(badly.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /exercises/:id', () => {
  it('returns the kind, the config and this learner’s (empty) progress', async () => {
    const id = contentId.exercise('neurons', 'perceptron-playground');
    const res = await get(`/api/v1/exercises/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      kind: 'perceptron',
      moduleSlug: 'neurons',
      status: 'not_started',
      tasksCompleted: [],
      state: null,
    });
  });
});

describe('GET /quizzes/:id', () => {
  it('returns the questions with their options and points', async () => {
    const res = await get(`/api/v1/quizzes/${contentId.quiz('neurons')}`);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.title).toBe('Neurons & perceptrons quiz');
    expect(body.passThreshold).toBe(0.7);
    expect(body.questions).toHaveLength(8);
    expect(body.questions[0]).toMatchObject({
      id: contentId.quizQuestion('neurons', 1),
      orderIndex: 1,
      kind: 'single_choice',
      points: 1,
    });
    expect(body.questions[0].options).toHaveLength(4);
    expect(body.questions.map((q: { orderIndex: number }) => q.orderIndex)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  /**
   * The rule from docs/02-schema.md, asserted the only way that actually proves it: on
   * the bytes. Every module's quiz is checked, and the raw body is searched both for the
   * word "explanation" and for each question's real answer as it is stored.
   */
  it('never serialises `correct` or `explanationMd`, for any quiz', async () => {
    const slugs = [
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ];

    for (const slug of slugs) {
      const quizId = contentId.quiz(slug);
      const res = await get(`/api/v1/quizzes/${quizId}`);
      expect(res.statusCode, slug).toBe(200);

      const raw = res.body;
      expect(raw.toLowerCase(), slug).not.toContain('explanation');
      expect(raw, slug).not.toContain('"correct"');
      expect(raw, slug).not.toContain('tolerance');
      expect(raw, slug).not.toContain('acceptable');
      expect(raw, slug).not.toContain('optionIds');

      // And the answers themselves, read straight from the database for this quiz.
      const rows = await ctx.sql`
        SELECT correct, explanation_md FROM quiz_questions WHERE quiz_id = ${quizId}
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(raw, `${slug}: explanation leaked`).not.toContain(
          (row.explanation_md as string).slice(0, 40),
        );
        expect(raw, `${slug}: correct leaked`).not.toContain(JSON.stringify(row.correct));
      }
    }
  });
});
