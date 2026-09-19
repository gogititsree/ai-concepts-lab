import type { ChatRequest, ChatResponse, RunStepKind } from '@lab/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Db } from '../src/db/client.js';
import { AppError } from '../src/lib/errors.js';
import { runAgentLoop, type AgentLoopResult } from '../src/model/agentLoop.js';
import { FakeProvider } from '../src/model/fake.js';
import type { ModelProvider } from '../src/model/provider.js';
import type { FinishRunInput, StepInput, StepRow, StepWriter } from '../src/model/runs.js';
import { defineTool, resolveTools, ToolError, type ToolSpec } from '../src/model/tools/index.js';

/**
 * The agent loop, every branch, against `FakeProvider`.
 *
 * Each test asserts **two** things: the result the loop returns, and the exact sequence
 * of step kinds it persisted. The second matters more. The trace is the product here —
 * it is what the Module 5 lesson reads, what `/runs/:id` renders and what the SRE
 * milestones aggregate — so "the run failed" is only half an assertion; "the run failed
 * and left `model_call, tool_call, tool_result, error` behind" is the whole one.
 *
 * Nothing here touches Postgres. `runAgentLoop` takes a `StepWriter`, so the recorder
 * below is an array, and the branch coverage is complete and instant. The integration
 * suite proves the same steps reach the real table.
 */

// ------------------------------------------------------------- the test double ----

class MemoryRecorder implements StepWriter {
  readonly runId = 'run-under-test';
  readonly steps: StepInput[] = [];
  finished: FinishRunInput | null = null;
  private index = 0;

  async step(input: StepInput): Promise<StepRow> {
    this.steps.push(input);
    const row = {
      id: this.index,
      runId: this.runId,
      stepIndex: this.index,
      kind: input.kind,
      iteration: input.iteration,
      content: input.content ?? null,
      toolName: input.toolName ?? null,
      toolArgs: input.toolArgs ?? null,
      toolArgsRaw: input.toolArgsRaw ?? null,
      parseOk: input.parseOk ?? null,
      toolResult: input.toolResult ?? null,
      isError: input.isError ?? false,
      latencyMs: input.latencyMs ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      raw: input.raw ?? null,
      createdAt: new Date(0),
    } as unknown as StepRow;
    this.index += 1;
    return row;
  }

  async finish(input: FinishRunInput): Promise<void> {
    this.finished = input;
  }

  get kinds(): RunStepKind[] {
    return this.steps.map((step) => step.kind);
  }

  kind(name: RunStepKind): StepInput[] {
    return this.steps.filter((step) => step.kind === name);
  }
}

const CATALOG = resolveTools({
  catalog: ['calculator', 'get_current_time', 'unit_convert', 'flaky_service'],
  mock: [],
});

interface RunOptions {
  scenario: string;
  tools?: ToolSpec[];
  maxIterations?: number;
  provider?: ModelProvider;
  signal?: AbortSignal;
  wallClockMs?: number;
  toolTimeoutMs?: number;
}

async function loop(
  options: RunOptions,
): Promise<{ result: AgentLoopResult; recorder: MemoryRecorder; steps: number }> {
  const recorder = new MemoryRecorder();
  const emitted: number[] = [];
  const result = await runAgentLoop({
    db: {} as Db,
    provider: options.provider ?? new FakeProvider({ model: 'fake-model' }),
    recorder,
    userId: 'user-1',
    model: 'fake-model',
    systemPrompt: 'You are a careful agent.',
    userPrompt: 'Do the thing.',
    tools: options.tools ?? CATALOG,
    maxIterations: options.maxIterations ?? 4,
    options: { scenario: options.scenario },
    now: () => new Date('2026-09-15T14:30:05.000Z'),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
    ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
    onStep: (step) => emitted.push(step.stepIndex),
  });
  // Every persisted step must also have been announced, or the SSE stream is a
  // different trace from the database, which is the worst possible bug for this feature.
  expect(emitted).toEqual(recorder.steps.map((_step, index) => index));
  return { result, recorder, steps: emitted.length };
}

// -------------------------------------------------------------------- the tests ----

