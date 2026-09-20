import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type Locator, type Page } from '@playwright/test';

// The *server's* TOTP helper, not a second implementation. `apps/api/src/auth/totp.ts`
// resolves `otplib` out of apps/api's own dependencies, so importing it here cannot drift
// from the version the API verifies against — which is the whole point of computing a
// real code instead of stubbing the check.
import { currentStep, generateTotp, stepToDate } from '../apps/api/src/auth/totp';

/**
 * The one end-to-end test (docs/05-quality-and-ops.md, "The one end-to-end test").
 *
 * Six steps, in one `test()` because they are one story: every step depends on the state
 * the previous one left in the database and in the browser's cookie jar. Splitting them
 * into six `test()`s would mean either six logins or shared mutable state between tests,
 * and Playwright would report a cascade of failures for a single root cause.
 *
 * What it is allowed to assume: a migrated, seeded, otherwise empty `lab_e2e` (see
 * `scripts/e2e-db.mjs`) and `MODEL_PROVIDER=fake`. What it must not assume: any particular
 * content wording. The quiz answers are read out of `content/modules/01-neurons/quiz.json`
 * at run time, so editing the curriculum changes the test's inputs rather than breaking it.
 */

// ------------------------------------------------------------------- fixtures ----

const PASSWORD = 'correct-horse-battery-staple-e2e';

