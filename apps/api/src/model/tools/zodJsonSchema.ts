import type { JsonSchemaObject } from '@lab/shared';
import { z } from 'zod';

/**
 * A tiny Zod → JSON Schema converter for the subset the tool catalog uses.
 *
 * **Why not `zod-to-json-schema`?** Because the stack list in docs/01-architecture.md is
 * closed and a dependency needs an ADR (the same reasoning that produced the hand-written
 * validator in `model/jsonSchema.ts`). More usefully: the schemas being converted are
 * seven objects in one directory of this repository, all flat, all built from strings,
 * numbers, booleans and enums. A general converter would handle `$ref`, unions,
 * intersections, effects and branded types that no tool here has.
 *
 * **Why derive it at all instead of writing the JSON Schema by hand next to the Zod
 * one?** Because then there would be two schemas, and the day they disagree is the day
 * the model is told about a parameter the server rejects — which is a failure mode with
 * no error message anywhere, just an agent that mysteriously cannot use a tool. One
 * source, two consumers: Zod validates what arrives, the derived JSON Schema is what the
 * model is shown.
 *
 * Unsupported node types throw **at module load**, when the catalog is built, rather than
 * silently emitting `{}` on the first request.
 */

interface Converted {
  schema: JsonSchemaObject;
  /** False for `.optional()` / `.default()` wrappers. */
  required: boolean;
}

function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean } {
  if (schema instanceof z.ZodOptional) {
    return { inner: schema._def.innerType as z.ZodTypeAny, required: false };
  }
  if (schema instanceof z.ZodDefault) {
    return { inner: schema._def.innerType as z.ZodTypeAny, required: false };
  }
  if (schema instanceof z.ZodNullable) {
    return { inner: schema._def.innerType as z.ZodTypeAny, required: true };
  }
  return { inner: schema, required: true };
}

function convertNode(schema: z.ZodTypeAny): Converted {
  const { inner, required } = unwrap(schema);
  const description = schema.description ?? inner.description;
  const withDescription = (base: JsonSchemaObject): Converted => ({
    schema: description === undefined ? base : { ...base, description },
    required,
  });

  if (inner instanceof z.ZodString) {
    const base: JsonSchemaObject = { type: 'string' };
    for (const check of inner._def.checks) {
      if (check.kind === 'min') base.minLength = check.value;
      if (check.kind === 'max') base.maxLength = check.value;
      if (check.kind === 'regex') base.pattern = check.regex.source;
    }
    return withDescription(base);
  }

  if (inner instanceof z.ZodNumber) {
    const base: JsonSchemaObject = { type: inner.isInt ? 'integer' : 'number' };
    for (const check of inner._def.checks) {
      if (check.kind === 'min') base.minimum = check.value;
      if (check.kind === 'max') base.maximum = check.value;
    }
    return withDescription(base);
  }

  if (inner instanceof z.ZodBoolean) return withDescription({ type: 'boolean' });

  if (inner instanceof z.ZodEnum) {
    return withDescription({ type: 'string', enum: [...(inner._def.values as string[])] });
  }

  if (inner instanceof z.ZodLiteral) {
    return withDescription({ const: inner._def.value });
  }

  if (inner instanceof z.ZodArray) {
    const items = convertNode(inner._def.type as z.ZodTypeAny);
    return withDescription({ type: 'array', items: items.schema });
  }

  if (inner instanceof z.ZodObject) {
    return withDescription(zodToJsonSchema(inner));
  }

  throw new Error(
    `zodToJsonSchema: unsupported Zod type "${inner._def.typeName}". Tool parameter schemas must ` +
      'stay in the flat subset a small model can actually follow.',
  );
}

/**
 * Converts a `z.object({...})` into a draft-07-flavoured JSON Schema.
 *
 * `additionalProperties: false` is always emitted, and that is a teaching decision as
 * much as a safety one: Module 5's lesson on tool descriptions says the schema is the
 * contract, and a schema that quietly accepts extra keys is not one.
 */
export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    const converted = convertNode(value as z.ZodTypeAny);
    properties[key] = converted.schema;
    if (converted.required) required.push(key);
  }

  const out: JsonSchemaObject = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  if (schema.description !== undefined) out.description = schema.description;
  return out;
}
