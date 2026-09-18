import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exercises, lessons, modules, quizQuestions, quizzes } from '../../src/db/schema.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

/**
 * The acceptance criterion for M4: "`pnpm db:migrate && pnpm db:seed` twice -> same row
 * counts". Re-running the seed must be a no-op, including `content_version`, or the
 * version stops meaning "the content changed" and becomes "someone deployed".
 */
describe('migrate + seed are idempotent', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await setupTestDb();
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  async function snapshot() {
    const [moduleRows, lessonRows, exerciseRows, quizRows, questionRows] = await Promise.all([
      ctx.db.select().from(modules),
      ctx.db.select().from(lessons),
      ctx.db.select().from(exercises),
      ctx.db.select().from(quizzes),
      ctx.db.select().from(quizQuestions),
    ]);
    return {
      counts: {
        modules: moduleRows.length,
        lessons: lessonRows.length,
        exercises: exerciseRows.length,
        quizzes: quizRows.length,
        quizQuestions: questionRows.length,
      },
      versions: Object.fromEntries(
        [...moduleRows]
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((m) => [m.slug, m.contentVersion]),
      ),
      moduleIds: [...moduleRows].map((m) => m.id).sort(),
    };
  }

  it('seeds the six curriculum modules', async () => {
    const after = await snapshot();
    expect(after.counts.modules).toBe(6);
    expect(Object.keys(after.versions)).toEqual([
      'neurons',
      'neural-networks',
      'how-llms-work',
      'prompting',
      'agents',
      'harnesses',
    ]);
    // Every module ships at least one lesson, one exercise, one quiz with questions.
    expect(after.counts.lessons).toBeGreaterThanOrEqual(6);
    expect(after.counts.exercises).toBeGreaterThanOrEqual(6);
    expect(after.counts.quizzes).toBe(6);
    expect(after.counts.quizQuestions).toBeGreaterThanOrEqual(6);
  });

  it('leaves row counts, ids and content_version untouched on a second run', async () => {
    const before = await snapshot();
    await ctx.reseed();
    const after = await snapshot();

    expect(after.counts).toEqual(before.counts);
    expect(after.moduleIds).toEqual(before.moduleIds);
    // Every module was seeded at version 1 and must stay there: the files did not change.
    expect(after.versions).toEqual(before.versions);
    expect(Object.values(after.versions)).toEqual(Array(6).fill(1));
  });

  it('bumps content_version for a module whose rows actually changed', async () => {
    // Simulate an edit by corrupting one row, then re-seeding: the seed must notice the
    // difference, restore the file's value and move the module to version 2.
    await ctx.db
      .update(modules)
      .set({ title: 'Tampered title' })
      .where(eq(modules.slug, 'neurons'));

    await ctx.reseed();

    const [neurons] = await ctx.db.select().from(modules).where(eq(modules.slug, 'neurons'));
    expect(neurons?.title).toBe('Neurons & perceptrons');
    expect(neurons?.contentVersion).toBe(2);

    // …and only that module moved.
    const others = await ctx.db.select().from(modules);
    for (const m of others) {
      if (m.slug !== 'neurons') expect(m.contentVersion).toBe(1);
    }
  });

  it('deletes rows whose content no longer exists on disk', async () => {
    const [neurons] = await ctx.db.select().from(modules).where(eq(modules.slug, 'neurons'));
    // An orphan lesson, as if it had been removed from the repo since the last seed.
    await ctx.db.insert(lessons).values({
      id: '00000000-0000-5000-8000-0000000000ff',
      moduleId: neurons!.id,
      slug: 'deleted-lesson',
      title: 'Removed from the repo',
      orderIndex: 99,
      bodyMd: 'gone',
      estimatedMinutes: 5,
    });

    await ctx.reseed();

    const remaining = await ctx.db.select().from(lessons).where(eq(lessons.moduleId, neurons!.id));
    expect(remaining.map((l) => l.slug)).not.toContain('deleted-lesson');
  });
});