/** A fresh account per run: the suite never depends on the database being empty. */
function uniqueEmail(): string {
  return `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

interface QuizFile {
  questions: {
    kind: 'single_choice' | 'multi_choice' | 'numeric' | 'short_text';
    correct: { optionIds?: string[]; value?: number; text?: string };
    points?: number;
  }[];
}

/**
 * The answer key, read from the content file the seed loads.
 *
 * Deliberately *not* hard-coded: the API never serialises `correct` (that rule has its own
 * integration test), so the only honest source for a "known-correct" run is the same file
 * the database was seeded from. Reading it here means a reworded quiz changes the inputs
 * rather than turning this test red for no reason.
 */
function loadQuizAnswers(): QuizFile {
  const path = fileURLToPath(new URL('../content/modules/01-neurons/quiz.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as QuizFile;
}

/** The `<li>` for question N, located by the "Q1"/"Q2"… marker the page renders. */
function questionCard(page: Page, oneBasedIndex: number): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByText(`Q${oneBasedIndex}`, { exact: true }) });
}

// ----------------------------------------------------------------- the journey ----

test('a learner registers, turns on MFA, works through Module 1 and runs an agent', async ({
  page,
}) => {
  const email = uniqueEmail();
  const answerKey = loadQuizAnswers();

  // -- 1. Register, land on the dashboard ------------------------------------------

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill('E2E Learner');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Build the intuition');
  // The six progress cards only render for a session that `GET /progress` accepted, so
  // this asserts the cookie round-tripped rather than just that a page painted.
  await expect(page.getByTestId('dashboard-module')).toHaveCount(6);
  await expect(page.getByTestId('health-status')).toHaveText('ok');

  // -- 2. Enroll a second factor ----------------------------------------------------

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  await expect(page.getByTestId('mfa-panel')).toContainText('Off');

  // Scoped to the MFA panel: the change-password panel below it has its own
  // "Current password" field, so an unscoped label would be ambiguous.
  const mfa = page.getByTestId('mfa-panel');
  await mfa.getByRole('button', { name: 'Set up two-factor' }).click();
  await mfa.getByLabel('Current password').fill(PASSWORD);
  await mfa.getByRole('button', { name: 'Continue' }).click();

  // The page groups the secret in fours for legibility; the server wants it unspaced.
  await expect(page.getByTestId('manual-secret')).toBeVisible();
  const secret = ((await page.getByTestId('manual-secret').textContent()) ?? '').replace(
    /\s+/g,
    '',
  );
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  // The step this code belongs to is remembered: `/auth/mfa/confirm` stores it in
  // `mfa_totp.last_used_step`, and replay protection then refuses anything at or below it.
  const confirmStep = currentStep();
  await mfa.getByLabel('Code from your app').fill(generateTotp(secret, stepToDate(confirmStep)));
  await mfa.getByRole('button', { name: 'Turn on two-factor' }).click();

  await expect(page.getByTestId('backup-codes')).toBeVisible();
  const backupCodes = await page.getByTestId('backup-codes').locator('li').allInnerTexts();
  expect(backupCodes).toHaveLength(10);
  for (const code of backupCodes) expect(code).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);

  await mfa.getByRole('checkbox', { name: /I have saved these codes/ }).check();
  await mfa.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('mfa-panel')).toContainText('On');

  // -- 3. Log out, log in, clear the second factor ----------------------------------

  // The only full-session sign-out in the UI: revoke the current session from the list.
  await page.getByTestId('sessions-panel').getByRole('button', { name: 'Sign out here' }).click();
  await page.getByTestId('sessions-panel').getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/login\/mfa$/);
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();

  // A *fresh* code, and freshness here is arithmetic rather than a sleep: the code for
  // `confirmStep + 1` is above the stored `last_used_step` and is inside the server's ±1
  // window for the whole of steps confirmStep..confirmStep+2, i.e. for the next 60-90 s.
  // Waiting on the wall clock for a new step would add up to 30 idle seconds per run.
  await page.getByLabel('Code').fill(generateTotp(secret, stepToDate(confirmStep + 1)));
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('dashboard-module')).toHaveCount(6);

  // -- 4. Module 1: read lesson 1, then reach 100 % on the blobs dataset ------------

  await page.getByTestId('dashboard-module').filter({ hasText: 'Neurons & perceptrons' }).click();
  await expect(page).toHaveURL('/modules/neurons');

  await page.getByRole('link', { name: 'What a neuron computes' }).click();
  await expect(page).toHaveURL('/modules/neurons/lessons/what-a-neuron-computes');
  await expect(page.getByRole('heading', { name: 'What a neuron computes' })).toBeVisible();

  const markComplete = page.getByRole('button', { name: 'Mark complete' });
  await markComplete.click();
  // The label flips only after `PUT /progress/lessons/:id` came back, so this is an
  // assertion about the database, not about optimistic UI.
  await expect(page.getByRole('button', { name: /^Completed/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('link', { name: 'Open the exercise' }).click();
  await expect(page).toHaveURL('/modules/neurons/exercise');
  await expect(page.getByTestId('task-list')).toBeVisible();

  await page.getByRole('button', { name: 'blobs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'blobs', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Auto-run' }).click();
  // Two linearly separable clouds at lr 0.1 converge in a handful of epochs, and the loop
  // runs one epoch per 90 ms — but this is the only genuinely time-dependent wait in the
  // suite, so it gets a generous ceiling rather than a tight one.
  await expect(page.getByTestId('accuracy')).toContainText('100.0 %', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Stop' }).click();

  // The tick is filled once the task id has been persisted to `tasks_completed`.
  await expect(page.getByTestId('task-separate-blobs')).toContainText('✓');

  // -- 5. Pass the Module 1 quiz ----------------------------------------------------

  await page.getByRole('link', { name: 'Neurons & perceptrons' }).click();
  await expect(page).toHaveURL('/modules/neurons');
  await page.getByRole('link', { name: 'Take the quiz' }).click();
  await expect(page).toHaveURL('/modules/neurons/quiz');

  const questions = answerKey.questions;
  await expect(questionCard(page, questions.length)).toBeVisible();

  for (const [index, question] of questions.entries()) {
    const card = questionCard(page, index + 1);
    if (question.correct.optionIds) {
      for (const optionId of question.correct.optionIds) {
        await card.locator(`input[value="${optionId}"]`).check();
      }
    } else if (question.correct.value !== undefined) {
      await card.locator('input[type="number"]').fill(String(question.correct.value));
    } else if (question.correct.text !== undefined) {
      await card.locator('input[type="text"]').fill(question.correct.text);
    } else {
      throw new Error(`Question ${index + 1} has no answer this test knows how to enter`);
    }
  }

  const maxPoints = questions.reduce((total, question) => total + (question.points ?? 1), 0);
  await page.getByRole('button', { name: 'Submit answers' }).click();

  const result = page.getByTestId('quiz-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText(`${maxPoints}/${maxPoints}`);
  // "Passed", capital P — "Not passed" would not match, and the score above pins it anyway.
  await expect(result).toContainText('Passed');

  await page.goto('/');
  const module1Card = page.getByTestId('dashboard-module').filter({ hasText: 'Neurons' });
  await expect(module1Card).toContainText('quiz passed');
  await expect(module1Card).toContainText('1/3 lessons');

  // -- 6. Module 5: run the agent loop against the fake provider --------------------

  await page.goto('/modules/agents/exercise');
  await expect(page.getByTestId('agent-trace')).toBeVisible();
  // `MODEL_PROVIDER=fake` is healthy, so the "run this locally" banner must be absent.
  await expect(page.getByTestId('model-unavailable-banner')).toHaveCount(0);
  await expect(page.getByLabel('calculator')).toBeChecked();

  // `FakeProvider.selectScenario` reads a `scenario:` marker out of the system prompt —
  // the documented way for this test to choose a deterministic trace shape without a
  // test-only API on the server. `tool-call-once` is one calculator call, then an answer.
  await page
    .getByLabel('System prompt')
    .fill('scenario: tool-call-once\nUse the calculator for every calculation.');
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  const trace = page.getByTestId('agent-trace');
  await expect(trace.locator('li[data-kind="final"]')).toBeVisible({ timeout: 60_000 });

  const kinds = await trace
    .locator('li[data-kind]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-kind')));
  // The shape docs/05 asks for: the model speaks, a tool is called, its result comes back,
  // and (after one more model call) the run ends with a final answer.
  expect(kinds.slice(0, 3)).toEqual(['model_call', 'tool_call', 'tool_result']);
  expect(kinds.at(-1)).toBe('final');
  await expect(trace.locator('li[data-kind="tool_call"]')).toContainText('calculator');

  await expect(page.getByTestId('final-answer')).toContainText('83,810,205');
  await expect(page.getByTestId('final-answer')).toContainText('completed');
});
