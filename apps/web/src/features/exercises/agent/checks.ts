import { TOOL_CATALOG_NAMES, type AgentCheck, type AgentTask, type RunDetail } from '@lab/shared';

/**
 * Module 5's auto-checks, as pure functions of (task, completed run).
 *
 * Every check reads the **persisted trace**, not the final answer and not anything the
 * browser remembers about the request. That is the design point and it is worth stating:
 * the evidence a task passed is the same list of steps the learner can see in the trace
 * viewer, so a tick is always explainable by pointing at a row. It also means these
 * checks are equally valid against a run loaded from `/runs/:id` a week later.
 *
 * Pure, so `test/agentChecks.test.ts` can drive every branch from fixture traces without
 * mounting a component or touching an API.
 */

const CATALOG = new Set<string>(TOOL_CATALOG_NAMES);

/** Index of the first `final` step, or the end of the trace if the run never got there. */
function finalIndex(run: RunDetail): number {
  const index = run.steps.findIndex((step) => step.kind === 'final');
  return index === -1 ? run.steps.length : index;
}

/**
 * Every number in the final answer, so "within 1 %" does not depend on the model's
 * phrasing. `$4,295.47`, `4295.47` and `The balance is 4295.47.` all yield 4295.47; the
 * task is about whether the agent computed the right thing, not about output formatting
 * (Module 4 is where formatting is the lesson).
 */
export function numbersIn(text: string): number[] {
  const matches = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches
    .map((raw) => Number(raw.replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

const withinPercent = (value: number, expected: number, percent: number): boolean =>
  Math.abs(value - expected) <= Math.abs(expected) * (percent / 100);

export function evaluateAgentCheck(check: AgentCheck, run: RunDetail): boolean {
  switch (check.type) {
    case 'numeric-answer': {
      if (run.status !== 'completed') return false;
      const called = run.steps.some(
        (step) => step.kind === 'tool_call' && step.toolName === check.toolCalled,
      );
      if (!called) return false;
      const answer = run.finalOutput ?? '';
      // Any number in the answer may be the one: a model often restates the inputs
      // ("2500 at 7% for 8 years gives 4295.47") before the result.
      return numbersIn(answer).some((value) =>
        withinPercent(value, check.expected, check.withinPercent),
      );
    }

    case 'tool-before-final': {
      const end = finalIndex(run);
      if (end === run.steps.length) return false; // no final step: the run did not answer
      return run.steps
        .slice(0, end)
        .some((step) => step.kind === 'tool_call' && step.toolName === check.toolName);
    }

    case 'mock-tool-called': {
      // A tool call the *server* did not supply, that parsed cleanly. `parseOk` matters:
      // a garbled call to a made-up name is the hallucination failure mode, not this task.
      return run.steps.some(
        (step) =>
          step.kind === 'tool_call' &&
          step.toolName !== null &&
          !CATALOG.has(step.toolName) &&
          step.parseOk === true,
      );
    }

    case 'error-observed': {
      // A tool that failed, not a run that failed: the lesson is that the loop survives
      // a broken tool, so a `MODEL_UNAVAILABLE` run does not count.
      return run.steps.some((step) => step.kind === 'tool_result' && step.isError);
    }
  }
}

export interface AgentEvaluationInput {
  run: RunDetail | null;
  /** The reflection text; `error-observed` needs one. */
  reflection: string;
}

/** The minimum reflection worth crediting. One word is not a reflection. */
export const MIN_REFLECTION_CHARS = 20;

/** The ids passing right now; `useExercisePersistence` turns them into the growing union. */
export function evaluateAgentTasks(
  tasks: readonly AgentTask[],
  input: AgentEvaluationInput,
): string[] {
  const { run, reflection } = input;
  if (!run) return [];
  return tasks
    .filter((task) => {
      if (!evaluateAgentCheck(task.check, run)) return false;
      if (task.check.type === 'error-observed' && task.check.requiresReflection) {
        return reflection.trim().length >= MIN_REFLECTION_CHARS;
      }
      return true;
    })
    .map((task) => task.id);
}

// -------------------------------------------------------- the mock-tool builder ----

export interface MockToolDraft {
  name: string;
  description: string;
  parametersText: string;
  responseText: string;
}

export interface MockToolValidation {
  /** Field name → message. Empty when the draft is submittable. */
  errors: Record<string, string>;
  parameters: Record<string, unknown> | null;
  response: unknown;
}

function parseJsonObject(text: string): { value: unknown; error: string | null } {
  if (text.trim() === '') return { value: null, error: 'required' };
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: (error as Error).message };
  }
}

/**
 * Validates the "add mock tool" form **before** it is submitted.
 *
 * The server validates all of this again — it has to, it is the boundary — but a learner
 * typing a JSON Schema into a textarea deserves to be told about the missing brace
 * before they wait 30 seconds for a run to fail. The name rule is the server's rule,
 * spelled the same way, because "invalid function name" arriving as a 400 from three
 * layers down is a worse experience than a red line under the field.
 */
export function validateMockTool(draft: MockToolDraft): MockToolValidation {
  const errors: Record<string, string> = {};

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(draft.name)) {
    errors.name = 'Letters, digits and underscores, starting with a letter.';
  } else if (CATALOG.has(draft.name)) {
    errors.name = `"${draft.name}" is a built-in tool; pick another name.`;
  }

  if (draft.description.trim().length < 20) {
    // Not pedantry: the description *is* the prompt, and a five-word one is the single
    // most common reason a mock tool is never called. Lesson 2 says so; the form insists.
    errors.description =
      'At least 20 characters — this text is what tells the model when to call it.';
  }

  const parsedParameters = parseJsonObject(draft.parametersText);
  let parameters: Record<string, unknown> | null = null;
  if (parsedParameters.error !== null) {
    errors.parameters = `Not valid JSON: ${parsedParameters.error}`;
  } else if (
    typeof parsedParameters.value !== 'object' ||
    parsedParameters.value === null ||
    Array.isArray(parsedParameters.value)
  ) {
    errors.parameters = 'Must be a JSON object.';
  } else {
    parameters = parsedParameters.value as Record<string, unknown>;
    if (parameters.type !== 'object') {
      errors.parameters = 'A tool schema must have "type": "object" at the top level.';
    }
  }

  const parsedResponse = parseJsonObject(draft.responseText);
  if (parsedResponse.error !== null) {
    errors.response = `Not valid JSON: ${parsedResponse.error}`;
  }

  return { errors, parameters, response: parsedResponse.value };
}
