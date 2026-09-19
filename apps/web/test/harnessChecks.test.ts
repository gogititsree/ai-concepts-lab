import { HARNESS_CHECK_SCENARIOS, HARNESS_SCENARIO_IDS, type HarnessScenarioId } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateHarnessChecks,
  realRunPassed,
  type ScenarioOutcome,
  type ScenarioOutcomes,
} from '../src/features/exercises/harness/checks';
import type { HarnessMessage } from '../src/features/exercises/harness/protocol';
import {
  createScriptedModel,
  runawayLimit,
  ScriptedRunawayError,
  scriptedReply,
} from '../src/features/exercises/harness/scriptedModel';
import {
  evaluateExpression,
  createWorkerTools,
} from '../src/features/exercises/harness/workerTools';
import { HAPPY_STEPS, runDetail } from './fixtures/runs';

/**
 * The three checks and the scripted model, exercised as pure functions.
 *
 * `harnessCore.test.ts` drives the same checks from real runs of the reference solution,
 * which is the acceptance test. This file is the complement: every *branch* of every
 * failure message, reached from a hand-built outcome, including the ones a plausible
 * wrong solution would not produce. Between the two, no branch in `checks.ts` is
 * unvisited and every message a learner can be shown has been read by a test.
 */

const outcome = (over: Partial<ScenarioOutcome> = {}): ScenarioOutcome => ({
  scenario: 'single-tool',
  ok: true,
  finalText: '17 * 23 = 391.',
  messages: [
    { role: 'user', content: 'What is 17 * 23?' },
    { role: 'assistant', content: '', toolCalls: [] },
    { role: 'tool', toolName: 'calculator', content: '{"expression":"17 * 23","result":391}' },
  ],
  modelCalls: 2,
  maxIterations: 6,
  error: null,
  ...over,
});

const good: ScenarioOutcomes = {
  'single-tool': outcome(),
  'malformed-args': outcome({
    scenario: 'malformed-args',
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [] },
      { role: 'tool', toolName: 'calculator', content: '{"error":"not valid JSON"}' },
    ],
  }),
  'never-stops': outcome({ scenario: 'never-stops', finalText: '', modelCalls: 6 }),
};

const resultFor = (id: string, outcomes: ScenarioOutcomes) => {
  const found = evaluateHarnessChecks(outcomes).find((entry) => entry.id === id);
  if (!found) throw new Error(`no check named ${id}`);
  return found;
};

describe('evaluateHarnessChecks', () => {
  it('returns one result per check, always, in a stable order', () => {
    const ids = evaluateHarnessChecks({}).map((result) => result.id);
    expect(ids).toEqual(Object.keys(HARNESS_CHECK_SCENARIOS));
    // Same rows before and after a run: a checklist that grows reads as flicker.
    expect(evaluateHarnessChecks(good).map((result) => result.id)).toEqual(ids);
  });

  it('passes everything for a well-behaved set of outcomes', () => {
    expect(evaluateHarnessChecks(good).every((result) => result.passed)).toBe(true);
    expect(evaluateHarnessChecks(good).every((result) => result.reason === '')).toBe(true);
  });

  it('is not fooled by a partial run', () => {
    const { 'never-stops': _dropped, ...partial } = good;
    expect(resultFor('max-iterations', partial).reason).toMatch(/Not run yet/);
    expect(resultFor('terminates', partial).passed).toBe(true);
  });
});

