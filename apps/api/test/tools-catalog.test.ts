import { TOOL_CATALOG_NAMES, type MockToolDefinition } from '@lab/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Db } from '../src/db/client.js';
import {
  catalogDefinitions,
  createMockTool,
  resolveTools,
  TOOL_CATALOG,
} from '../src/model/tools/index.js';
import { ToolError, type ToolContext } from '../src/model/tools/types.js';
import { zodToJsonSchema } from '../src/model/tools/zodJsonSchema.js';

/**
 * The tool catalog: its schemas, its argument validation and its execution.
 *
 * The recurring assertion is that **every tool validates before it runs**. A model that
 * was handed a JSON Schema still sends the wrong shape often enough that this is the
 * load-bearing line in the loop, not a formality, and a tool added later that forgets it
 * should fail here rather than in a trace six weeks from now.
 */

// A fixed instant, so `get_current_time` is testable at all. 2026-09-15 is a Tuesday.
const FIXED = new Date('2026-09-15T14:30:05.000Z');
const ctx: ToolContext = { db: {} as Db, now: () => FIXED, userId: 'user-1' };

const run = async (name: string, args: unknown): Promise<unknown> => {
  const tool = TOOL_CATALOG[name as keyof typeof TOOL_CATALOG];
  const parsed = tool.parse(args);
  if (!parsed.ok) throw new Error(`invalid args: ${parsed.errors.join('; ')}`);
  return tool.execute(parsed.value, ctx);
};

