/**
 * TODO(M7): replace with API. `GET /api/v1/modules` and friends become the source of truth
 * and this whole file is deleted (roadmap M7: "delete the static loaders"). Until then the
 * browser reads `content/modules/**` straight off disk at build time.
 *
 * The contract is deliberately identical to the seed's (`apps/api/src/db/content.ts`): same
 * Zod schemas, same frontmatter parser, same cross-file checks. Two readers of one directory
 * that disagree would be a bug factory, so they share `@lab/shared` rather than each having
 * an opinion.
 */
import {
  ExerciseConfigSchemas,
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  parseFrontmatter,
  QuizFileSchema,
  type ExerciseFileEntry,
  type ExerciseKind,
  type LessonFrontmatter,
  type ModuleFile,
  type QuizFile,
} from '@lab/shared';
import type { z } from 'zod';

export interface StaticLesson extends LessonFrontmatter {
  bodyMd: string;
  /** Repo-relative path, so an error message can name the file a human has to open. */
  path: string;
}

export interface StaticModule extends ModuleFile {
  /** Directory name, e.g. `01-neurons`. */
  dir: string;
  lessons: StaticLesson[];
  exercises: ExerciseFileEntry[];
  quiz: QuizFile;
}

/**
 * Vite inlines every match as a string at build time, so there is no fetch and no loading
 * state anywhere in the app. The path is relative to *this file*
 * (`apps/web/src/content/` -> four levels up is the repo root), and `server.fs.allow` in
 * vite.config.ts lets the dev server read outside its root.
 */
const rawFiles = import.meta.glob('../../../../content/modules/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export class ContentLoadError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'ContentLoadError';
  }
}

function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown, file: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ContentLoadError(
      file,
      result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

function parseJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ContentLoadError(file, `invalid JSON (${(error as Error).message})`);
  }
}

/** `../../../../content/modules/01-neurons/lessons/01-x.md` -> `['01-neurons', 'lessons/01-x.md']`. */
function splitKey(key: string): { dir: string; rest: string } | null {
  const match = /content\/modules\/([^/]+)\/(.+)$/.exec(key);
  if (!match?.[1] || !match[2]) return null;
  return { dir: match[1], rest: match[2] };
}

function loadModule(dir: string, files: Map<string, string>): StaticModule {
  const at = (name: string): string => {
    const raw = files.get(name);
    if (raw === undefined) {
      throw new ContentLoadError(`content/modules/${dir}/${name}`, 'file is missing');
    }
    return raw;
  };
  const path = (name: string): string => `content/modules/${dir}/${name}`;

  const module = parseWith(
    ModuleFileSchema,
    parseJson(at('module.json'), path('module.json')),
    path('module.json'),
  );

  const lessons: StaticLesson[] = [...files.keys()]
    .filter((name) => name.startsWith('lessons/') && name.endsWith('.md'))
    .sort()
    .map((name) => {
      const file = path(name);
      let parsed;
      try {
        parsed = parseFrontmatter(at(name));
      } catch (error) {
        throw new ContentLoadError(file, (error as Error).message);
      }
      const frontmatter = parseWith(LessonFrontmatterSchema, parsed.frontmatter, file);
      if (parsed.body.length === 0) throw new ContentLoadError(file, 'lesson body is empty');
      return { ...frontmatter, bodyMd: parsed.body, path: file };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const exercises = parseWith(
    ExercisesFileSchema,
    parseJson(at('exercises.json'), path('exercises.json')),
    path('exercises.json'),
  ).sort((a, b) => a.orderIndex - b.orderIndex);

  const quiz = parseWith(
    QuizFileSchema,
    parseJson(at('quiz.json'), path('quiz.json')),
    path('quiz.json'),
  );

  // The one cross-file check the per-file schemas cannot see, copied from the seed.
  const lessonSlugs = new Set(lessons.map((lesson) => lesson.slug));
  for (const exercise of exercises) {
    if (exercise.lessonSlug && !lessonSlugs.has(exercise.lessonSlug)) {
      throw new ContentLoadError(
        path('exercises.json'),
        `exercise "${exercise.slug}" references unknown lesson "${exercise.lessonSlug}"`,
      );
    }
  }

  return { ...module, dir, lessons, exercises, quiz };
}

function loadAll(): StaticModule[] {
  const byDir = new Map<string, Map<string, string>>();
  for (const [key, raw] of Object.entries(rawFiles)) {
    const split = splitKey(key);
    if (!split) continue;
    const files = byDir.get(split.dir) ?? new Map<string, string>();
    files.set(split.rest, raw);
    byDir.set(split.dir, files);
  }
  if (byDir.size === 0) {
    throw new Error('No content modules were found; check the glob in src/content/static.ts');
  }

  return [...byDir.entries()]
    .map(([dir, files]) => loadModule(dir, files))
    .filter((module) => module.isPublished)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

/** Validated at import time: bad content fails the page load, not the fifth click into it. */
export const modules: StaticModule[] = loadAll();

export function getModule(slug: string): StaticModule | undefined {
  return modules.find((module) => module.slug === slug);
}

export function getLesson(
  moduleSlug: string,
  lessonSlug: string,
):
  | { module: StaticModule; lesson: StaticLesson; previous?: StaticLesson; next?: StaticLesson }
  | undefined {
  const module = getModule(moduleSlug);
  if (!module) return undefined;
  const index = module.lessons.findIndex((lesson) => lesson.slug === lessonSlug);
  const lesson = module.lessons[index];
  if (!lesson) return undefined;
  return {
    module,
    lesson,
    previous: module.lessons[index - 1],
    next: module.lessons[index + 1],
  };
}

/** The module's primary exercise — every module in this course has exactly one. */
export function getExercise(moduleSlug: string): ExerciseFileEntry | undefined {
  return getModule(moduleSlug)?.exercises[0];
}

/**
 * Re-parses `exercise.config` through the per-kind schema so a feature gets a typed config
 * instead of `Record<string, unknown>`. The seed validated it already; this is the cast made
 * honest.
 */
export function parseExerciseConfig<K extends ExerciseKind>(
  kind: K,
  config: Record<string, unknown>,
): z.infer<(typeof ExerciseConfigSchemas)[K]> {
  return ExerciseConfigSchemas[kind].parse(config) as z.infer<(typeof ExerciseConfigSchemas)[K]>;
}
