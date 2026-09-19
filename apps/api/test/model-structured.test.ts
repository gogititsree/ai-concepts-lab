import type { ChatRequest } from '@lab/shared';
import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../src/model/fake.js';
import { sampleFromJsonSchema, validateAgainstSchema } from '../src/model/jsonSchema.js';
import {
  buildRetryMessages,
  runStructuredChat,
  validateStructuredOutput,
} from '../src/model/structured.js';

/**
 * Structured output: the JSON Schema validator, the pure validate/retry helpers, and the
 * one orchestration function — driven by `FakeProvider` so the retry path is exercised
 * end to end without a model.
 */

const DATES_SCHEMA = {
  type: 'object',
  properties: {
    dates: {
      type: 'array',
      items: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ['dates'],
  additionalProperties: false,
};

describe('the JSON Schema validator', () => {
  it('accepts a conforming value', () => {
    const result = validateAgainstSchema(
      { dates: ['2024-03-15', '2024-06-01', '2024-11-20'] },
      DATES_SCHEMA,
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('names the missing property', () => {
    const { valid, errors } = validateAgainstSchema({}, DATES_SCHEMA);
    expect(valid).toBe(false);
    expect(errors[0]).toContain('"dates"');
    expect(errors[0]).toContain('required');
  });

  it('reports a type mismatch with the path and both types', () => {
    const { errors } = validateAgainstSchema({ dates: 'a, b, c' }, DATES_SCHEMA);
    expect(errors[0]).toBe('"dates" must be of type array, but got string');
  });

  it('checks item patterns, counts and unexpected properties', () => {
    expect(
      validateAgainstSchema({ dates: ['nope', '2024-06-01', '2024-11-20'] }, DATES_SCHEMA)
        .errors[0],
    ).toContain('dates[0]');
    expect(
      validateAgainstSchema({ dates: ['2024-06-01'] }, DATES_SCHEMA).errors.join(' '),
    ).toContain('at least 3 items');
    expect(
      validateAgainstSchema(
        { dates: ['2024-03-15', '2024-06-01', '2024-11-20'], extra: 1 },
        DATES_SCHEMA,
      ).errors[0],
    ).toContain('unexpected property "extra"');
  });

  it('handles enum, const, integer-vs-number and nested objects', () => {
    expect(validateAgainstSchema('b', { type: 'string', enum: ['a', 'b'] }).valid).toBe(true);
    expect(validateAgainstSchema('c', { type: 'string', enum: ['a', 'b'] }).valid).toBe(false);
    expect(validateAgainstSchema(1.5, { type: 'integer' }).valid).toBe(false);
    expect(validateAgainstSchema(2, { type: 'number' }).valid).toBe(true);
    expect(
      validateAgainstSchema(
        { a: { b: 1 } },
        {
          type: 'object',
          properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
        },
      ).errors[0],
    ).toContain('"a.b"');
  });

  it('ignores keywords it does not implement rather than rejecting them', () => {
    expect(
      validateAgainstSchema({ x: 1 }, { type: 'object', $comment: 'hi', title: 'T' }).valid,
    ).toBe(true);
  });

  it('generates a conforming sample from a schema', () => {
    const sample = sampleFromJsonSchema(DATES_SCHEMA);
    expect(validateAgainstSchema(sample, DATES_SCHEMA).valid).toBe(true);
  });
});

describe('validateStructuredOutput', () => {
  it('distinguishes "not JSON" from "JSON of the wrong shape"', () => {
    const notJson = validateStructuredOutput('2024-03-15\n2024-06-01', DATES_SCHEMA);
    expect(notJson.valid).toBe(false);
    expect(notJson.error).toMatch(/not valid JSON/);
    expect(notJson.error).toContain('2024-03-15');

    const wrongShape = validateStructuredOutput('{"dates": 3}', DATES_SCHEMA);
    expect(wrongShape.valid).toBe(false);
    expect(wrongShape.error).toMatch(/valid JSON but/);
  });

  it("format:'json' accepts any JSON at all", () => {
    expect(validateStructuredOutput('[1,2,3]', 'json')).toEqual({ valid: true, value: [1, 2, 3] });
    expect(validateStructuredOutput('nope', 'json').valid).toBe(false);
  });

  it('returns the parsed value on success', () => {
    const result = validateStructuredOutput(
      '{"dates":["2024-03-15","2024-06-01","2024-11-20"]}',
      DATES_SCHEMA,
    );
    expect(result).toEqual({
      valid: true,
      value: { dates: ['2024-03-15', '2024-06-01', '2024-11-20'] },
    });
  });
});

describe('buildRetryMessages', () => {
  it('appends the failed answer and the error, in that order', () => {
    const messages = buildRetryMessages(
      [{ role: 'user', content: 'extract the dates' }],
      'March 3, 1998',
      '"dates" is missing',
    );
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'March 3, 1998' });
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content).toContain('"dates" is missing');
    expect(messages[2]?.content).toContain('JSON only');
  });

  it('does not mutate the original transcript', () => {
    const original: ChatRequest['messages'] = [{ role: 'user', content: 'x' }];
    buildRetryMessages(original, 'bad', 'err');
    expect(original).toHaveLength(1);
  });
});

describe('runStructuredChat', () => {
  const provider = new FakeProvider({ model: 'gemma4:latest' });
  const request = (scenario: string): ChatRequest => ({
    messages: [{ role: 'user', content: 'Extract every date.' }],
    format: DATES_SCHEMA,
    options: { scenario },
  });

  it('does not retry when the first attempt validates', async () => {
    const outcome = await runStructuredChat(provider, request('structured-valid'));
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.result).toMatchObject({ valid: true, retried: false });
    expect(outcome.result.value).toMatchObject({ dates: expect.any(Array) });
  });

  it('retries exactly once and reports success on the second attempt', async () => {
    const outcome = await runStructuredChat(provider, request('structured-retry-ok'));
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.result).toMatchObject({ valid: true, retried: true });
    // The returned response is the retry's, not the failed first attempt's.
    expect(outcome.response).toBe(outcome.attempts[1]);
  });

  it('gives up after one retry and surfaces the error verbatim', async () => {
    const outcome = await runStructuredChat(provider, request('structured-invalid'));
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.result.valid).toBe(false);
    expect(outcome.result.retried).toBe(true);
    expect(outcome.result.error).toMatch(/not valid JSON/);
    expect(outcome.result.value).toBeUndefined();
  });

  it('refuses to run without a format', async () => {
    await expect(
      runStructuredChat(provider, { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrowError(/requires a format/);
  });
});
