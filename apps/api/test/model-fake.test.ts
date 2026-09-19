import type { ChatRequest } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import {
  FAKE_SCENARIOS,
  FakeProvider,
  selectScenario,
  type FakeScenario,
} from '../src/model/fake.js';
import { NoneProvider, createProvider } from '../src/model/provider.js';
import { loadConfig } from '../src/config.js';

/**
 * The fake is the provider CI runs, so its own guarantees have to be tested: that every
 * scenario is reachable, that each is deterministic, and that the ones representing
 * failures actually fail. A silently-broken test double is worse than no double at all —
 * it makes a whole suite green for the wrong reason.
 */

const provider = new FakeProvider({ model: 'gemma4:latest' });

const req = (scenario: string, overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'What is a system prompt?' }],
  options: { scenario },
  ...overrides,
});

const DATES_SCHEMA = {
  type: 'object',
  properties: {
    dates: { type: 'array', items: { type: 'string' }, minItems: 3 },
  },
  required: ['dates'],
};

describe('scenario selection', () => {
  it('prefers the explicit option', () => {
    expect(selectScenario(req('echo')).scenario).toBe('echo');
  });

  it('falls back to a keyword in the system prompt', () => {
    const tagged: ChatRequest = {
      messages: [
        { role: 'system', content: 'You are helpful. scenario: tool-call-once' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(selectScenario(tagged).scenario).toBe('tool-call-once');

    const bare: ChatRequest = {
      messages: [
        { role: 'system', content: 'run the tool-call-never-stops case please' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(selectScenario(bare).scenario).toBe('tool-call-never-stops');
  });

  it('defaults to plain-answer', () => {
    expect(selectScenario({ messages: [{ role: 'user', content: 'hi' }] }).scenario).toBe(
      'plain-answer',
    );
  });

  it('parses the delay suffix on slow', () => {
    expect(selectScenario(req('slow:25'))).toEqual({ scenario: 'slow', delayMs: 25 });
    expect(selectScenario(req('slow')).delayMs).toBeGreaterThan(0);
  });

  it('rejects an unknown scenario loudly', () => {
    expect(() => selectScenario(req('not-a-scenario'))).toThrowError(/Unknown fake scenario/);
  });
});

describe('every scenario is deterministic', () => {
  // `slow` is given a tiny delay so the suite does not actually wait 1.5 s, and the two
  // error scenarios are covered separately because they throw.
  const runnable = FAKE_SCENARIOS.filter(
    (scenario) => scenario !== 'error-timeout' && scenario !== 'error-unavailable',
  );

  it.each(runnable)('%s returns byte-identical responses', async (scenario: FakeScenario) => {
    const request = req(scenario === 'slow' ? 'slow:1' : scenario, { format: DATES_SCHEMA });
    const [first, second] = await Promise.all([provider.chat(request), provider.chat(request)]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.latencyMs).toBe(second.latencyMs);
    expect(first.usage).toEqual(second.usage);
  });
});

describe('the scenarios themselves', () => {
  it('echo returns the last user message verbatim', async () => {
    const response = await provider.chat(req('echo'));
    expect(response.message.content).toBe('What is a system prompt?');
  });

  it('plain-answer returns prose with no tool calls and plausible usage', async () => {
    const response = await provider.chat(req('plain-answer'));
    expect(response.message.toolCalls).toBeUndefined();
    expect(response.message.content.length).toBeGreaterThan(20);
    expect(response.usage.promptTokens).toBeGreaterThan(0);
    expect(response.usage.completionTokens).toBeGreaterThan(0);
  });

  it('structured-valid produces JSON that satisfies the requested schema', async () => {
    const response = await provider.chat(req('structured-valid', { format: DATES_SCHEMA }));
    const value = JSON.parse(response.message.content) as { dates: string[] };
    expect(value.dates).toHaveLength(3);
    expect(value.dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('structured-invalid returns prose despite the format, like the real failure', async () => {
    const response = await provider.chat(req('structured-invalid', { format: DATES_SCHEMA }));
    expect(() => JSON.parse(response.message.content)).toThrow();
    expect(response.providerMeta?.done_reason).toBe('stop');
  });

  it('tool-call-once calls the calculator, then answers once a tool result arrives', async () => {
    const first = await provider.chat(req('tool-call-once'));
    expect(first.message.toolCalls?.[0]).toMatchObject({
      name: 'calculator',
      args: { expression: '12345 * 6789' },
      parseOk: true,
    });

    const second = await provider.chat(
      req('tool-call-once', {
        messages: [
          { role: 'user', content: 'multiply' },
          { role: 'assistant', content: '', toolCalls: first.message.toolCalls },
          { role: 'tool', content: '{"result":83810205}', toolName: 'calculator' },
        ],
      }),
    );
    expect(second.message.toolCalls).toBeUndefined();
    expect(second.message.content).toContain('83,810,205');
  });

  it('tool-call-malformed-args reports parseOk:false and keeps the raw text', async () => {
    const response = await provider.chat(req('tool-call-malformed-args'));
    const [call] = response.message.toolCalls ?? [];
    expect(call?.parseOk).toBe(false);
    expect(call?.args).toBeUndefined();
    expect(call?.rawArgs).toBe('{"expression": "12345 *');
  });

  it('tool-call-unknown-tool names a tool nobody registered', async () => {
    const response = await provider.chat(req('tool-call-unknown-tool'));
    expect(response.message.toolCalls?.[0]?.name).toBe('definitely_not_a_tool');
  });

  it('tool-call-never-stops always calls a tool, whatever the transcript', async () => {
    for (const length of [1, 4, 9]) {
      const messages = Array.from({ length }, (_unused, index) => ({
        role: 'user' as const,
        content: `turn ${index}`,
      }));
      const response = await provider.chat(req('tool-call-never-stops', { messages }));
      expect(response.message.toolCalls).toHaveLength(1);
    }
  });

  it('slow waits, and is abortable', async () => {
    const started = Date.now();
    await provider.chat(req('slow:30'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);

    const controller = new AbortController();
    const pending = provider.chat(req('slow:5000'), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });

  it('the error scenarios throw the documented codes', async () => {
    await expect(provider.chat(req('error-timeout'))).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
      statusCode: 504,
    });
    await expect(provider.chat(req('error-unavailable'))).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('embeds deterministically, with the same 768-dim shape as nomic-embed-text', async () => {
    const [a, b] = await provider.embed(['king', 'king']);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b);
    const [different] = await provider.embed(['apple']);
    expect(different).not.toEqual(a);
  });

  it('reports itself healthy', async () => {
    await expect(provider.health()).resolves.toMatchObject({ ok: true });
  });
});

describe('the none provider and the factory', () => {
  const configFor = (provider: string) =>
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab',
      MODEL_PROVIDER: provider,
    });

  it('selects an implementation by name', () => {
    expect(createProvider(configFor('fake')).name).toBe('fake');
    expect(createProvider(configFor('none')).name).toBe('none');
    expect(createProvider(configFor('ollama')).name).toBe('ollama');
  });

  it('defaults to ollama in development and none everywhere else', () => {
    const base = { DATABASE_URL: 'postgres://lab:lab@localhost:5432/lab' };
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).MODEL_PROVIDER).toBe('ollama');
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).MODEL_PROVIDER).toBe('none');
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        SESSION_SECRET: 'x'.repeat(40),
        MFA_ENCRYPTION_KEY: 'a'.repeat(64),
      }).MODEL_PROVIDER,
    ).toBe('none');
  });

  it('fails every call with MODEL_UNAVAILABLE and still reports health', async () => {
    const none = new NoneProvider();
    expect(() => none.chat()).toThrowError(/run the app locally/i);
    expect(() => none.embed()).toThrow();
    await expect(none.health()).resolves.toMatchObject({ ok: false, models: [] });
  });
});
