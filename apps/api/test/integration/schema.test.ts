import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sessions, users, vUserModuleProgress } from '../../src/db/schema.js';
import { setupTestDb, type TestDb } from '../setup/db.js';

describe('schema behaviour against a real Postgres', () => {
  let ctx: TestDb;
  let userId: string;

  beforeAll(async () => {
    ctx = await setupTestDb();
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: 'Learner@Example.COM',
        passwordHash: '$argon2id$not-a-real-hash',
        displayName: 'Test Learner',
      })
      .returning();
    userId = user!.id;
  }, 60_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('gives a brand-new user a zeroed row per module in v_user_module_progress', async () => {
    const rows = await ctx.db
      .select()
      .from(vUserModuleProgress)
      .where(eq(vUserModuleProgress.userId, userId));

    // The CROSS JOIN is the point: a user who has never opened anything still gets one
    // row per module, so the modules list is a single query with no client-side merging.
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(Number(row.lessonsTotal)).toBeGreaterThanOrEqual(1);
      expect(Number(row.lessonsDone)).toBe(0);
      // `bool_or` over zero matching rows is NULL, not false. That three-valued logic
      // then propagates: `false AND NULL` is false (the lesson counts already differ), so
      // module_completed is a clean false while the two flags stay NULL. A route
      // serialising this must coalesce, which is exactly why it is asserted here.
      expect(row.exerciseDone).toBeNull();
      expect(row.quizPassed).toBeNull();
      expect(row.moduleCompleted).toBe(false);
    }
  });

  it('matches emails case-insensitively (citext) and rejects duplicates', async () => {
    const found = await ctx.db.select().from(users).where(eq(users.email, 'learner@example.com'));
    expect(found).toHaveLength(1);

    // Drizzle wraps driver errors, so the interesting text is on `cause`.
    const duplicate = await ctx.db
      .insert(users)
      .values({ email: 'LEARNER@example.com', passwordHash: 'x', displayName: 'Impostor' })
      .then(
        () => null,
        (error: unknown) => error as Error & { cause?: Error },
      );
    expect(duplicate).not.toBeNull();
    expect(String(duplicate?.cause ?? duplicate?.message)).toMatch(/unique|duplicate key/i);
  });

  it('cascades a user delete to their sessions', async () => {
    await ctx.db.insert(sessions).values({
      id: Buffer.alloc(32, 7),
      userId,
      expiresAt: new Date(Date.now() + 60_000),
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(await ctx.db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(1);

    await ctx.db.delete(users).where(eq(users.id, userId));

    // ON DELETE CASCADE, so revoking access really does remove the session rows rather
    // than leaving them pointing at a missing user.
    expect(await ctx.db.select().from(sessions)).toHaveLength(0);
  });

  it('created the citext and pgcrypto extensions', async () => {
    const rows = await ctx.sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pgcrypto') ORDER BY extname
    `;
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'pgcrypto']);
  });

  it('created every table from docs/02-schema.md', async () => {
    const rows = await ctx.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      'agent_run_steps',
      'agent_runs',
      'auth_events',
      'exercises',
      'lessons',
      'mfa_backup_codes',
      'mfa_totp',
      'modules',
      'quiz_attempt_answers',
      'quiz_attempts',
      'quiz_questions',
      'quizzes',
      'sessions',
      'user_exercise_progress',
      'user_lesson_progress',
      'users',
    ]);
  });
});
