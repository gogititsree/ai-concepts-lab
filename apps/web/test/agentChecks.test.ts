import type { AgentConfig, AgentTask } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  evaluateAgentCheck,
  evaluateAgentTasks,
  numbersIn,
  validateMockTool,
  type MockToolDraft,
} from '../src/features/exercises/agent/checks';
import { fixtureModule } from './fixtures/content';
import { HAPPY_RUN, HAPPY_STEPS, runDetail, step } from './fixtures/runs';

/**
 * Module 5's task checks, against the **real** `exercises.json` config and fixture
 * traces.
 *
 * Every check reads the persisted trace, so these tests are just traces in and booleans
 * out. The cases that matter are the near misses: a run that called the right tool but
 * got the wrong number, one that answered before calling the tool it was supposed to
 * call, and one where a *run* failed rather than a *tool*.
 */

const config = fixtureModule('agents').exercises[0]?.config as unknown as AgentConfig;
const task = (id: string): AgentTask => {
  const found = config.tasks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

const REFLECTION = 'The tool_result step failed and the loop fed the error back as an observation.';

describe('the config the learner actually gets', () => {
  it('has the four tasks from docs/04 and a 2-of-4 completion rule', () => {
    expect(config.tasks.map((entry) => entry.id)).toEqual([
      'compound-interest',
      'must-check-time',
      'mock-tool',
      'observe-failure',
    ]);
    const rule = fixtureModule('agents').exercises[0]?.completionRule;
    expect(rule).toEqual({ type: 'tasks', required: 2 });
  });
});

describe('compound-interest', () => {
  const check = task('compound-interest').check;

  it('passes on the real trace from lesson 3', () => {
    expect(evaluateAgentCheck(check, HAPPY_RUN)).toBe(true);
  });

  it('fails when the calculator was never called, however right the answer is', () => {
    const run = runDetail([
      step(0, 'model_call', { content: 'It is 4295.47.' }),
      step(1, 'final', { content: 'It is 4295.47.' }),
    ]);
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });

  it('fails when the tool was called but the answer is outside 1 %', () => {
    const run = runDetail(HAPPY_STEPS, { finalOutput: 'The balance is $4600.00.' });
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });

  it('accepts the answer however the model formats the number', () => {
    for (const output of ['$4,295.47', 'The balance after 8 years is 4295.47.', '≈ 4295']) {
      expect(evaluateAgentCheck(check, runDetail(HAPPY_STEPS, { finalOutput: output }))).toBe(true);
    }
  });

  it('ignores the restated inputs and finds the answer among them', () => {
    const run = runDetail(HAPPY_STEPS, {
      finalOutput: '2500 at 7% for 8 years compounds to 4295.47.',
    });
    expect(evaluateAgentCheck(check, run)).toBe(true);
  });

  it('fails on a run that did not complete', () => {
    expect(evaluateAgentCheck(check, runDetail(HAPPY_STEPS, { status: 'max_iterations' }))).toBe(
      false,
    );
  });
});

describe('must-check-time', () => {
  const check = task('must-check-time').check;

  it('passes when the tool call precedes the final step', () => {
    const run = runDetail([
      step(0, 'model_call'),
      step(1, 'tool_call', { toolName: 'get_current_time', parseOk: true }),
      step(2, 'tool_result', { toolName: 'get_current_time', toolResult: { weekday: 'Tuesday' } }),
      step(3, 'final', { iteration: 2, content: 'It is Tuesday.' }),
    ]);
    expect(evaluateAgentCheck(check, run)).toBe(true);
  });

  it('fails when the model answered from memory', () => {
    const run = runDetail([
      step(0, 'model_call', { content: 'It is Tuesday.' }),
      step(1, 'final', { content: 'It is Tuesday.' }),
    ]);
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });

  it('fails when the run never produced a final step', () => {
    const run = runDetail(
      [
        step(0, 'model_call'),
        step(1, 'tool_call', { toolName: 'get_current_time', parseOk: true }),
        step(2, 'error', { isError: true }),
      ],
      { status: 'max_iterations' },
    );
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });
});

describe('mock-tool', () => {
  const check = task('mock-tool').check;

  it('passes on a parsed call to a tool the server catalog does not have', () => {
    const run = runDetail([
      step(0, 'model_call'),
      step(1, 'tool_call', {
        toolName: 'get_order_status',
        toolArgs: { order_id: 'A-1001' },
        parseOk: true,
      }),
      step(2, 'tool_result', { toolName: 'get_order_status', toolResult: { status: 'shipped' } }),
      step(3, 'final', { iteration: 2, content: 'Shipped.' }),
    ]);
    expect(evaluateAgentCheck(check, run)).toBe(true);
  });

  it('does not count a catalog tool', () => {
    expect(evaluateAgentCheck(check, HAPPY_RUN)).toBe(false);
  });

  it('does not count a hallucinated name whose arguments did not parse', () => {
    // That is the failure mode from lesson 4, not this task.
    const run = runDetail([
      step(0, 'model_call'),
      step(1, 'tool_call', { toolName: 'search_web', toolArgsRaw: '{"q":', parseOk: false }),
    ]);
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });
});

describe('observe-failure', () => {
  const check = task('observe-failure').check;
  const failedTool = runDetail([
    step(0, 'model_call'),
    step(1, 'tool_call', { toolName: 'flaky_service', parseOk: true }),
    step(2, 'tool_result', {
      toolName: 'flaky_service',
      isError: true,
      toolResult: { code: 'UPSTREAM_UNAVAILABLE' },
    }),
    step(3, 'final', { iteration: 2, content: 'The service is down.' }),
  ]);

  it('passes when a tool_result failed', () => {
    expect(evaluateAgentCheck(check, failedTool)).toBe(true);
  });

  it('does not count a run that failed without a tool failing', () => {
    // A provider outage is not the lesson: the lesson is the loop surviving a bad tool.
    const run = runDetail([step(0, 'error', { isError: true })], {
      status: 'failed',
      errorCode: 'MODEL_UNAVAILABLE',
    });
    expect(evaluateAgentCheck(check, run)).toBe(false);
  });

  it('needs a written reflection to count as a completed task', () => {
    expect(evaluateAgentTasks(config.tasks, { run: failedTool, reflection: '' })).toEqual([]);
    expect(evaluateAgentTasks(config.tasks, { run: failedTool, reflection: 'no' })).toEqual([]);
    expect(evaluateAgentTasks(config.tasks, { run: failedTool, reflection: REFLECTION })).toEqual([
      'observe-failure',
    ]);
  });
});

describe('evaluateAgentTasks', () => {
  it('returns nothing before a run has finished', () => {
    expect(evaluateAgentTasks(config.tasks, { run: null, reflection: REFLECTION })).toEqual([]);
  });

  it('returns exactly the ids whose checks pass', () => {
    expect(evaluateAgentTasks(config.tasks, { run: HAPPY_RUN, reflection: '' })).toEqual([
      'compound-interest',
    ]);
  });
});

describe('numbersIn', () => {
  it('pulls numbers out of prose, currency and thousands separators', () => {
    expect(numbersIn('The balance is $4,295.47 after 8 years')).toEqual([4295.47, 8]);
    expect(numbersIn('no numbers here')).toEqual([]);
  });
});

describe('validateMockTool', () => {
  const valid: MockToolDraft = {
    name: 'get_order_status',
    description: 'Look up the delivery status of an order by id. Example: {"order_id": "A-1001"}.',
    parametersText: '{"type":"object","properties":{"order_id":{"type":"string"}}}',
    responseText: '{"status":"shipped"}',
  };

  it('accepts a well-formed draft', () => {
    const result = validateMockTool(valid);
    expect(result.errors).toEqual({});
    expect(result.parameters).toMatchObject({ type: 'object' });
    expect(result.response).toEqual({ status: 'shipped' });
  });

  it('rejects a name that is not a valid function name', () => {
    expect(validateMockTool({ ...valid, name: '2fast' }).errors.name).toBeTruthy();
    expect(validateMockTool({ ...valid, name: 'get order' }).errors.name).toBeTruthy();
  });

  it('rejects a name that shadows a built-in tool', () => {
    expect(validateMockTool({ ...valid, name: 'calculator' }).errors.name).toMatch(/built-in/);
  });

  it('insists on a description long enough to steer the model', () => {
    // Lesson 2's rule, made mechanical: a five-word description is why a tool is never
    // called, and the form should say so before a 30-second run does.
    expect(
      validateMockTool({ ...valid, description: 'gets orders' }).errors.description,
    ).toBeTruthy();
  });

  it('names the JSON error rather than saying "invalid"', () => {
    const result = validateMockTool({ ...valid, parametersText: '{"type": "object"' });
    expect(result.errors.parameters).toMatch(/Not valid JSON/);
  });

  it('requires a top-level object schema', () => {
    expect(
      validateMockTool({ ...valid, parametersText: '{"type":"string"}' }).errors.parameters,
    ).toMatch(/"type": "object"/);
    expect(validateMockTool({ ...valid, parametersText: '[]' }).errors.parameters).toMatch(
      /JSON object/,
    );
  });

  it('rejects a response that is not JSON', () => {
    expect(validateMockTool({ ...valid, responseText: 'shipped' }).errors.response).toBeTruthy();
  });
});
