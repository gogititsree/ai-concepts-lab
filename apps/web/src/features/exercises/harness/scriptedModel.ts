import type { HarnessScenarioId } from '@lab/shared';

import type { HarnessAssistantReply, HarnessMessage } from './protocol';

/**
 * The deterministic in-worker fake model.
 *
 * Module 6's three auto-checks have to be reproducible on a laptop with no Ollama, or
 * with an Ollama that takes 70 seconds for its first call (docs/spike-notes.md → M10
 * measurements). So the scripted model exists, and "deterministic" here is a hard
 * property rather than an aspiration:
 *
 *  - **No timers.** `chat` resolves synchronously through an already-resolved promise.
 *    There is no `setTimeout`, so a scripted check cannot be slow and cannot be flaky.
 *  - **No randomness, no clock.** Nothing reads `Math.random` or `Date`.
 *  - **The reply depends only on (scenario, call index).** Not on the transcript.
 *
 * That last one is the load-bearing choice and it is worth defending, because the
 * obvious alternative — have the fake read the transcript and answer with the tool
 * result it finds there — is *more* realistic and makes the checks *worse*. Checks have
 * to fail one at a time. If the final answer depended on the transcript, then a learner
 * who forgot to append tool messages would fail `terminates` **and**
 * `appends-tool-message`, and the first red tick they read would point at the wrong bug.
 * Ignoring the transcript keeps each check a statement about exactly one property.
 *
 * ## The three scenarios (docs/04-curriculum.md → Module 6)
 *
 * | scenario | call 1 | call 2+ | what it catches |
 * |---|---|---|---|
 * | `single-tool` | text + a good `calculator` call | the final answer | a loop that never terminates, or never executes tools |
 * | `malformed-args` | no text + a call whose arguments did not parse | the final answer | a loop that throws on a bad tool call instead of feeding the error back |
 * | `never-stops` | a tool call | a tool call, for ever | a loop with no iteration cap |
 */

export const SCRIPTED_QUESTION = 'What is 17 * 23? Use the calculator tool.';
/** The number the correct final answer contains. `terminates` looks for exactly this. */
export const SCRIPTED_ANSWER = '391';
const SCRIPTED_FINAL_TEXT = '17 * 23 = 391.';

/**
 * `single-tool`'s first reply carries text *as well as* a tool call, and that is not
 * decoration. It is the trap for the commonest wrong loop: "the model said something, so
 * that must be the answer". A loop that returns on non-empty content instead of on
 * "no tool calls" answers `Let me work that out with the calculator.` and fails
 * `terminates` while passing the other two.
 */
const SINGLE_TOOL_PREAMBLE = 'Let me work that out with the calculator.';

/** Thrown when a loop with no cap keeps going. Deterministic, and instant. */
export class ScriptedRunawayError extends Error {
  constructor(readonly calls: number) {
    super(
      `The scripted model was called ${calls} times. This scenario never stops asking for ` +
        'tools, so a loop that has no maximum-iteration cap never returns. Stop after ' +
        'maxIterations model calls.',
    );
    this.name = 'ScriptedRunawayError';
  }
}

/**
 * How far past the cap the fake will play along before it throws.
 *
 * It has to be *past* `maxIterations` so that a loop which is merely off by one gets a
 * useful count in the failure message ("you made 7 calls, the cap is 6") rather than an
 * exception. Three times plus a few is generous and still instant.
 */
export const runawayLimit = (maxIterations: number): number => maxIterations * 3 + 6;

const toolCall = (index: number, expression: string) => ({
  id: `call_${index}`,
  name: 'calculator',
  args: { expression },
  parseOk: true,
});

/** The reply for one (scenario, 1-based call index). A pure function; tested as one. */
export function scriptedReply(scenario: HarnessScenarioId, call: number): HarnessAssistantReply {
  switch (scenario) {
    case 'single-tool':
      return call === 1
        ? { content: SINGLE_TOOL_PREAMBLE, toolCalls: [toolCall(1, '17 * 23')] }
        : { content: SCRIPTED_FINAL_TEXT, toolCalls: [] };

    case 'malformed-args':
      return call === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'calculator',
                // Both signals at once, so either way of noticing works: `parseOk` is
                // false for a loop that inspects it, and `args` is null so a loop that
                // just calls the tool gets a thrown `HarnessToolError` to catch.
                args: null,
                parseOk: false,
                rawArgs: '{"expression": "17 * 23',
              },
            ],
          }
        : { content: SCRIPTED_FINAL_TEXT, toolCalls: [] };

    case 'never-stops':
      // Empty content for every reply: this scenario must not also trip the
      // "returns on non-empty content" bug, or `max-iterations` would stop being a
      // statement about the cap alone.
      return { content: '', toolCalls: [toolCall(call, '1 + 1')] };
  }
}

export interface ScriptedModel {
  chat(messages: HarnessMessage[]): Promise<HarnessAssistantReply>;
  /** How many times the learner's loop called it. The `max-iterations` check reads this. */
  readonly calls: number;
}

export function createScriptedModel(
  scenario: HarnessScenarioId,
  maxIterations: number,
): ScriptedModel {
  const limit = runawayLimit(maxIterations);
  let calls = 0;
  return {
    async chat() {
      calls += 1;
      if (calls > limit) throw new ScriptedRunawayError(calls);
      return scriptedReply(scenario, calls);
    },
    get calls() {
      return calls;
    },
  };
}