describe('the happy path', () => {
  it('answers with no tools at all', async () => {
    const { result, recorder } = await loop({ scenario: 'plain-answer', tools: [] });
    expect(recorder.kinds).toEqual(['model_call', 'final']);
    expect(result.status).toBe('completed');
    expect(result.iterationCount).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.finalOutput).toMatch(/language model/i);
  });

  it('calls a tool once, feeds the result back and then finalises', async () => {
    const { result, recorder } = await loop({ scenario: 'tool-call-once' });
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);
    expect(result.status).toBe('completed');
    expect(result.iterationCount).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.toolParseFailureCount).toBe(0);

    const [call] = recorder.kind('tool_call');
    expect(call).toMatchObject({ toolName: 'calculator', parseOk: true });
    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult?.isError).toBe(false);
    expect(toolResult?.toolResult).toMatchObject({ result: 12345 * 6789 });
  });

  it('handles two tool calls in one assistant turn, in order', async () => {
    const { recorder } = await loop({ scenario: 'tool-call-parallel' });
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);
    expect(recorder.kind('tool_call').map((step) => step.toolName)).toEqual([
      'calculator',
      'unit_convert',
    ]);
  });

  it('accumulates tokens and latency across every model call', async () => {
    const { result } = await loop({ scenario: 'tool-call-once' });
    expect(result.promptTokensTotal).toBeGreaterThan(0);
    expect(result.completionTokensTotal).toBeGreaterThan(0);
    // FakeProvider reports a fixed 42 ms per call; two calls is the assertion that the
    // rollup sums rather than overwrites.
    expect(result.modelLatencyMsTotal).toBe(84);
  });
});

describe('a tool call that cannot be executed', () => {
  it('rejects an unknown tool name and tells the model what does exist', async () => {
    const { result, recorder } = await loop({
      scenario: 'tool-call-unknown-tool',
      maxIterations: 2,
    });
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'tool_call',
      'tool_result',
      'error',
    ]);
    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.toolResult).toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(JSON.stringify(toolResult?.toolResult)).toContain('calculator');
    // The loop did not die: it kept going and stopped on its own terms.
    expect(result.status).toBe('max_iterations');
  });

  it('records arguments that are not JSON as a parse failure, keeping the raw text', async () => {
    const { result, recorder } = await loop({
      scenario: 'tool-call-malformed-args',
      maxIterations: 1,
    });
    const [call] = recorder.kind('tool_call');
    expect(call).toMatchObject({ parseOk: false, toolArgsRaw: '{"expression": "12345 *' });
    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult?.toolResult).toMatchObject({ code: 'ARGUMENTS_NOT_JSON' });
    expect(result.toolParseFailureCount).toBe(1);
  });

  it('rejects arguments that parse but fail the schema, and hands back the reason', async () => {
    const { result, recorder } = await loop({ scenario: 'tool-call-invalid-args' });
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);
    const [call] = recorder.kind('tool_call');
    // Distinct from the case above: the JSON was fine, the *shape* was not.
    expect(call?.parseOk).toBe(true);
    expect(result.toolParseFailureCount).toBe(0);

    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult?.isError).toBe(true);
    const payload = toolResult?.toolResult as { code: string; details: string[] };
    expect(payload.code).toBe('INVALID_ARGUMENTS');
    expect(payload.details.join(' ')).toMatch(/expression/);
  });
});

describe('a tool that misbehaves', () => {
  it('turns a thrown ToolError into an error observation and carries on', async () => {
    const { result, recorder } = await loop({ scenario: 'tool-call-throws' });
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'final',
    ]);
    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult).toMatchObject({ isError: true, toolName: 'flaky_service' });
    expect(toolResult?.toolResult).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    // The run still completes: a broken tool is an observation, not an outage.
    expect(result.status).toBe('completed');
  });

  it('times a slow tool out at the per-tool budget without failing the run', async () => {
    const slow = defineTool({
      name: 'calculator',
      description: 'A stand-in that never returns, to exercise the per-tool timeout.',
      schema: z.object({ expression: z.string().describe('ignored') }),
      execute: () => new Promise(() => undefined),
    });
    const { result, recorder } = await loop({
      scenario: 'tool-call-once',
      tools: [slow],
      toolTimeoutMs: 20,
    });
    const [toolResult] = recorder.kind('tool_result');
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.toolResult).toMatchObject({ code: 'TOOL_TIMEOUT' });
    expect(result.status).toBe('completed');
  });

  it('survives a tool that throws something that is not a ToolError', async () => {
    const broken = defineTool({
      name: 'calculator',
      description: 'A stand-in that throws a plain Error, to prove nothing escapes.',
      schema: z.object({ expression: z.string().describe('ignored') }),
      execute: () => {
        throw new Error('undefined is not a function');
      },
    });
    const warn = vi.fn();
    const recorder = new MemoryRecorder();
    const result = await runAgentLoop({
      db: {} as Db,
      provider: new FakeProvider(),
      recorder,
      userId: 'user-1',
      model: 'fake-model',
      systemPrompt: '',
      userPrompt: 'go',
      tools: [broken],
      maxIterations: 3,
      options: { scenario: 'tool-call-once' },
      logger: { warn },
    });
    expect(result.status).toBe('completed');
    expect(recorder.kind('tool_result')[0]?.toolResult).toMatchObject({ code: 'TOOL_ERROR' });
    // A bug in a tool is still a bug, even though the run survived it.
    expect(warn).toHaveBeenCalled();
  });

  it('distinguishes a ToolError from an internal failure by its code', async () => {
    expect(new ToolError('nope', 'RATE_LIMITED').code).toBe('RATE_LIMITED');
  });
});

