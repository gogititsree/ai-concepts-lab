import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { ChatRequest } from '@lab/shared';
import { describe, expect, it, vi } from 'vitest';

import { isAppError } from '../src/lib/errors.js';
import {
  assertThinkFormatExclusive,
  buildChatBody,
  KEEP_ALIVE,
  mapChatResponse,
  mapRequestError,
  OllamaProvider,
  recoverToolCallsFromContent,
  toOllamaMessages,
  toOllamaOptions,
} from '../src/model/ollama.js';

/**
 * The Ollama adapter, replayed against the **real recorded responses** from the M0 spike
 * (`test/fixtures/ollama/*.json`). Not hand-written doubles: those fixtures are literally
 * what `gemma4:latest` sent back, `thinking` field, `prompt_eval_cached_count` and all,
 * which is the only way a mapping test can catch "the provider added a field" rather than
 * "the mapping matches the mock I wrote from the same misunderstanding".
 *
 * No test in this file opens a socket. `fetchImpl` is injected.
 */

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/ollama/${name}.json`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;

const req = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const CALCULATOR = {
  name: 'calculator',
  description: 'Evaluate a basic arithmetic expression.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
};

const DATES_SCHEMA = {
  type: 'object',
  properties: { dates: { type: 'array', items: { type: 'string' } } },
  required: ['dates'],
};

describe('request body', () => {
  it('always sends think:false, stream:false and keep_alive', () => {
    const body = buildChatBody(req(), 'gemma4:latest');
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.keep_alive).toBe(KEEP_ALIVE);
    expect(body.model).toBe('gemma4:latest');
  });

  it('sends think:true only when a caller explicitly opts in', () => {
    expect(buildChatBody(req({ options: { think: true } }), 'm').think).toBe(true);
    expect(buildChatBody(req({ options: { think: false } }), 'm').think).toBe(false);
    expect(buildChatBody(req({ options: { temperature: 0 } }), 'm').think).toBe(false);
  });

  // Decision 16: this combination silently produces prose instead of JSON, so it is
  // refused rather than merely discouraged.
  it('never sends think:true together with format', () => {
    expect(() =>
      buildChatBody(req({ format: DATES_SCHEMA, options: { think: true } }), 'm'),
    ).toThrowError(/mutually exclusive/);
    expect(() =>
      assertThinkFormatExclusive(req({ format: 'json', options: { think: true } })),
    ).toThrow();
    // With format alone, think is present and false.
    const body = buildChatBody(req({ format: DATES_SCHEMA }), 'm');
    expect(body.think).toBe(false);
    expect(body.format).toEqual(DATES_SCHEMA);
  });

  it('wraps tools in the {type:function, function:{...}} envelope', () => {
    const body = buildChatBody(req({ tools: [CALCULATOR] }), 'm');
    expect(body.tools).toEqual([{ type: 'function', function: CALCULATOR }]);
  });

  it('omits tools and format when they were not asked for', () => {
    const body = buildChatBody(req(), 'm');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('format');
    expect(body).not.toHaveProperty('options');
  });

  it('maps sampling options to Ollama spellings', () => {
    expect(
      toOllamaOptions(req({ options: { temperature: 0.2, topP: 0.9, maxTokens: 64, seed: 7 } })),
    ).toEqual({ temperature: 0.2, top_p: 0.9, num_predict: 64, seed: 7 });
    expect(toOllamaOptions(req())).toBeUndefined();
    // temperature 0 is a real value, not an absent one.
    expect(toOllamaOptions(req({ options: { temperature: 0 } }))).toEqual({ temperature: 0 });
  });

  it('round-trips an assistant tool call and a tool result', () => {
    const wire = toOllamaMessages([
      { role: 'user', content: 'multiply' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'calculator', args: { expression: '2*3' }, parseOk: true },
        ],
      },
      { role: 'tool', content: '{"result":6}', toolName: 'calculator' },
    ]);
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          function: { index: 0, name: 'calculator', arguments: { expression: '2*3' } },
        },
      ],
    });
    expect(wire[2]).toEqual({ role: 'tool', content: '{"result":6}', tool_name: 'calculator' });
  });
});

describe('response mapping against recorded fixtures', () => {
  it('maps the plain chat fixture', () => {
    const mapped = mapChatResponse(fixture('chat-plain'), 1234, req());
    expect(mapped.message).toEqual({ role: 'assistant', content: 'pong' });
    expect(mapped.usage).toEqual({ promptTokens: 23, completionTokens: 2 });
    expect(mapped.latencyMs).toBe(1234);
    // No thinking on this one; the passthrough still carries the timings.
    expect(mapped.providerMeta?.thinking).toBeUndefined();
    expect(mapped.providerMeta?.total_duration).toBe(21349472800);
    expect(mapped.providerMeta?.load_duration).toBe(19301606400);
    expect(mapped.providerMeta?.prompt_eval_cached_count).toBe(0);
  });

  it('maps the tool-call fixture, with arguments as a parsed object', () => {
    const mapped = mapChatResponse(fixture('tool-call'), 40850, req({ tools: [CALCULATOR] }));
    expect(mapped.message.toolCalls).toHaveLength(1);
    const [call] = mapped.message.toolCalls ?? [];
    expect(call).toMatchObject({
      id: 'call_s6jkagzm',
      name: 'calculator',
      args: { expression: '12345 * 6789' },
      parseOk: true,
    });
    // Nothing was parsed by us, so there is no raw text to keep.
    expect(call?.rawArgs).toBeUndefined();
    expect(call?.recovered).toBeUndefined();
    expect(mapped.usage).toEqual({ promptTokens: 111, completionTokens: 228 });
  });

  it('routes `thinking` and `prompt_eval_cached_count` to providerMeta without crashing', () => {
    const mapped = mapChatResponse(fixture('tool-result-final'), 100, req());
    expect(mapped.message.content).toBe('12345 multiplied by 6789 is 83,810,205.');
    expect(String(mapped.providerMeta?.thinking)).toContain('calculator');
    expect(mapped.providerMeta?.prompt_eval_cached_count).toBe(106);
    // `thinking` must never leak into the neutral message shape.
    expect(mapped.message).not.toHaveProperty('thinking');
  });

  it('maps the structured-output fixture to parseable content', () => {
    const mapped = mapChatResponse(
      fixture('structured-output'),
      7140,
      req({ format: DATES_SCHEMA }),
    );
    expect(JSON.parse(mapped.message.content)).toEqual({
      dates: ['March 3, 1998', 'July 14, 2005', 'November 1, 2019'],
    });
    expect(mapped.usage).toEqual({ promptTokens: 67, completionTokens: 240 });
    expect(mapped.message.toolCalls).toBeUndefined();
  });

  it('defaults missing token counts to zero rather than NaN', () => {
    const mapped = mapChatResponse({ message: { content: 'hi' } }, 5, req());
    expect(mapped.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('accepts arguments as a JSON string as well as an object', () => {
    const raw = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }],
      },
    };
    const [call] = mapChatResponse(raw, 1, req({ tools: [CALCULATOR] })).message.toolCalls ?? [];
    expect(call).toMatchObject({
      id: 'call_0', // minted: the provider supplied none
      args: { expression: '2+2' },
      rawArgs: '{"expression":"2+2"}',
      parseOk: true,
    });
  });

  it('marks unparseable string arguments parseOk:false and keeps the raw text', () => {
    const raw = {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'calculator', arguments: '{"expression": "2+' } }],
      },
    };
    const [call] = mapChatResponse(raw, 1, req({ tools: [CALCULATOR] })).message.toolCalls ?? [];
    expect(call?.parseOk).toBe(false);
    expect(call?.rawArgs).toBe('{"expression": "2+');
    expect(call?.args).toBeUndefined();
  });
});

describe('fenced-JSON tool-call recovery', () => {
  const fenced = [
    'I will use the calculator.',
    '```json',
    '{ "name": "calculator", "arguments": { "expression": "6 * 7" } }',
    '```',
  ].join('\n');

  it('recovers a call from a fenced block and flags it', () => {
    const mapped = mapChatResponse(
      { message: { role: 'assistant', content: fenced } },
      1,
      req({ tools: [CALCULATOR] }),
    );
    const [call] = mapped.message.toolCalls ?? [];
    expect(call).toMatchObject({
      name: 'calculator',
      args: { expression: '6 * 7' },
      parseOk: false,
      recovered: true,
    });
    expect(call?.rawArgs).toContain('calculator');
  });

  it('does not invent tool calls when the request offered no tools', () => {
    const mapped = mapChatResponse({ message: { role: 'assistant', content: fenced } }, 1, req());
    expect(mapped.message.toolCalls).toBeUndefined();
  });

  it('never overrides a native tool_calls array', () => {
    const raw = {
      message: {
        role: 'assistant',
        content: fenced,
        tool_calls: [{ id: 'native', function: { name: 'calculator', arguments: { a: 1 } } }],
      },
    };
    const [call] = mapChatResponse(raw, 1, req({ tools: [CALCULATOR] })).message.toolCalls ?? [];
    expect(call?.id).toBe('native');
    expect(call?.parseOk).toBe(true);
  });

  it('ignores fenced blocks that are not shaped like a tool call', () => {
    expect(recoverToolCallsFromContent('```json\n{"dates":["2024-01-01"]}\n```')).toEqual([]);
    expect(recoverToolCallsFromContent('no json here at all')).toEqual([]);
    expect(recoverToolCallsFromContent('```json\n{ not json\n```')).toEqual([]);
  });

  it('accepts bare JSON with no fence, and the tool_name spelling', () => {
    const calls = recoverToolCallsFromContent('{"tool_name":"calculator","arguments":{"x":1}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'calculator', recovered: true, parseOk: false });
  });
});

