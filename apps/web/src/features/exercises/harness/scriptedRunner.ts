import type { HarnessScenarioId } from '@lab/shared';

import type { ScenarioOutcome } from './checks';
import { runHarness } from './harnessCore';
import { SCRIPTED_TIMEOUT_MS } from './protocol';
import { createScriptedModel, SCRIPTED_QUESTION } from './scriptedModel';
import { createWorkerTools, HARNESS_TOOL_DEFINITIONS } from './workerTools';

/**
 * One scripted scenario, end to end, with no I/O of any kind.
 *
 * This is the function the worker calls three times when the learner presses "Run
 * scripted checks", and the one `apps/web/test/harnessCore.test.ts` calls twelve times
 * (four solutions × three scenarios) to prove the checks discriminate. It is the same
 * code path in both cases, which is what makes the test evidence about the feature
 * rather than about a parallel implementation of it.
 *
 * **Never throws.** Every failure — a syntax error, an exception from the learner's
 * loop, the scripted model's runaway guard — comes back as `ok: false` with the message
 * in `error`, because all three are *results* that a check has to be able to read and
 * explain. A thrown exception here would mean one broken scenario lost the other two.
 */

/** Frozen so `get_current_time` is reproducible to the millisecond in scripted mode. */
export const SCRIPTED_NOW = new Date('2026-09-19T09:00:00.000Z');

export interface RunScenarioOptions {
  scenario: HarnessScenarioId;
  code: string;
  maxIterations: number;
  onLog?: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  /** Milliseconds. Only reachable by a loop that spins while *awaiting*; see the worker. */
  deadlineMs?: number;
}

export async function runScriptedScenario(options: RunScenarioOptions): Promise<ScenarioOutcome> {
  const model = createScriptedModel(options.scenario, options.maxIterations);
  const tools = createWorkerTools(Object.keys(HARNESS_TOOL_DEFINITIONS), {
    now: () => SCRIPTED_NOW,
  });

  const base = {
    scenario: options.scenario,
    maxIterations: options.maxIterations,
  };

  try {
    const output = await runHarness({
      code: options.code,
      userMessage: SCRIPTED_QUESTION,
      maxIterations: options.maxIterations,
      tools,
      toolDefs: Object.values(HARNESS_TOOL_DEFINITIONS),
      chat: (messages) => model.chat(messages),
      onLog: options.onLog ?? (() => {}),
      // Scripted runs report nothing: there is no `agent_runs` row behind them, and a
      // check that passed against a trace nobody can open would be a lie by omission.
      onStep: () => {},
      deadlineMs: options.deadlineMs ?? SCRIPTED_TIMEOUT_MS,
    });
    return {
      ...base,
      ok: true,
      finalText: output.finalText,
      messages: output.messages,
      modelCalls: output.modelCalls,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      finalText: '',
      messages: [],
      // `model.calls` rather than zero: "your loop made 24 calls before it blew up" is
      // the sentence the `max-iterations` failure message needs.
      modelCalls: model.calls,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
