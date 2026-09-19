import {
  HARNESS_CHECK_SCENARIOS,
  type HarnessCheckId,
  type HarnessScenarioId,
  type RunDetail,
} from '@lab/shared';

import type { HarnessMessage } from './protocol';
import { SCRIPTED_ANSWER } from './scriptedModel';

/**
 * Module 6's three auto-checks, as pure functions of the scripted runs' results.
 *
 * Pure, and with no import of the worker, the DOM or the API, for the same reason
 * Module 5's checks are: `apps/web/test/harnessChecks.test.ts` drives every branch from
 * hand-written outcomes, and `apps/web/test/harnessCore.test.ts` drives the same
 * functions from outcomes the *reference solution and three broken variants* actually
 * produced. The second suite is the milestone's real acceptance test; this file is what
 * makes it possible to write.
 *
 * Every failing check carries a `reason` that names the property that was not true and,
 * where it can, the evidence — the text that came back, the number of model calls made.
 * A red tick with no reason is a worse teaching tool than no tick at all, because the
 * learner's next move is to guess.
 */

export interface ScenarioOutcome {
  scenario: HarnessScenarioId;
  /** True when `runAgent` returned a well-shaped result without throwing. */
  ok: boolean;
  finalText: string;
  /** The transcript the learner's loop returned. Two checks read this. */
  messages: HarnessMessage[];
  /** How many times their loop called the model. */
  modelCalls: number;
  /** The cap their loop was given, so a failure message can quote it. */
  maxIterations: number;
  error: string | null;
}

export type ScenarioOutcomes = Partial<Record<HarnessScenarioId, ScenarioOutcome>>;

export interface HarnessCheckResult {
  id: HarnessCheckId;
  passed: boolean;
  /** Empty when passing; otherwise one sentence naming what was not true. */
  reason: string;
}

const fail = (id: HarnessCheckId, reason: string): HarnessCheckResult => ({
  id,
  passed: false,
  reason,
});
const pass = (id: HarnessCheckId): HarnessCheckResult => ({ id, passed: true, reason: '' });

