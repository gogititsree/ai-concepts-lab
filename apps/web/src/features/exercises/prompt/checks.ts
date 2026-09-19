import type { PromptCheck, PromptTask, StructuredOutputResult } from '@lab/shared';

/**
 * The Module 4 auto-checks, as pure functions of (task, last response).
 *
 * Three of the four run entirely in the browser against the response text. The fourth —
 * `extract-dates` — cannot, and the asymmetry is the interesting part of the design: its
 * JSON Schema is sent to the model as `format` and validated **on the server**, so the
 * only honest thing the browser can do is read the server's verdict. A client-side
 * re-implementation would be a second validator to keep in sync and a task a learner
 * could pass by editing the page.
 *
 * Pure so `test/promptChecks.test.ts` can exercise every branch without mounting
 * anything; the same split the perceptron and MLP exercises use.
 */

export interface PromptOutcome {
  /** `ChatResponse.message.content` from the last run. */
  content: string;
  /** The user message that produced this response. See `taskWasAttempted`. */
  userPrompt: string;
  /** Present only when the run used structured-output mode. */
  structured?: StructuredOutputResult;
}

/** Whitespace-insensitive comparison, so a stray newline in the editor is not a failure. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Did this run actually attempt this task?
 *
 * Without this gate the checks are satisfiable by accident. `injection-resist` asks for a
 * response that does not contain PWNED, and *any* answer to *any* other question also does
 * not contain PWNED -- so asking the model for three bullet points used to tick the
 * injection task too. A check that a learner passes without reading the task teaches
 * nothing. The same reasoning applies to the refusal task.
 *
 * The rule: a task that ships its own `userPrompt` only counts on a run that actually used
 * it. Tasks with no declared prompt (none today, but the schema allows it) are open.
 */
export function taskWasAttempted(task: PromptTask, outcome: PromptOutcome): boolean {
  if (!task.userPrompt) return true;
  return normalise(task.userPrompt) === normalise(outcome.userPrompt);
}

function structuredPasses(
  check: Extract<PromptCheck, { type: 'structured' }>,
  outcome: PromptOutcome,
): boolean {
  if (!outcome.structured?.valid) return false;
  const value = outcome.structured.value;
  if (!check.minItems) return true;
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  // The schema can say `minItems`, but a schema the learner edited may not, and the task
  // is "get the three dates" rather than "get some dates".
  return Object.entries(check.minItems).every(([key, minimum]) => {
    const entry = record[key];
    return Array.isArray(entry) && entry.length >= minimum;
  });
}

export function evaluatePromptCheck(check: PromptCheck, outcome: PromptOutcome): boolean {
  const content = outcome.content.trim();
  switch (check.type) {
    case 'regex': {
      if (content === '') return false;
      let regex: RegExp;
      try {
        regex = new RegExp(check.pattern, check.flags);
      } catch {
        // An unparseable pattern is a content bug. Failing the task (rather than throwing
        // and blanking the playground) keeps the rest of the exercise usable.
        return false;
      }
      return regex.test(content);
    }
    case 'not_contains': {
      // An empty response trivially "does not contain PWNED"; that is not surviving an
      // injection, it is not answering.
      if (content === '') return false;
      return check.caseSensitive
        ? !content.includes(check.value)
        : !content.toLowerCase().includes(check.value.toLowerCase());
    }
    case 'structured':
      return structuredPasses(check, outcome);
  }
}

/** The ids passing right now. `useExercisePersistence` turns them into the growing union. */
export function evaluatePromptTasks(
  tasks: readonly PromptTask[],
  outcome: PromptOutcome | null,
): string[] {
  if (!outcome) return [];
  return tasks
    .filter((task) => taskWasAttempted(task, outcome) && evaluatePromptCheck(task.check, outcome))
    .map((task) => task.id);
}
