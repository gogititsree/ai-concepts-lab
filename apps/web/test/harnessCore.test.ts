import type { HarnessScenarioId } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateHarnessChecks,
  type HarnessCheckResult,
  type ScenarioOutcomes,
} from '../src/features/exercises/harness/checks';
import {
  compileRunAgent,
  formatLogArgs,
  HarnessCompileError,
  runHarness,
  validateResult,
} from '../src/features/exercises/harness/harnessCore';
import {
  BROKEN_EARLY_RETURN,
  BROKEN_NO_CAP,
  BROKEN_NO_TOOL_MESSAGE,
  REFERENCE_SOLUTION,
} from '../src/features/exercises/harness/reference';
import { runScriptedScenario } from '../src/features/exercises/harness/scriptedRunner';
import { createWorkerTools } from '../src/features/exercises/harness/workerTools';

/**
 * **The milestone's acceptance test.**
 *
 * jsdom has no `Worker`, so this suite does what the worker does *without* the worker:
 * `runScriptedScenario` is the exact function `harnessRunner.worker.ts` calls, compiling
 * the same source strings with the same `new Function` sandbox against the same scripted
 * model. The worker's own thin layer — the message protocol — is covered separately in
 * `harnessWorkerProtocol.test.ts` against a stub `Worker`. Between the two there is no
 * untested seam except `postMessage` itself.
 *
 * The grid below is the point of the whole exercise. A checking harness that no wrong
 * answer fails is not a checking harness, so the reference must pass all three checks
 * and each of three deliberately broken variants must fail **exactly one** — the one
 * that names its bug. If a future change to the scripted model or to a check smears one
 * failure across two rows, this table goes red and says which.
 */

const SCENARIOS: HarnessScenarioId[] = ['single-tool', 'malformed-args', 'never-stops'];
const MAX = 6;

async function checksFor(code: string): Promise<Record<string, HarnessCheckResult>> {
  const outcomes: ScenarioOutcomes = {};
  for (const scenario of SCENARIOS) {
    outcomes[scenario] = await runScriptedScenario({ scenario, code, maxIterations: MAX });
  }
  return Object.fromEntries(evaluateHarnessChecks(outcomes).map((result) => [result.id, result]));
}

const failing = (results: Record<string, HarnessCheckResult>): string[] =>
  Object.values(results)
    .filter((result) => !result.passed)
    .map((result) => result.id)
    .sort();

