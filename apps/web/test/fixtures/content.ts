import {
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  parseFrontmatter,
  QuizFileSchema,
  type ExerciseDetail,
  type LessonDetail,
  type ModuleDetail,
  type ModuleListResponse,
  type ModuleSummary,
  type ProgressStatus,
  type ProgressSummary,
  type QuizDetail,
} from '@lab/shared';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';

/**
 * API-shaped fixtures built from the **real** curriculum files in `content/`.
 *
 * Until M7 the web app imported `content/modules/**` through `import.meta.glob`, and the
 * page tests therefore ran against the real lessons and the real exercise configs. The
 * app no longer does that — the API is the source of truth and the bundle is content-free
 * — but throwing that coverage away would mean the perceptron config the tests exercise
 * is a hand-written approximation of the one learners get.
 *
 * So the files are read here, in the test process, with the same `@lab/shared` schemas
 * the seed uses, and reshaped into exactly what the API returns. A content change that
 * breaks the UI still fails a test; the *browser* just no longer sees the files.
 *
 * Ids are a deterministic hash of the same key the seed's uuid-v5 uses. They are not the
 * seed's ids (that would need the uuid-v5 implementation from the API package), but they
 * are stable, unique and valid uuids, which is all the fetch mock and the Zod response
 * schemas need.
 */

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment Vite
// rewrites module URLs to a non-file scheme, and vitest always runs from the package
// root (`apps/web`), which makes this the stable way back to the repo root.
const CONTENT_DIR = resolve(process.cwd(), '../../content/modules');

/** A deterministic, well-formed uuid from any key. */
export function fixtureId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface FixtureLesson {
  slug: string;
  title: string;
  orderIndex: number;
  estimatedMinutes: number;
  bodyMd: string;
}

export interface FixtureModule {
  dir: string;
  slug: string;
  title: string;
  summary: string;
  orderIndex: number;
  requiresModel: boolean;
  lessons: FixtureLesson[];
  exercises: ReturnType<typeof ExercisesFileSchema.parse>;
  quiz: ReturnType<typeof QuizFileSchema.parse>;
}

