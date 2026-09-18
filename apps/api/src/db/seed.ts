import { and, eq, notInArray } from 'drizzle-orm';

import { config as appConfig } from '../config.js';
import { isMainModule } from '../lib/isMainModule.js';
import { createDbClient, type Db } from './client.js';
import { defaultContentDir, loadAllModules, type LoadedModule } from './content.js';
import { exercises, lessons, modules, quizQuestions, quizzes } from './schema.js';
import { contentId } from './uuid5.js';

/**
 * Seeds `content/modules/*` into Postgres.
 *
 * Three properties matter, and they are the reason this file is longer than a pile of
 * INSERTs would be:
 *
 * 1. **Idempotent.** Ids are uuid v5 of the slug path, so every row upserts onto itself.
 *    Running the seed twice changes nothing — not even `content_version`.
 * 2. **Authoritative.** Files are the source of truth: a lesson deleted from disk is
 *    deleted from the database (scoped to its own module, so a half-checked-out tree
 *    cannot wipe unrelated content).
 * 3. **Versioned honestly.** `modules.content_version` is bumped only when the module's
 *    rows would actually differ, which is what makes it usable as a cache key later.
 *
 * Everything happens in one transaction: a content file that fails validation halfway
 * through leaves the database exactly as it was.
 */

export interface SeedOptions {
  contentDir?: string;
  /** Silences the per-module log lines (the integration harness seeds constantly). */
  quiet?: boolean;
}

export interface SeedModuleResult {
  slug: string;
  changed: boolean;
  contentVersion: number;
  lessons: number;
  exercises: number;
  quizQuestions: number;
}

export interface SeedResult {
  modules: SeedModuleResult[];
  /** Modules that were in the database but no longer have a directory on disk. */
  removedModules: string[];
}

/** Stable JSON: jsonb does not preserve key order, so comparison has to be order-free. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonical(value));

/** The rows a module's files describe, ready to compare and to write. */
interface DesiredModule {
  moduleId: string;
  module: typeof modules.$inferInsert;
  lessons: (typeof lessons.$inferInsert)[];
  exercises: (typeof exercises.$inferInsert)[];
  quiz: typeof quizzes.$inferInsert;
  questions: (typeof quizQuestions.$inferInsert)[];
}

function buildDesired(loaded: LoadedModule): DesiredModule {
  const slug = loaded.module.slug;
  const moduleId = contentId.module(slug);
  const quizId = contentId.quiz(slug);

  const lessonIdBySlug = new Map(
    loaded.lessons.map((lesson) => [lesson.slug, contentId.lesson(slug, lesson.slug)]),
  );

  return {
    moduleId,
    module: {
      id: moduleId,
      slug,
      title: loaded.module.title,
      summary: loaded.module.summary,
      orderIndex: loaded.module.orderIndex,
      requiresModel: loaded.module.requiresModel,
      isPublished: loaded.module.isPublished,
      // Replaced below once the previous version is known.
      contentVersion: 1,
    },
    lessons: loaded.lessons.map((lesson) => ({
      id: lessonIdBySlug.get(lesson.slug)!,
      moduleId,
      slug: lesson.slug,
      title: lesson.title,
      orderIndex: lesson.orderIndex,
      bodyMd: lesson.bodyMd,
      estimatedMinutes: lesson.estimatedMinutes,
    })),
    exercises: loaded.exercises.map((exercise) => ({
      id: contentId.exercise(slug, exercise.slug),
      moduleId,
      lessonId: exercise.lessonSlug ? (lessonIdBySlug.get(exercise.lessonSlug) ?? null) : null,
      slug: exercise.slug,
      title: exercise.title,
      kind: exercise.kind,
      config: exercise.config,
      orderIndex: exercise.orderIndex,
      completionRule: exercise.completionRule,
    })),
    quiz: {
      id: quizId,
      moduleId,
      title: loaded.quiz.title,
      // numeric(3,2) is a string in and out of the driver; store it in the one canonical
      // spelling so a re-seed never looks like a change.
      passThreshold: loaded.quiz.passThreshold.toFixed(2),
    },
    questions: loaded.quiz.questions.map((question, index) => ({
      id: contentId.quizQuestion(slug, index + 1),
      quizId,
      orderIndex: index + 1,
      kind: question.kind,
      promptMd: question.promptMd,
      options: question.options ?? null,
      correct: question.correct,
      explanationMd: question.explanationMd,
      points: question.points,
    })),
  };
}

/** The comparison key for "did this module's content change?" — excludes content_version. */
function fingerprint(desired: DesiredModule): string {
  const { contentVersion: _ignored, ...module } = desired.module;
  return canonicalJson({
    module,
    lessons: desired.lessons,
    exercises: desired.exercises,
    quiz: desired.quiz,
    questions: desired.questions,
  });
}

async function readCurrent(tx: Db, moduleId: string): Promise<DesiredModule | null> {
  const [module] = await tx.select().from(modules).where(eq(modules.id, moduleId));
  if (!module) return null;

  const currentLessons = await tx.select().from(lessons).where(eq(lessons.moduleId, moduleId));
  const currentExercises = await tx
    .select()
    .from(exercises)
    .where(eq(exercises.moduleId, moduleId));
  const [quiz] = await tx.select().from(quizzes).where(eq(quizzes.moduleId, moduleId));
  const questions = quiz
    ? await tx.select().from(quizQuestions).where(eq(quizQuestions.quizId, quiz.id))
    : [];

  return {
    moduleId,
    module,
    // Sorted so a different physical row order is not mistaken for a content change.
    lessons: [...currentLessons].sort((a, b) => a.orderIndex - b.orderIndex),
    exercises: [...currentExercises].sort((a, b) => a.orderIndex - b.orderIndex),
    quiz: quiz ?? { id: '', moduleId, title: '', passThreshold: '' },
    questions: [...questions].sort((a, b) => a.orderIndex - b.orderIndex),
  };
}