describe('error mapping', () => {
  it('maps our own deadline to MODEL_TIMEOUT', () => {
    const error = mapRequestError(new Error('aborted'), true, false);
    expect(error.statusCode).toBe(504);
    expect(error.code).toBe('MODEL_TIMEOUT');
  });

  it('maps a caller abort to REQUEST_ABORTED, not to a model failure', () => {
    expect(mapRequestError(new Error('aborted'), false, true).code).toBe('REQUEST_ABORTED');
  });

  it('maps a refused connection to MODEL_UNAVAILABLE and mentions Ollama', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const error = mapRequestError(refused, false, false);
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('MODEL_UNAVAILABLE');
    expect(error.message).toMatch(/ollama/i);
  });

  it('never puts the base URL in an error the client can see', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://secret-internal-host:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 1000,
      fetchImpl: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
    });
    await expect(provider.chat(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    await provider.chat(req()).catch((error: unknown) => {
      expect(isAppError(error) && error.message).not.toContain('secret-internal-host');
    });
    const health = await provider.health();
    expect(JSON.stringify(health)).not.toContain('secret-internal-host');
  });

  it('turns a 404 into "pull the model" rather than "HTTP 404"', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 404 })),
    });
    await expect(provider.chat(req())).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      message: expect.stringContaining('ollama pull gemma4:latest'),
    });
  });
});

