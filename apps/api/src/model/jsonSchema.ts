/**
 * A small, dependency-free JSON Schema validator, plus a matching example generator.
 *
 * **Why not Ajv or `zod-from-json-schema`?** The stack list in docs/01-architecture.md is
 * closed and adding a dependency needs an ADR. More to the point, the job here is narrow
 * and known: the schemas are *authored in this repo* (Module 4's `extract-dates`) or
 * typed into the exercise's editor by a learner, and they are draft-07-flavoured objects
 * with types, properties, required, items and a few bounds. A 40 KB validator that
 * implements `$ref` resolution and format assertions would be answering questions nobody
 * asked.
 *
 * What *is* load-bearing is the error message. Decision 16 says a failed structured
 * output is retried once with the validation error fed back to the model, and Module 4's
 * exercise shows that error to the learner verbatim. So the messages are written to be
 * read by both: a path, what was expected, what arrived.
 *
 * Unsupported keywords are ignored rather than rejected — an unknown keyword means "this
 * validator has nothing to say about that", which is the correct reading of JSON Schema.
 */

export interface ValidationResult {
  valid: boolean;
  /** Human-readable, path-prefixed. Empty when `valid`. */
  errors: string[];
}

type Json = unknown;
type Schema = Record<string, unknown>;

const typeOfJson = (value: Json): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

/** `integer` is a `number`; everything else is exact. */
function matchesType(value: Json, expected: string): boolean {
  const actual = typeOfJson(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

const at = (path: string) => (path === '' ? 'the value' : `"${path}"`);

function validateInto(value: Json, schema: Schema, path: string, errors: string[]): void {
  if (typeof schema !== 'object' || schema === null) return;

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at(path)} must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as Json[];
    if (!allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
      errors.push(`${at(path)} must be one of ${allowed.map((e) => JSON.stringify(e)).join(', ')}`);
      return;
    }
  }

  const expectedTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? (schema.type as string[])
        : [];
  if (expectedTypes.length > 0 && !expectedTypes.some((t) => matchesType(value, t))) {
    errors.push(
      `${at(path)} must be of type ${expectedTypes.join(' or ')}, but got ${typeOfJson(value)}`,
    );
    return;
  }

  // anyOf / oneOf: one branch is enough, and the report names the whole union rather
  // than every branch's complaint, which is unreadable.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const matched = branches.some((branch) => {
      const nested: string[] = [];
      validateInto(value, branch as Schema, path, nested);
      return nested.length === 0;
    });
    if (!matched) errors.push(`${at(path)} does not match any of the ${key} alternatives`);
  }

  if (typeOfJson(value) === 'object') {
    const object = value as Record<string, Json>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;

    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!(required in object)) {
        errors.push(`${at(path)} is missing the required property "${required}"`);
      }
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      const childPath = path === '' ? key : `${path}.${key}`;
      if (childSchema) {
        validateInto(child, childSchema, childPath, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at(path)} has an unexpected property "${key}"`);
      }
    }
  }

  if (Array.isArray(value)) {
    const items = schema.items as Schema | undefined;
    if (items) {
      value.forEach((entry, index) => validateInto(entry, items, `${path}[${index}]`, errors));
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(
        `${at(path)} must have at least ${schema.minItems} items, but has ${value.length}`,
      );
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(
        `${at(path)} must have at most ${schema.maxItems} items, but has ${value.length}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${at(path)} must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${at(path)} must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string') {
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(schema.pattern);
      } catch {
        // An unparseable pattern is the schema author's bug, not the model's output's.
        regex = null;
      }
      if (regex && !regex.test(value)) {
        errors.push(`${at(path)} must match the pattern ${schema.pattern}`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${at(path)} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${at(path)} must be <= ${schema.maximum}`);
    }
  }
}

export function validateAgainstSchema(value: Json, schema: Schema): ValidationResult {
  const errors: string[] = [];
  validateInto(value, schema, '', errors);
  // Cap the report: a wildly wrong value against a big schema can produce dozens of
  // errors, and both the model and the learner only act on the first few.
  return { valid: errors.length === 0, errors: errors.slice(0, 10) };
}

// ------------------------------------------------------------------- generation ----

/** Dates the `FakeProvider` hands back for string fields that look like dates. */
const SAMPLE_DATES = ['2024-03-15', '2024-06-01', '2024-11-20'];

const looksLikeDate = (key: string, schema: Schema): boolean =>
  schema.format === 'date' || schema.format === 'date-time' || /date|day|when/i.test(key);

/**
 * Builds a minimal value that satisfies `schema`.
 *
 * This is what lets `FakeProvider`'s `structured-valid` scenario answer *any* schema the
 * exercise or a test throws at it instead of only the one hard-coded example. It is not
 * a fuzzer and makes no attempt at variety: the same schema always yields the same value,
 * which is the entire point of a fake.
 */
export function sampleFromJsonSchema(schema: Schema, key = ''): Json {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('const' in schema) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required as string[] | undefined) ?? Object.keys(properties);
      const out: Record<string, Json> = {};
      for (const name of new Set([...required, ...Object.keys(properties)])) {
        const child = properties[name];
        if (child) out[name] = sampleFromJsonSchema(child, name);
      }
      return out;
    }
    case 'array': {
      const items = (schema.items ?? { type: 'string' }) as Schema;
      const count = Math.max(typeof schema.minItems === 'number' ? schema.minItems : 3, 1);
      return Array.from({ length: count }, (_unused, index) =>
        sampleFromJsonSchema({ ...items, __index: index } as Schema, key),
      );
    }
    case 'integer':
      return typeof schema.minimum === 'number' ? schema.minimum : 42;
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1.5;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'string':
    default: {
      if (looksLikeDate(key, schema)) {
        const index = typeof schema.__index === 'number' ? schema.__index : 0;
        return SAMPLE_DATES[index % SAMPLE_DATES.length];
      }
      return key ? `fake ${key}` : 'fake value';
    }
  }
}