describe('the provider failing', () => {
  it('ends the run as failed with the provider error code and an error step', async () => {
    const { result, recorder } = await loop({ scenario: 'error-timeout' });
    expect(recorder.kinds).toEqual(['error']);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'MODEL_TIMEOUT' });
    expect(recorder.finished).toMatchObject({ status: 'failed', errorCode: 'MODEL_TIMEOUT' });
  });

  it('records a mid-run provider failure after the steps that already succeeded', async () => {
    // Succeeds once, then the provider falls over: the partial trace is the point.
    let calls = 0;
    const flaky: ModelProvider = {
      name: 'fake',
      async chat(request: ChatRequest): Promise<ChatResponse> {
        calls += 1;
        if (calls === 1) return new FakeProvider().chat(request);
        throw new AppError(503, 'MODEL_UNAVAILABLE', 'Ollama went away');
      },
      embed: async () => [],
      health: async () => ({ ok: true, models: [] }),
    };
    const { result, recorder } = await loop({ scenario: 'tool-call-once', provider: flaky });
    expect(recorder.kinds).toEqual(['model_call', 'tool_call', 'tool_result', 'error']);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' });
    // The tool call that did happen is still counted, so the SLI numbers are honest.
    expect(result.toolCallCount).toBe(1);
  });
});

describe('the stopping conditions', () => {
  it('stops a model that never stops calling tools, at maxIterations', async () => {
    const { result, recorder } = await loop({
      scenario: 'tool-call-never-stops',
      maxIterations: 3,
    });
    expect(result.status).toBe('max_iterations');
    expect(result.iterationCount).toBe(3);
    expect(result.toolCallCount).toBe(3);
    expect(recorder.kinds).toEqual([
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'tool_call',
      'tool_result',
      'model_call',
      'tool_call',
      'tool_result',
      'error',
    ]);
    expect(recorder.finished).toMatchObject({ errorCode: 'MAX_ITERATIONS' });
  });

  it('clamps maxIterations to the hard cap of 15', async () => {
    const { result } = await loop({ scenario: 'tool-call-never-stops', maxIterations: 500 });
    expect(result.iterationCount).toBe(15);
  });

  it('cancels mid-flight when the signal aborts, and says cancelled rather than failed', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { result, recorder } = await loop({
      // `slow:400` keeps the provider inside one call while the abort lands.
      scenario: 'slow:400',
      tools: [],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(result.errorCode).toBe('RUN_CANCELLED');
    expect(recorder.kinds).toEqual(['error']);
    expect(recorder.steps[0]?.isError).toBe(true);
  });

  it('does nothing at all when the signal is already aborted', async () => {
    const { result, recorder } = await loop({
      scenario: 'plain-answer',
      tools: [],
      signal: AbortSignal.abort(),
    });
    expect(result.status).toBe('cancelled');
    expect(recorder.kinds).toEqual(['error']);
    expect(result.iterationCount).toBe(0);
  });

  it('fails with RUN_TIMEOUT when the wall clock runs out, distinct from a cancel', async () => {
    const { result, recorder } = await loop({
      scenario: 'slow:400',
      tools: [],
      wallClockMs: 20,
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'RUN_TIMEOUT' });
    expect(recorder.kinds).toEqual(['error']);
  });
});

describe('what the trace preserves', () => {
  it('keeps provider metadata on every model_call, for the SRE page', async () => {
    const { recorder } = await loop({ scenario: 'tool-call-once' });
    for (const step of recorder.kind('model_call')) {
      expect(step.raw).toMatchObject({ provider: 'fake', scenario: 'tool-call-once' });
    }
  });

  it('measures tool execution separately from inference', async () => {
    const { recorder } = await loop({ scenario: 'tool-call-once' });
    expect(recorder.kind('model_call')[0]?.latencyMs).toBe(42);
    expect(recorder.kind('tool_result')[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('numbers every step by iteration, so a trace can be grouped by loop pass', async () => {
    const { recorder } = await loop({ scenario: 'tool-call-once' });
    expect(recorder.steps.map((step) => step.iteration)).toEqual([1, 1, 1, 2, 2]);
  });
});