describe('the reference solution', () => {
  it('passes all three scripted checks', async () => {
    const results = await checksFor(REFERENCE_SOLUTION);
    expect(failing(results)).toEqual([]);
  });

  it('terminates on single-tool with the calculator s answer, in two model calls', async () => {
    const outcome = await runScriptedScenario({
      scenario: 'single-tool',
      code: REFERENCE_SOLUTION,
      maxIterations: MAX,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.finalText).toContain('391');
    expect(outcome.modelCalls).toBe(2);
    // user, assistant(+toolCalls), tool. The `tool` message is the one two checks read.
    expect(outcome.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(outcome.messages[2]?.content).toContain('391');
  });

  it('feeds a malformed tool call back as an observation and carries on', async () => {
    const outcome = await runScriptedScenario({
      scenario: 'malformed-args',
      code: REFERENCE_SOLUTION,
      maxIterations: MAX,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.finalText).toContain('391');
    const toolMessage = outcome.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('error');
  });

  it('stops at exactly maxIterations when the model never finishes', async () => {
    const outcome = await runScriptedScenario({
      scenario: 'never-stops',
      code: REFERENCE_SOLUTION,
      maxIterations: MAX,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.modelCalls).toBe(MAX);
    // Honest about having no answer rather than inventing one.
    expect(outcome.finalText).toBe('');
  });

  it('respects whatever cap it is handed', async () => {
    for (const cap of [2, 3, 9]) {
      const outcome = await runScriptedScenario({
        scenario: 'never-stops',
        code: REFERENCE_SOLUTION,
        maxIterations: cap,
      });
      expect(outcome.modelCalls).toBe(cap);
    }
  });
});

describe('the broken variants each fail exactly the check that names their bug', () => {
  it('is actually three different programs', () => {
    // The variants are built by string replacement, so a refactor of the reference that
    // broke a replacement would silently produce three copies of a correct solution —
    // and every assertion below would pass for the wrong reason.
    const sources = [
      REFERENCE_SOLUTION,
      BROKEN_NO_TOOL_MESSAGE,
      BROKEN_NO_CAP,
      BROKEN_EARLY_RETURN,
    ];
    expect(new Set(sources).size).toBe(4);
  });

  it('no tool-message append -> only appends-tool-message', async () => {
    const results = await checksFor(BROKEN_NO_TOOL_MESSAGE);
    expect(failing(results)).toEqual(['appends-tool-message']);
    expect(results['appends-tool-message']?.reason).toMatch(/role 'tool'/);
  });

  it('no iteration cap -> only max-iterations', async () => {
    const results = await checksFor(BROKEN_NO_CAP);
    expect(failing(results)).toEqual(['max-iterations']);
    expect(results['max-iterations']?.reason).toMatch(/never returned/);
  });

  it('returns before the final answer -> only terminates', async () => {
    const results = await checksFor(BROKEN_EARLY_RETURN);
    expect(failing(results)).toEqual(['terminates']);
    // The failure message quotes what they returned, which is the whole diagnosis.
    expect(results.terminates?.reason).toMatch(/Let me work that out/);
  });
});

describe('scripted determinism', () => {
  it('produces byte-identical results across repeated runs', async () => {
    const once = await checksFor(REFERENCE_SOLUTION);
    const twice = await checksFor(REFERENCE_SOLUTION);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('produces identical transcripts across repeated runs', async () => {
    const runOnce = () =>
      runScriptedScenario({
        scenario: 'single-tool',
        code: REFERENCE_SOLUTION,
        maxIterations: MAX,
      });
    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('what the runner does with a broken submission', () => {
  const run = (code: string) =>
    runScriptedScenario({ scenario: 'single-tool', code, maxIterations: MAX });

  it('reports a syntax error instead of throwing', async () => {
    const outcome = await run('async function runAgent( {');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/did not compile/);
  });

  it('says so when there is no runAgent at all', async () => {
    const outcome = await run('const helper = 1;');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/must define a function called runAgent/);
  });

  it('names the missing half of the contract', async () => {
    const outcome = await run('async function runAgent() { return { finalText: "hi" }; }');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/messages/);
  });

  it('turns an exception inside the loop into a failed outcome, not a crash', async () => {
    const outcome = await run('async function runAgent() { throw new Error("boom"); }');
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('boom');
  });

  it('every check reports "not run yet" before anything has run', () => {
    const results = evaluateHarnessChecks({});
    expect(results).toHaveLength(3);
    expect(results.every((result) => !result.passed)).toBe(true);
    expect(results.every((result) => /Not run yet/.test(result.reason))).toBe(true);
  });
});

describe('the sandbox', () => {
  const noopConsole = { log() {}, info() {}, warn() {}, error() {} };

  it('shadows the ambient globals a loop has no business touching', async () => {
    const outcome = await runScriptedScenario({
      scenario: 'single-tool',
      maxIterations: MAX,
      code: `async function runAgent() {
        if (typeof fetch !== 'undefined') throw new Error('fetch was reachable');
        if (typeof postMessage !== 'undefined') throw new Error('postMessage was reachable');
        if (typeof importScripts !== 'undefined') throw new Error('importScripts was reachable');
        return { finalText: 'ok', messages: [] };
      }`,
    });
    expect(outcome.ok).toBe(true);
  });

  it('routes console.log to the host rather than to the real console', async () => {
    const lines: string[] = [];
    await runScriptedScenario({
      scenario: 'single-tool',
      maxIterations: MAX,
      onLog: (_level, text) => lines.push(text),
      code: `async function runAgent() {
        console.log('hello', { n: 1 });
        return { finalText: 'ok', messages: [] };
      }`,
    });
    expect(lines).toEqual(['hello {"n":1}']);
  });

  it('is honest that it is not a security boundary', () => {
    // Documenting the escape in an assertion rather than only in a comment: if a future
    // change made this fail, the sandbox would have become something stronger than the
    // header comment claims, and the claim should be updated rather than left stale.
    const escape = compileRunAgent(
      "const runAgent = () => ({ finalText: typeof Function('return this')(), messages: [] });",
      noopConsole,
    );
    expect(
      (
        escape({ chat: async () => ({ content: '', toolCalls: [] }) }, {}, '', {
          maxIterations: 1,
          toolDefs: [],
        }) as { finalText: string }
      ).finalText,
    ).toBe('object');
  });

  it('rejects a compile that throws at load time', () => {
    expect(() => compileRunAgent('throw new Error("nope");', noopConsole)).toThrow(
      HarnessCompileError,
    );
  });
});

describe('step emission', () => {
  it('reports one tool_call, one tool_result and one final for a single-tool run', async () => {
    const steps: { kind: string; toolName?: string | null; isError?: boolean }[] = [];
    const model = {
      calls: 0,
      async chat() {
        model.calls += 1;
        return model.calls === 1
          ? {
              content: '',
              toolCalls: [
                { id: 'c1', name: 'calculator', args: { expression: '2+2' }, parseOk: true },
              ],
            }
          : { content: 'It is 4.', toolCalls: [] };
      },
    };
    await runHarness({
      code: REFERENCE_SOLUTION,
      userMessage: 'What is 2+2?',
      maxIterations: 4,
      tools: createWorkerTools(['calculator'], { now: () => new Date(0) }),
      toolDefs: [],
      chat: () => model.chat(),
      onLog: () => {},
      onStep: (step) => steps.push(step),
      deadlineMs: 5000,
    });
    expect(steps.map((step) => step.kind)).toEqual(['tool_call', 'tool_result', 'final']);
    expect(steps[1]?.isError).toBe(false);
  });

  it('marks a thrown tool as an error result, and the loop survives it', async () => {
    const steps: { kind: string; isError?: boolean }[] = [];
    const model = {
      calls: 0,
      async chat() {
        model.calls += 1;
        return model.calls === 1
          ? {
              content: '',
              toolCalls: [{ id: 'c1', name: 'calculator', args: {}, parseOk: true }],
            }
          : { content: 'I could not.', toolCalls: [] };
      },
    };
    const output = await runHarness({
      code: REFERENCE_SOLUTION,
      userMessage: 'x',
      maxIterations: 4,
      tools: createWorkerTools(['calculator'], { now: () => new Date(0) }),
      toolDefs: [],
      chat: () => model.chat(),
      onLog: () => {},
      onStep: (step) => steps.push(step),
      deadlineMs: 5000,
    });
    expect(steps.filter((step) => step.kind === 'tool_result')[0]?.isError).toBe(true);
    expect(output.finalText).toBe('I could not.');
  });

  it('stops a loop that keeps awaiting past the soft deadline', async () => {
    let clock = 0;
    await expect(
      runHarness({
        // Never terminates by itself; the deadline is the only way out.
        code: 'async function runAgent(model) { for(;;) { await model.chat([], []); } }',
        userMessage: 'x',
        maxIterations: 99,
        tools: {},
        toolDefs: [],
        chat: async () => ({ content: '', toolCalls: [] }),
        onLog: () => {},
        onStep: () => {},
        deadlineMs: 1000,
        now: () => {
          clock += 400;
          return clock;
        },
      }),
    ).rejects.toThrow(/still running after/);
  });
});

describe('small pure helpers', () => {
  it('formats console arguments without throwing on a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLogArgs(['a', 1, cyclic])).toBe('a 1 [unserialisable]');
    expect(formatLogArgs([new Error('bad')])).toBe('Error: bad');
  });

  it('accepts a missing finalText but never a missing messages', () => {
    expect(validateResult({ messages: [] })).toEqual({ finalText: '', messages: [] });
    expect(() => validateResult({ finalText: 'x' })).toThrow(/messages/);
    expect(() => validateResult(undefined)).toThrow(/must return an object/);
  });
});
