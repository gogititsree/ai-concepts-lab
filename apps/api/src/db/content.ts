import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ExercisesFileSchema,
  LessonFrontmatterSchema,
  ModuleFileSchema,
  parseFrontmatter,
  QuizFileSchema,
  type ExercisesFile,
  type LessonFrontmatter,
  type ModuleFile,
  type QuizFile,
} from '@lab/shared';
import type { z } from 'zod';

/**
 * Reads and validates `content/modules/*`. Purely filesystem work: no database, so the
 * seed's "is the content valid" step can be unit-tested and so a content error is reported
 * before a transaction is even opened.
 */

const here = dirname(fileURLToPath(import.meta.url));
/**
 * `apps/api/{src,dist}/db` -> repo root -> `content`. The same four `..` work for both
 * because `dist` mirrors `src`'s depth. `CONTENT_DIR` overrides it, which is how the
 * integration harness and any future non-repo-relative deployment point somewhere else.
 * (The production image does not ship `content/` yet: seeding on deploy is an M13 item.)
 */
export const defaultContentDir =
  process.env.CONTENT_DIR ?? resolve(here, '../../../../content/modules');

export interface LoadedLesson extends LessonFrontmatter {
  bodyMd: string;
  /** Absolute path, used in error messages. */
  path: string;
}

export interface LoadedModule {
  /** Directory name, e.g. `01-neurons`. */
  dir: string;
  path: string;
  module: ModuleFile;
  lessons: LoadedLesson[];
  exercises: ExercisesFile;
  quiz: QuizFile;
}

/** A validation failure that names the file, because "invalid enum value" alone is useless. */
export class ContentError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'ContentError';
  }
}

// Generic over the schema, not its output: `z.ZodType<T>` would bind T to the *input*
// type and lose every `.default()` the content schemas apply.
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, file: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ContentError(file, detail);
  }
  return result.data;
}

async function readJson(file: string): Promise<unknown> {
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ContentError(file, `invalid JSON (${(error as Error).message})`);
  }
}

export async function loadModule(dir: string, contentDir: string): Promise<LoadedModule> {
  const path = join(contentDir, dir);

  const moduleFile = join(path, 'module.json');
  const module = parse(ModuleFileSchema, await readJson(moduleFile), moduleFile);

  const lessonsDir = join(path, 'lessons');
  const lessonFiles = (await readdir(lessonsDir)).filter((f) => f.endsWith('.md')).sort();
  const lessons: LoadedLesson[] = [];
  for (const name of lessonFiles) {
    const file = join(lessonsDir, name);
    const raw = await readFile(file, 'utf8');
    let parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch (error) {
      throw new ContentError(file, (error as Error).message);
    }
    const frontmatter = parse(LessonFrontmatterSchema, parsed.frontmatter, file);
    if (parsed.body.length === 0) throw new ContentError(file, 'lesson body is empty');
    lessons.push({ ...frontmatter, bodyMd: parsed.body, path: file });
  }

  const exercisesFile = join(path, 'exercises.json');
  const exercises = parse(ExercisesFileSchema, await readJson(exercisesFile), exercisesFile);

  const quizFile = join(path, 'quiz.json');
  const quiz = parse(QuizFileSchema, await readJson(quizFile), quizFile);

  // Cross-file checks the per-file schemas cannot see.
  const lessonSlugs = new Set(lessons.map((l) => l.slug));
  for (const exercise of exercises) {
    if (exercise.lessonSlug && !lessonSlugs.has(exercise.lessonSlug)) {
      throw new ContentError(
        exercisesFile,
        `exercise "${exercise.slug}" references unknown lesson "${exercise.lessonSlug}"`,
      );
    }
  }
  assertUnique(
    lessons.map((l) => l.orderIndex),
    moduleFile,
    'lesson orderIndex',
  );
  assertUnique(
    exercises.map((e) => e.orderIndex),
    exercisesFile,
    'exercise orderIndex',
  );

  return { dir, path, module, lessons, exercises, quiz };
}

function assertUnique(values: number[], file: string, label: string): void {
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) throw new ContentError(file, `duplicate ${label} ${value}`);
    seen.add(value);
  }
}

/** Loads every module directory, in directory-name order (`01-…`, `02-…`, …). */
export async function loadAllModules(
  contentDir: string = defaultContentDir,
): Promise<LoadedModule[]> {
  const entries = await readdir(contentDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) throw new Error(`No module directories found in ${contentDir}`);

  const modules: LoadedModule[] = [];
  for (const dir of dirs) modules.push(await loadModule(dir, contentDir));

  assertUnique(
    modules.map((m) => m.module.orderIndex),
    contentDir,
    'module orderIndex',
  );
  const slugs = new Set<string>();
  for (const m of modules) {
    if (slugs.has(m.module.slug)) throw new ContentError(m.path, `duplicate module slug`);
    slugs.add(m.module.slug);
  }
  return modules;
}
