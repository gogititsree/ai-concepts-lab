import type { RunDetail, RunStep, RunStepKind, RunSummary } from '@lab/shared';

/**
 * Trace fixtures.
 *
 * Hand-built rather than recorded, but built to the shapes the API actually produces —
 * the happy path below is the real `compound-interest` run from lesson 3, numbers and
 * all, so a test that passes against it is evidence about a trace a learner will really
 * see.
 */

export const RUN_ID = '11111111-2222-4333-8444-555555555555';

let nextId = 1;

export function step(stepIndex: number, kind: RunStepKind, over: Partial<RunStep> = {}): RunStep {
  nextId += 1;
  return {
    id: nextId,
    stepIndex,
    kind,
    iteration: 1,
    content: null,
    toolName: null,
    toolArgs: null,
    toolArgsRaw: null,
    parseOk: null,
    toolResult: null,
    isError: false,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    raw: null,
    createdAt: '2026-09-15T14:30:05.000Z',
    ...over,
  };
}

export function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: RUN_ID,
    exerciseId: null,
    kind: 'agent',
    provider: 'ollama',
    model: 'gemma4:latest',
    status: 'completed',
    iterationCount: 2,
    toolCallCount: 1,
    toolParseFailureCount: 0,
    promptTokensTotal: 530,
    completionTokensTotal: 44,
    modelLatencyMsTotal: 31648,
    finalOutput: 'The balance after 8 years is $4295.47.',
    errorCode: null,
    errorMessage: null,
    startedAt: '2026-09-15T14:30:05.000Z',
    finishedAt: '2026-09-15T14:30:37.000Z',
    ...over,
  };
}

export function runDetail(steps: RunStep[], over: Partial<RunDetail> = {}): RunDetail {
  return {
    ...runSummary(),
    systemPrompt: 'You are a careful assistant with tools.',
    userPrompt: 'A deposit of 2500 earns 7% interest compounded annually…',
    tools: [{ name: 'calculator', description: 'Evaluate arithmetic.', parameters: {} }],
    options: {},
    maxIterations: 6,
    requestId: 'req-1',
    steps,
    ...over,
  };
}

/** The real `compound-interest` trace from lesson 3. */
export const HAPPY_STEPS: RunStep[] = [
  step(0, 'model_call', { content: '', latencyMs: 23548, promptTokens: 227, completionTokens: 27 }),
  step(1, 'tool_call', {
    toolName: 'calculator',
    toolArgs: { expression: '2500 * (1 + 0.07)^8' },
    parseOk: true,
  }),
  step(2, 'tool_result', {
    toolName: 'calculator',
    toolResult: { result: 4295.465449579802, expression: '2500 * (1 + 0.07)^8' },
    latencyMs: 2,
  }),
  step(3, 'model_call', {
    iteration: 2,
    content: 'The balance after 8 years is $4295.47.',
    latencyMs: 8100,
    promptTokens: 303,
    completionTokens: 17,
  }),
  step(4, 'final', { iteration: 2, content: 'The balance after 8 years is $4295.47.' }),
];

export const HAPPY_RUN: RunDetail = runDetail(HAPPY_STEPS);

/** Every step kind at once, including the error shapes, for the viewer's tests. */
export const MIXED_STEPS: RunStep[] = [
  step(0, 'model_call', { content: '', latencyMs: 1200, promptTokens: 100, completionTokens: 8 }),
  step(1, 'tool_call', {
    toolName: 'calculator',
    toolArgs: null,
    toolArgsRaw: '{"expression": "12345 *',
    parseOk: false,
  }),
  step(2, 'tool_result', {
    toolName: 'calculator',
    toolResult: { code: 'ARGUMENTS_NOT_JSON', error: 'not valid JSON' },
    isError: true,
    latencyMs: 1,
  }),
  step(3, 'final', { iteration: 2, content: 'I could not work that out.' }),
  step(4, 'error', { iteration: 2, content: 'The run was cancelled.', isError: true }),
];