describe('the catalog as a whole', () => {
  it('has an entry for every name in the shared allow-list, and no others', () => {
    expect(Object.keys(TOOL_CATALOG).sort()).toEqual([...TOOL_CATALOG_NAMES].sort());
  });

  it('gives every tool an object schema with additionalProperties: false', () => {
    for (const tool of catalogDefinitions()) {
      expect(tool.parameters.type, tool.name).toBe('object');
      expect(tool.parameters.additionalProperties, tool.name).toBe(false);
      expect(tool.parameters.properties, tool.name).toBeTypeOf('object');
    }
  });

  it('writes descriptions that say when to call the tool, with an example', () => {
    // The description is prompt text (Module 5, lesson 2). A one-word description is the
    // most common reason a small model never calls a tool, so it is worth a test.
    for (const tool of catalogDefinitions()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(60);
      expect(tool.description, tool.name).toMatch(/example|use this|call it|you must/i);
    }
  });

  it('describes every parameter, because the description is what the model reads', () => {
    for (const tool of catalogDefinitions()) {
      const properties = tool.parameters.properties as Record<string, { description?: string }>;
      for (const [key, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe('argument validation', () => {
  it('rejects a missing required argument with a path-prefixed message', () => {
    const result = TOOL_CATALOG.calculator.parse({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^expression: /);
  });

  it('rejects the wrong type', () => {
    expect(TOOL_CATALOG.calculator.parse({ expression: 42 }).ok).toBe(false);
    expect(TOOL_CATALOG.unit_convert.parse({ value: '3', from: 'm', to: 'km' }).ok).toBe(false);
  });

  it('rejects an unknown enum member rather than guessing', () => {
    expect(TOOL_CATALOG.get_current_time.parse({ timezone: 'EST' }).ok).toBe(false);
    expect(TOOL_CATALOG.unit_convert.parse({ value: 1, from: 'm', to: 'parsec' }).ok).toBe(false);
  });

  it('applies defaults so an omitted optional argument is still valid', () => {
    const result = TOOL_CATALOG.get_current_time.parse({});
    expect(result).toEqual({ ok: true, value: { timezone: 'UTC' } });
  });

  it('rejects extra properties, because the schema says additionalProperties: false', () => {
    expect(TOOL_CATALOG.calculator.parse({ expression: '1+1', extra: true }).ok).toBe(false);
  });
});

describe('calculator', () => {
  it('returns the expression alongside the result', async () => {
    await expect(run('calculator', { expression: '2500 * 1.07^8' })).resolves.toMatchObject({
      expression: '2500 * 1.07^8',
    });
  });

  it('turns a parse failure into a ToolError, not a crash', async () => {
    await expect(run('calculator', { expression: 'process.exit()' })).rejects.toBeInstanceOf(
      ToolError,
    );
  });
});

describe('get_current_time', () => {
  it('formats the injected instant in the requested zone', async () => {
    await expect(run('get_current_time', { timezone: 'UTC' })).resolves.toEqual({
      iso: '2026-09-15T14:30:05.000Z',
      timezone: 'UTC',
      weekday: 'Tuesday',
      date: '2026-09-15',
      time: '14:30:05',
      unixSeconds: Math.floor(FIXED.getTime() / 1000),
    });
  });

  it('really converts the zone rather than relabelling UTC', async () => {
    const tokyo = (await run('get_current_time', { timezone: 'Asia/Tokyo' })) as {
      date: string;
      time: string;
    };
    expect(tokyo.date).toBe('2026-09-15');
    expect(tokyo.time).toBe('23:30:05');
  });
});

describe('unit_convert', () => {
  it.each([
    [1, 'km', 'm', 1000],
    [26.2, 'mi', 'km', 42.1648],
    [1, 'lb', 'kg', 0.4535924],
    [2, 'h', 'min', 120],
  ])('converts %d %s to %s', async (value, from, to, expected) => {
    const result = (await run('unit_convert', { value, from, to })) as { result: number };
    expect(result.result).toBeCloseTo(expected, 3);
  });

  it('handles temperature as affine, not as a factor', async () => {
    // The case a multiplier table gets wrong: 0 °C is 32 °F, not 0 °F.
    const f = (await run('unit_convert', { value: 0, from: 'c', to: 'f' })) as { result: number };
    expect(f.result).toBe(32);
    const k = (await run('unit_convert', { value: 100, from: 'c', to: 'k' })) as { result: number };
    expect(k.result).toBeCloseTo(373.15, 6);
  });

  it('refuses to convert across dimensions', async () => {
    await expect(run('unit_convert', { value: 1, from: 'kg', to: 'm' })).rejects.toThrow(
      /cannot convert mass .* to length/,
    );
  });

  it('rounds away floating-point noise', async () => {
    const result = (await run('unit_convert', { value: 3, from: 'ft', to: 'm' })) as {
      result: number;
    };
    expect(String(result.result)).not.toMatch(/0000000/);
  });
});

describe('fake_weather', () => {
  it('is deterministic and says it is fake', async () => {
    const first = await run('fake_weather', { location: 'Lisbon', day: 'today' });
    const second = await run('fake_weather', { location: 'Lisbon', day: 'today' });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toMatch(/fake/i);
  });

  it('differs by location and by day', async () => {
    const lisbon = await run('fake_weather', { location: 'Lisbon', day: 'today' });
    const oslo = await run('fake_weather', { location: 'Oslo', day: 'today' });
    const tomorrow = await run('fake_weather', { location: 'Lisbon', day: 'tomorrow' });
    expect(lisbon).not.toEqual(oslo);
    expect(lisbon).not.toEqual(tomorrow);
  });
});

describe('flaky_service', () => {
  it('always throws a ToolError with an upstream code', async () => {
    await expect(run('flaky_service', {})).rejects.toMatchObject({
      name: 'ToolError',
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});

describe('mock tools', () => {
  const definition: MockToolDefinition = {
    name: 'get_order_status',
    description: 'Look up the status of a customer order by its id.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
      additionalProperties: false,
    },
    response: { status: 'unknown' },
    responses: [{ when: { order_id: 'A-1001' }, response: { status: 'shipped', eta: '2 days' } }],
  };
  const tool = createMockTool(definition);

  it('is not a catalog tool, which is what the mock-tool task checks for', () => {
    expect(tool.catalog).toBe(false);
    expect(TOOL_CATALOG.calculator.catalog).toBe(true);
  });

  it('validates arguments against the learner s own JSON Schema', () => {
    expect(tool.parse({ order_id: 'A-1001' }).ok).toBe(true);
    const missing = tool.parse({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]).toMatch(/required property "order_id"/);
    expect(tool.parse({ order_id: 7 }).ok).toBe(false);
  });

  it('returns the table entry when one matches, and the default otherwise', async () => {
    await expect(tool.execute({ order_id: 'A-1001' }, ctx)).resolves.toEqual({
      status: 'shipped',
      eta: '2 days',
    });
    await expect(tool.execute({ order_id: 'B-2' }, ctx)).resolves.toEqual({ status: 'unknown' });
  });

  it('never returns undefined, which would serialise to invalid JSON', async () => {
    const empty = createMockTool({
      ...definition,
      response: undefined,
      responses: undefined as never,
    });
    await expect(empty.execute({ order_id: 'x' }, ctx)).resolves.toBeNull();
  });
});

describe('resolveTools', () => {
  it('maps catalog names to implementations and mock definitions to lookups', () => {
    const tools = resolveTools({
      catalog: ['calculator', 'get_current_time'],
      mock: [
        {
          name: 'get_order_status',
          description: 'x',
          parameters: { type: 'object', properties: {} },
          response: { ok: true },
        },
      ],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      'calculator',
      'get_current_time',
      'get_order_status',
    ]);
    expect(tools.map((tool) => tool.catalog)).toEqual([true, true, false]);
  });
});

describe('zodToJsonSchema', () => {
  it('carries bounds, enums, descriptions and requiredness across', () => {
    const schema = zodToJsonSchema(
      z.object({
        name: z.string().min(2).max(8).describe('a name'),
        count: z.number().int().min(0).max(10),
        mode: z.enum(['fast', 'slow']).default('fast'),
        tags: z.array(z.string()).optional(),
        flag: z.boolean(),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'count', 'flag'],
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 8, description: 'a name' },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' } },
        flag: { type: 'boolean' },
      },
    });
  });

  it('refuses a type the model could not reliably fill in', () => {
    expect(() => zodToJsonSchema(z.object({ weird: z.union([z.string(), z.number()]) }))).toThrow(
      /unsupported Zod type/,
    );
  });
});