async function seedModule(tx: Db, loaded: LoadedModule): Promise<SeedModuleResult> {
  const desired = buildDesired(loaded);
  const current = await readCurrent(tx, desired.moduleId);

  const changed = current === null || fingerprint(current) !== fingerprint(desired);
  desired.module.contentVersion = current
    ? changed
      ? current.module.contentVersion + 1
      : current.module.contentVersion
    : 1;

  // --- modules -------------------------------------------------------------------
  await tx
    .insert(modules)
    .values(desired.module)
    .onConflictDoUpdate({ target: modules.id, set: withoutId(desired.module) });

  // --- lessons -------------------------------------------------------------------
  // Deleted first: a lesson that changed order index would otherwise collide with a
  // stale row on the (module_id, order_index) unique index.
  await deleteMissing(tx, lessons, lessons.moduleId, desired.moduleId, lessons.id, [
    ...desired.lessons.map((l) => l.id as string),
  ]);
  for (const lesson of desired.lessons) {
    await tx
      .insert(lessons)
      .values(lesson)
      .onConflictDoUpdate({ target: lessons.id, set: withoutId(lesson) });
  }

  // --- exercises -----------------------------------------------------------------
  await deleteMissing(tx, exercises, exercises.moduleId, desired.moduleId, exercises.id, [
    ...desired.exercises.map((e) => e.id as string),
  ]);
  for (const exercise of desired.exercises) {
    await tx
      .insert(exercises)
      .values(exercise)
      .onConflictDoUpdate({ target: exercises.id, set: withoutId(exercise) });
  }

  // --- quiz and questions --------------------------------------------------------
  await tx
    .insert(quizzes)
    .values(desired.quiz)
    .onConflictDoUpdate({ target: quizzes.id, set: withoutId(desired.quiz) });

  const keepQuestionIds = desired.questions.map((q) => q.id as string);
  await tx
    .delete(quizQuestions)
    .where(
      keepQuestionIds.length > 0
        ? and(
            eq(quizQuestions.quizId, desired.quiz.id as string),
            notInArray(quizQuestions.id, keepQuestionIds),
          )
        : eq(quizQuestions.quizId, desired.quiz.id as string),
    );
  for (const question of desired.questions) {
    await tx
      .insert(quizQuestions)
      .values(question)
      .onConflictDoUpdate({ target: quizQuestions.id, set: withoutId(question) });
  }

  return {
    slug: loaded.module.slug,
    changed,
    contentVersion: desired.module.contentVersion,
    lessons: desired.lessons.length,
    exercises: desired.exercises.length,
    quizQuestions: desired.questions.length,
  };
}

/** `ON CONFLICT (id) DO UPDATE SET <every column except id>`. */
function withoutId<T extends { id?: unknown }>(row: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = row;
  return rest;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- one small generic helper over three
   different tables; typing it precisely costs more than it is worth here. */
async function deleteMissing(
  tx: Db,
  table: any,
  scopeColumn: any,
  scopeValue: string,
  idColumn: any,
  keepIds: string[],
): Promise<void> {
  await tx
    .delete(table)
    .where(
      keepIds.length > 0
        ? and(eq(scopeColumn, scopeValue), notInArray(idColumn, keepIds))
        : eq(scopeColumn, scopeValue),
    );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function seed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  // Validation happens before the transaction opens: a typo in a quiz should not hold a
  // write transaction open while the filesystem is read.
  const loadedModules = await loadAllModules(options.contentDir ?? defaultContentDir);

  return db.transaction(async (tx) => {
    const results: SeedModuleResult[] = [];
    for (const loaded of loadedModules) {
      const result = await seedModule(tx as unknown as Db, loaded);
      results.push(result);
      if (!options.quiet) {
        console.log(
          `  ${result.slug}: v${result.contentVersion}${result.changed ? ' (updated)' : ''} ` +
            `— ${result.lessons} lessons, ${result.exercises} exercises, ${result.quizQuestions} questions`,
        );
      }
    }

    // A module whose directory is gone is removed entirely; the FK cascades take its
    // lessons, exercises, quiz and any learner progress with it.
    const keepIds = results.map((r) => contentId.module(r.slug));
    const removed = await (tx as unknown as Db)
      .delete(modules)
      .where(notInArray(modules.id, keepIds))
      .returning({ slug: modules.slug });

    return { modules: results, removedModules: removed.map((r) => r.slug) };
  });
}

async function main(): Promise<void> {
  const client = createDbClient(appConfig.DATABASE_URL, { max: 1 });
  try {
    console.log(`Seeding from ${defaultContentDir}`);
    const result = await seed(client.db);
    const changed = result.modules.filter((m) => m.changed).length;
    console.log(
      `Seeded ${result.modules.length} modules (${changed} changed` +
        `${result.removedModules.length > 0 ? `, removed ${result.removedModules.join(', ')}` : ''}).`,
    );
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