describe('health', () => {
  const tagsResponse = () =>
    new Response(JSON.stringify(fixture('tags')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reports ok and lists models when the chat model is pulled', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434/', // trailing slash on purpose
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValue(tagsResponse()),
    });
    const health = await provider.health();
    expect(health.ok).toBe(true);
    expect(health.models).toContain('gemma4:latest');
    expect(health.models).toContain('nomic-embed-text:latest');
  });

  it('reports not-ok when the configured chat model is missing', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'llama9:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockResolvedValue(tagsResponse()),
    });
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('llama9:latest');
  });

  it('never throws when the server is unreachable', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 1000,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await expect(provider.health()).resolves.toEqual({
      ok: false,
      models: [],
      detail: 'Could not reach the local model server',
    });
  });
});

describe('the whole call, with fetch stubbed', () => {
  it('posts to /api/chat and maps the reply', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture('chat-plain')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 5000,
      fetchImpl,
    });

    const response = await provider.chat(req());
    expect(response.message.content).toBe('pong');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(JSON.parse(String(init.body))).toMatchObject({ think: false, stream: false });
  });

  it('embeds via /api/embed (singular) and returns one vector per input', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fixture('embed')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 5000,
      fetchImpl,
    });
    const vectors = await provider.embed(['king', 'queen', 'apple']);
    expect(vectors).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'nomic-embed-text',
      input: ['king', 'queen', 'apple'],
    });
  });

  it('honours a caller AbortSignal', async () => {
    const controller = new AbortController();
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      chatModel: 'gemma4:latest',
      embedModel: 'nomic-embed-text',
      timeoutMs: 5000,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    const pending = provider.chat(req(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });
});