/** Content may be anything a learner pushed; searching it must not throw. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

const isRole = (message: unknown, role: string): boolean =>
  typeof message === 'object' && message !== null && (message as { role?: unknown }).role === role;

const quote = (text: string): string =>
  text.trim() === '' ? 'an empty string' : `"${text.trim().slice(0, 80)}"`;

// -------------------------------------------------------------- the three checks ----

function checkTerminates(outcome: ScenarioOutcome): HarnessCheckResult {
  const id: HarnessCheckId = 'terminates';
  if (!outcome.ok) {
    return fail(id, `The single-tool run did not finish: ${outcome.error ?? 'unknown error'}`);
  }
  if (!outcome.finalText.includes(SCRIPTED_ANSWER)) {
    return fail(
      id,
      `Your loop returned ${quote(outcome.finalText)} as the final answer. The scripted ` +
        `model's last reply contains ${SCRIPTED_ANSWER}; a loop stops when a reply has no ` +
        'tool calls, not when a reply has some text in it.',
    );
  }
  return pass(id);
}

function checkAppendsToolMessage(
  single: ScenarioOutcome,
  malformed: ScenarioOutcome,
): HarnessCheckResult {
  const id: HarnessCheckId = 'appends-tool-message';

  // Half one: the successful call. The result has to go back into the transcript, as a
  // `tool` message, after the assistant turn that asked for it.
  if (!single.ok) {
    return fail(id, `The single-tool run did not finish: ${single.error ?? 'unknown error'}`);
  }
  const toolIndex = single.messages.findIndex((message) => isRole(message, 'tool'));
  if (toolIndex === -1) {
    return fail(
      id,
      "No message with role 'tool' in the transcript your loop returned. The model is " +
        'stateless between calls, so a tool result it cannot see never happened.',
    );
  }
  const assistantBefore = single.messages
    .slice(0, toolIndex)
    .some((message) => isRole(message, 'assistant'));
  if (!assistantBefore) {
    return fail(
      id,
      "The tool message comes before any assistant message. Push the assistant's reply " +
        '(with its tool calls) first, then one tool message per result — that ordering is ' +
        'what makes the transcript a conversation rather than a list.',
    );
  }
  const carriesResult = single.messages.some(
    (message) => isRole(message, 'tool') && asText(message.content).includes(SCRIPTED_ANSWER),
  );
  if (!carriesResult) {
    return fail(
      id,
      `A tool message is there, but none of them contains the calculator's result ` +
        `(${SCRIPTED_ANSWER}). Put the tool's return value in the message's content, ` +
        'JSON-stringified.',
    );
  }

  // Half two: the failed call. This is the half that separates "appends results" from
  // "treats failures as observations" — the malformed-arguments scenario hands back a
  // tool call whose arguments never parsed, and the loop has to survive it.
  if (!malformed.ok) {
    return fail(
      id,
      'Your loop crashed on the malformed-arguments scenario: ' +
        `${malformed.error ?? 'unknown error'}. A tool call that cannot be executed is an ` +
        'observation, not an exception: catch it, append the error as a tool message, and ' +
        'let the model try again.',
    );
  }
  const malformedToolMessage = malformed.messages.some((message) => isRole(message, 'tool'));
  if (!malformedToolMessage) {
    return fail(
      id,
      "Your loop survived the malformed tool call but appended no 'tool' message for it. " +
        'The model needs to be told what went wrong, or its next reply is a guess.',
    );
  }
  return pass(id);
}

function checkMaxIterations(outcome: ScenarioOutcome): HarnessCheckResult {
  const id: HarnessCheckId = 'max-iterations';
  if (!outcome.ok) {
    return fail(
      id,
      `Your loop never returned on the never-stops scenario: ${outcome.error ?? 'unknown error'}`,
    );
  }
  if (outcome.modelCalls !== outcome.maxIterations) {
    return fail(
      id,
      `Your loop made ${outcome.modelCalls} model call${outcome.modelCalls === 1 ? '' : 's'} ` +
        `but the cap was ${outcome.maxIterations}. This scenario asks for a tool on every ` +
        'reply and never stops, so a correct loop runs exactly to the cap and then returns ' +
        'without a final answer.',
    );
  }
  return pass(id);
}

// ----------------------------------------------------------------- the entry point ----

/**
 * Evaluates every check whose scenarios have been run.
 *
 * A check whose scenarios are missing comes back failing with "not run yet" rather than
 * being omitted, so the checklist has a stable set of rows from the moment the exercise
 * mounts. A list that grows as results arrive reads as flicker.
 */
export function evaluateHarnessChecks(outcomes: ScenarioOutcomes): HarnessCheckResult[] {
  const results: HarnessCheckResult[] = [];
  for (const id of Object.keys(HARNESS_CHECK_SCENARIOS) as HarnessCheckId[]) {
    const needed = HARNESS_CHECK_SCENARIOS[id];
    const missing = needed.filter((scenario) => outcomes[scenario] === undefined);
    if (missing.length > 0) {
      results.push(fail(id, 'Not run yet — press "Run scripted checks".'));
      continue;
    }
    switch (id) {
      case 'terminates':
        results.push(checkTerminates(outcomes['single-tool'] as ScenarioOutcome));
        break;
      case 'appends-tool-message':
        results.push(
          checkAppendsToolMessage(
            outcomes['single-tool'] as ScenarioOutcome,
            outcomes['malformed-args'] as ScenarioOutcome,
          ),
        );
        break;
      case 'max-iterations':
        results.push(checkMaxIterations(outcomes['never-stops'] as ScenarioOutcome));
        break;
    }
  }
  return results;
}

/**
 * The optional fourth task: one real run that produced a `final` step.
 *
 * Read off the persisted run rather than off anything the browser remembers, exactly
 * like Module 5's checks — the evidence is a row in `agent_run_steps` that the learner
 * can open at `/runs/:id` a week later. `completionRule.required` is 3, so this one is
 * encouraged and never blocking: on the reference machine a two-call run is 19-32 s warm
 * and 68 s cold, and a module that needed it would be uncompletable without Ollama.
 */
export function realRunPassed(run: RunDetail | null): boolean {
  if (!run || run.status !== 'completed') return false;
  return run.steps.some((step) => step.kind === 'final');
}