function loadModuleDir(dir: string): FixtureModule {
  const at = (name: string) => readFileSync(join(CONTENT_DIR, dir, name), 'utf8');
  const module = ModuleFileSchema.parse(JSON.parse(at('module.json')));

  const lessons = readdirSync(join(CONTENT_DIR, dir, 'lessons'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const parsed = parseFrontmatter(at(join('lessons', name)));
      const frontmatter = LessonFrontmatterSchema.parse(parsed.frontmatter);
      return { ...frontmatter, bodyMd: parsed.body };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

  return {
    dir,
    ...module,
    lessons,
    exercises: ExercisesFileSchema.parse(JSON.parse(at('exercises.json'))).sort(
      (a, b) => a.orderIndex - b.orderIndex,
    ),
    quiz: QuizFileSchema.parse(JSON.parse(at('quiz.json'))),
  };
}

export const FIXTURE_MODULES: FixtureModule[] = readdirSync(CONTENT_DIR)
  .sort()
  .map(loadModuleDir)
  .filter((module) => module.orderIndex > 0)
  .sort((a, b) => a.orderIndex - b.orderIndex);

export function fixtureModule(slug: string): FixtureModule {
  const found = FIXTURE_MODULES.find((module) => module.slug === slug);
  if (!found) throw new Error(`No fixture module "${slug}"`);
  return found;
}

// ------------------------------------------------------- API-shaped projections ----

export interface ProgressOverrides {
  lessonsDone?: number;
  exerciseDone?: boolean;
  quizPassed?: boolean;
  lessonStatus?: Record<string, ProgressStatus>;
  exerciseStatus?: ProgressStatus;
  tasksCompleted?: string[];
  exerciseState?: Record<string, unknown> | null;
}

export function moduleSummary(slug: string, over: ProgressOverrides = {}): ModuleSummary {
  const module = fixtureModule(slug);
  const lessonsDone = over.lessonsDone ?? 0;
  const exerciseDone = over.exerciseDone ?? false;
  const quizPassed = over.quizPassed ?? false;
  const parts = module.lessons.length + 1 + 1;
  const done = lessonsDone + (exerciseDone ? 1 : 0) + (quizPassed ? 1 : 0);

  return {
    id: fixtureId(`module:${slug}`),
    slug: module.slug,
    title: module.title,
    summary: module.summary,
    orderIndex: module.orderIndex,
    requiresModel: module.requiresModel,
    counts: {
      lessons: module.lessons.length,
      exercises: module.exercises.length,
      quizQuestions: module.quiz.questions.length,
    },
    progress: {
      lessonsTotal: module.lessons.length,
      lessonsDone,
      exerciseDone,
      quizPassed,
      moduleCompleted: lessonsDone === module.lessons.length && exerciseDone && quizPassed,
      fraction: parts === 0 ? 0 : done / parts,
    },
  };
}

export function moduleList(): ModuleListResponse {
  return { modules: FIXTURE_MODULES.map((module) => moduleSummary(module.slug)) };
}

export function moduleDetail(slug: string, over: ProgressOverrides = {}): ModuleDetail {
  const module = fixtureModule(slug);
  return {
    module: moduleSummary(slug, over),
    lessons: module.lessons.map((lesson) => ({
      id: fixtureId(`lesson:${slug}/${lesson.slug}`),
      slug: lesson.slug,
      title: lesson.title,
      orderIndex: lesson.orderIndex,
      estimatedMinutes: lesson.estimatedMinutes,
      status: over.lessonStatus?.[lesson.slug] ?? 'not_started',
    })),
    exercises: module.exercises.map((exercise) => ({
      id: fixtureId(`exercise:${slug}/${exercise.slug}`),
      slug: exercise.slug,
      title: exercise.title,
      kind: exercise.kind,
      orderIndex: exercise.orderIndex,
      config: exercise.config,
      completionRule: exercise.completionRule,
      status: over.exerciseStatus ?? 'not_started',
      tasksCompleted: over.tasksCompleted ?? [],
      state: over.exerciseState ?? null,
    })),
    quiz: {
      id: fixtureId(`quiz:${slug}`),
      title: module.quiz.title,
      passThreshold: module.quiz.passThreshold,
      questionCount: module.quiz.questions.length,
      bestAttempt: null,
    },
  };
}

export function lessonDetail(slug: string, lessonSlug: string): LessonDetail {
  const module = fixtureModule(slug);
  const lesson = module.lessons.find((entry) => entry.slug === lessonSlug);
  if (!lesson) throw new Error(`No fixture lesson ${slug}/${lessonSlug}`);
  return {
    id: fixtureId(`lesson:${slug}/${lessonSlug}`),
    moduleId: fixtureId(`module:${slug}`),
    moduleSlug: slug,
    moduleTitle: module.title,
    slug: lesson.slug,
    title: lesson.title,
    orderIndex: lesson.orderIndex,
    estimatedMinutes: lesson.estimatedMinutes,
    bodyMd: lesson.bodyMd,
    status: 'not_started',
  };
}

export function exerciseDetail(
  slug: string,
  over: { state?: Record<string, unknown> | null; tasksCompleted?: string[] } = {},
): ExerciseDetail {
  const module = fixtureModule(slug);
  const exercise = module.exercises[0];
  if (!exercise) throw new Error(`No fixture exercise for ${slug}`);
  return {
    id: fixtureId(`exercise:${slug}/${exercise.slug}`),
    moduleId: fixtureId(`module:${slug}`),
    moduleSlug: slug,
    moduleTitle: module.title,
    slug: exercise.slug,
    title: exercise.title,
    kind: exercise.kind,
    orderIndex: exercise.orderIndex,
    config: exercise.config,
    completionRule: exercise.completionRule,
    status: 'not_started',
    tasksCompleted: over.tasksCompleted ?? [],
    state: over.state ?? null,
  };
}

/** The public quiz: prompts, options and points — no `correct`, no `explanationMd`. */
export function quizDetail(slug: string): QuizDetail {
  const module = fixtureModule(slug);
  return {
    id: fixtureId(`quiz:${slug}`),
    moduleId: fixtureId(`module:${slug}`),
    moduleSlug: slug,
    moduleTitle: module.title,
    title: module.quiz.title,
    passThreshold: module.quiz.passThreshold,
    questions: module.quiz.questions.map((question, index) => ({
      id: fixtureId(`question:${slug}#${index + 1}`),
      orderIndex: index + 1,
      kind: question.kind,
      promptMd: question.promptMd,
      options: question.options ?? null,
      points: question.points,
    })),
    bestAttempt: null,
  };
}

export function progressSummary(over: Record<string, ProgressOverrides> = {}): ProgressSummary {
  const modules = FIXTURE_MODULES.map((module) => {
    const summary = moduleSummary(module.slug, over[module.slug] ?? {});
    return {
      moduleId: summary.id,
      moduleSlug: summary.slug,
      moduleTitle: summary.title,
      orderIndex: summary.orderIndex,
      progress: summary.progress,
    };
  });
  return {
    modules,
    nextModuleSlug: modules.find((m) => !m.progress.moduleCompleted)?.moduleSlug ?? null,
  };
}

// -------------------------------------------------------------------- fetch mock ----

export interface MockRoute {
  /** Matched against `${method} ${pathname}` with a trailing-`*` wildcard allowed. */
  status?: number;
  body?: unknown;
}

export interface ApiMock {
  fetch: ReturnType<typeof vi.fn>;
  /** Every request made, in order, as `"GET /api/v1/modules"`. */
  calls: string[];
  /** The parsed JSON body of each non-GET request. */
  bodies: unknown[];
}

const errorBody = (code: string, message = code) => ({ error: { code, message } });

export const UNAUTHENTICATED = { status: 401, body: errorBody('UNAUTHENTICATED', 'Sign in') };
export const SERVER_ERROR = {
  status: 500,
  body: errorBody('INTERNAL_ERROR', 'Internal server error'),
};

/**
 * Installs a `fetch` stub that answers by route. Keys are `"<METHOD> <path>"`; a `*` at
 * the end matches any suffix, so `"GET /api/v1/lessons/*"` covers every lesson id.
 * Unmatched requests fail loudly rather than silently returning undefined — a test that
 * forgot a route should say so.
 */
export function installApiMock(routes: Record<string, MockRoute>): ApiMock {
  const mock: ApiMock = { fetch: vi.fn(), calls: [], bodies: [] };

  mock.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    mock.calls.push(key);
    if (init?.body) mock.bodies.push(JSON.parse(String(init.body)));

    const exact = routes[key];
    const wildcard = Object.entries(routes).find(
      ([pattern]) => pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)),
    )?.[1];
    const route = exact ?? wildcard;

    if (!route) {
      return new Response(JSON.stringify(errorBody('NOT_FOUND', `No mock for ${key}`)), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', mock.fetch);
  return mock;
}

export const HEALTH_OK = { body: { status: 'ok', version: 'test1234', checks: {} } };