describe('terminates', () => {
  it('fails when the run threw', () => {
    const result = resultFor('terminates', {
      ...good,
      'single-tool': outcome({ ok: false, error: 'boom' }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('boom');
  });

  it('fails, quoting what came back, when the answer is the narration', () => {
    const result = resultFor('terminates', {
      ...good,
      'single-tool': outcome({ finalText: 'Let me work that out with the calculator.' }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Let me work that out');
    expect(result.reason).toContain('391');
  });

  it('accepts the answer wherever in the sentence it appears', () => {
    for (const text of ['391', 'The answer is 391.', 'seventeen times 23 is 391 exactly']) {
      expect(
        resultFor('terminates', { ...good, 'single-tool': outcome({ finalText: text }) }).passed,
      ).toBe(true);
    }
  });
});

describe('appends-tool-message', () => {
  const withMessages = (
    messages: HarnessMessage[],
    scenario: HarnessScenarioId = 'single-tool',
  ) => ({
    ...good,
    [scenario]: outcome({ scenario, messages, ...(scenario === 'malformed-args' ? {} : {}) }),
  });

  it('fails when nothing has role tool', () => {
    const result = resultFor(
      'appends-tool-message',
      withMessages([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '{"result":391}' },
      ]),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/role 'tool'/);
  });

  it('fails when the tool message precedes any assistant turn', () => {
    const result = resultFor(
      'appends-tool-message',
      withMessages([
        { role: 'tool', content: '{"result":391}' },
        { role: 'assistant', content: '' },
      ]),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/before any assistant/);
  });

  it('fails when the tool message does not carry the result', () => {
    const result = resultFor(
      'appends-tool-message',
      withMessages([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'done' },
      ]),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/none of them contains/);
  });

  it('fails, and says why, when the loop crashed on the malformed call', () => {
    const result = resultFor('appends-tool-message', {
      ...good,
      'malformed-args': outcome({
        scenario: 'malformed-args',
        ok: false,
        error: 'calculator: "expression" is required',
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/observation, not an exception/);
  });

  it('fails when the malformed call survived but was never reported to the model', () => {
    const result = resultFor('appends-tool-message', {
      ...good,
      'malformed-args': outcome({
        scenario: 'malformed-args',
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: '' },
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/appended no 'tool' message/);
  });

  it('does not throw on a message whose content is not a string', () => {
    const result = resultFor(
      'appends-tool-message',
      withMessages([
        { role: 'assistant', content: '' },
        { role: 'tool', content: { result: 391 } as unknown as string },
      ]),
    );
    expect(result.passed).toBe(true);
  });
});

describe('max-iterations', () => {
  it('fails when the loop ran away', () => {
    const result = resultFor('max-iterations', {
      ...good,
      'never-stops': outcome({
        scenario: 'never-stops',
        ok: false,
        error: 'runaway',
        modelCalls: 24,
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/never returned/);
  });

  it('fails when the loop stopped early, and quotes both numbers', () => {
    const result = resultFor('max-iterations', {
      ...good,
      'never-stops': outcome({ scenario: 'never-stops', modelCalls: 1, maxIterations: 6 }),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('1 model call ');
    expect(result.reason).toContain('cap was 6');
  });

  it('fails when the loop overshoots by one', () => {
    expect(
      resultFor('max-iterations', {
        ...good,
        'never-stops': outcome({ scenario: 'never-stops', modelCalls: 7 }),
      }).passed,
    ).toBe(false);
  });
});

describe('the optional real run', () => {
  it('passes only for a completed run carrying a final step', () => {
    expect(realRunPassed(null)).toBe(false);
    expect(realRunPassed(runDetail(HAPPY_STEPS))).toBe(true);
    expect(realRunPassed(runDetail(HAPPY_STEPS, { status: 'cancelled' }))).toBe(false);
    expect(realRunPassed(runDetail(HAPPY_STEPS.slice(0, 3)))).toBe(false);
  });
});

// ------------------------------------------------------------- the scripted model ----

describe('the scripted model is deterministic', () => {
  it('has no timers, no clock and no randomness: the same call index gives the same reply', () => {
    for (const scenario of HARNESS_SCENARIO_IDS) {
      for (const call of [1, 2, 3, 7]) {
        expect(JSON.stringify(scriptedReply(scenario, call))).toBe(
          JSON.stringify(scriptedReply(scenario, call)),
        );
      }
    }
  });

  it('ignores the transcript entirely', async () => {
    const a = createScriptedModel('single-tool', 6);
    const b = createScriptedModel('single-tool', 6);
    const first = await a.chat([{ role: 'user', content: 'anything' }]);
    const second = await b.chat([
      { role: 'user', content: 'something completely different' },
      { role: 'tool', content: 'noise' },
    ]);
    expect(second).toEqual(first);
  });

  it('narrates and calls a tool in the same turn on single-tool', () => {
    const reply = scriptedReply('single-tool', 1);
    expect(reply.content).not.toBe('');
    expect(reply.toolCalls).toHaveLength(1);
    expect(scriptedReply('single-tool', 2).toolCalls).toHaveLength(0);
    expect(scriptedReply('single-tool', 2).content).toContain('391');
  });

  it('hands back an unparsed tool call exactly once on malformed-args', () => {
    const first = scriptedReply('malformed-args', 1);
    expect(first.toolCalls[0]?.parseOk).toBe(false);
    expect(first.toolCalls[0]?.args).toBeNull();
    expect(first.toolCalls[0]?.rawArgs).toContain('{"expression"');
    expect(scriptedReply('malformed-args', 2).toolCalls).toHaveLength(0);
  });

  it('never stops, and never says anything, on never-stops', () => {
    for (const call of [1, 5, 40]) {
      const reply = scriptedReply('never-stops', call);
      expect(reply.content).toBe('');
      expect(reply.toolCalls).toHaveLength(1);
    }
  });

  it('throws a counted runaway error rather than looping for ever', async () => {
    const model = createScriptedModel('never-stops', 4);
    const limit = runawayLimit(4);
    for (let index = 0; index < limit; index += 1) await model.chat([]);
    await expect(model.chat([])).rejects.toBeInstanceOf(ScriptedRunawayError);
    expect(model.calls).toBe(limit + 1);
  });
});

// ------------------------------------------------------------------- worker tools ----

describe('the browser tools', () => {
  const tools = createWorkerTools(['calculator', 'get_current_time'], {
    now: () => new Date('2026-09-19T09:00:00.000Z'),
  });

  it('evaluates arithmetic without eval', () => {
    expect(evaluateExpression('17 * 23')).toBe(391);
    expect(evaluateExpression('2500 * (1 + 0.07)^8')).toBeCloseTo(4295.4654, 3);
    expect(evaluateExpression('2 ** 10')).toBe(1024);
    expect(evaluateExpression('1,234 + 1')).toBe(1235);
    expect(evaluateExpression('-3 + 5 % 3')).toBe(-1);
  });

  it('refuses anything that is not arithmetic, at the tokeniser', () => {
    for (const bad of ['process.env', 'fetch("/x")', '1 + x', '`${1}`']) {
      expect(() => evaluateExpression(bad)).toThrow(/unexpected character|expected a number/);
    }
    expect(() => evaluateExpression('1/0')).toThrow(/division by zero/);
    expect(() => evaluateExpression('(1 + 2')).toThrow(/missing "\)"/);
  });

  it('throws on missing arguments rather than returning an error object', () => {
    // Load-bearing: a tool that returned {error} would let a loop with no try/catch pass
    // the malformed-arguments scenario, which is the one thing that scenario is for.
    expect(() => tools.calculator?.(null)).toThrow(/"expression" is required/);
    expect(() => tools.calculator?.({})).toThrow(/"expression" is required/);
    expect(tools.calculator?.({ expression: '17 * 23' })).toEqual({
      expression: '17 * 23',
      result: 391,
    });
  });

  it('reads the injected clock, so scripted runs are reproducible', () => {
    expect(tools.get_current_time?.({})).toMatchObject({
      iso: '2026-09-19T09:00:00.000Z',
      timezone: 'UTC',
      weekday: 'Saturday',
    });
  });

  it('exposes only the tools it was asked for', () => {
    expect(Object.keys(createWorkerTools(['calculator'], { now: () => new Date(0) }))).toEqual([
      'calculator',
    ]);
    expect(Object.keys(createWorkerTools(['nope'], { now: () => new Date(0) }))).toEqual([]);
  });
});
