import type { JsonSchemaObject, ToolDefinition } from '@lab/shared';
import type { z } from 'zod';

import type { Db } from '../../db/client.js';
import { zodToJsonSchema } from './zodJsonSchema.js';

/**
 * What a tool is, in this application.
 *
 * Four fields, and the order they are used in matters:
 *
 *  1. **`description`** — sent to the model. It is *not* documentation, it is prompt
 *     text, and it is the single biggest lever on whether an 8B model calls the tool at
 *     the right moment. Module 5's second lesson is about exactly this, so every
 *     description here is written the way the lesson says to write one: what it does,
 *     when to use it, and one concrete example of an argument.
 *  2. **`parameters`** — the JSON Schema the model is shown, derived from (3) so the two
 *     cannot drift.
 *  3. **`parse`** — runs on the arguments the model produced, *before* anything executes.
 *     A model that was given a schema still sends the wrong shape often enough that this
 *     is not a formality; its failure is fed back into the conversation as an
 *     observation rather than crashing the run.
 *  4. **`execute`** — the actual work, with whatever context it needs.
 *
 * `catalog: false` marks a learner-defined mock tool. Nothing about the loop treats them
 * differently, but the `mock-tool` task check needs to tell them apart, and it is
 * honest for the trace to know which tools were the server's and which were made up.
 */
export interface ToolContext {
  db: Db;
  /** Injectable clock: `get_current_time` is unit-tested against a fixed instant. */
  now: () => Date;
  /** Owner of the run, for tools that might ever scope data to a user. */
  userId: string;
  signal?: AbortSignal;
}

export type ToolParseResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  readonly catalog: boolean;
  parse(args: unknown): ToolParseResult;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * A tool failure that is *expected*: bad input, a missing record, a service that is
 * deliberately broken. The loop turns one of these into a `tool_result` step with
 * `is_error` and feeds it back to the model. Anything else that escapes `execute` is a
 * bug in this repository and is reported as such.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code = 'TOOL_ERROR',
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface DefineToolOptions<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<unknown> | unknown;
}

/** Builds a catalog tool: one Zod schema, converted once, validated per call. */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(
  options: DefineToolOptions<S>,
): ToolSpec {
  const parameters = zodToJsonSchema(options.schema);
  // `.strict()` so Zod agrees with the `additionalProperties: false` the model was
  // shown. Zod's default is to *strip* unknown keys, which would mean the schema said
  // one thing and the server quietly did another — the exact drift this file exists to
  // prevent, and a bad example to set in a module about tool contracts.
  const schema = options.schema.strict();
  return {
    name: options.name,
    description: options.description,
    parameters,
    catalog: true,
    parse(args: unknown): ToolParseResult {
      const result = schema.safeParse(args ?? {});
      if (result.success) return { ok: true, value: result.data };
      return {
        ok: false,
        // Path-prefixed and plain, because this string is read twice: once by the model
        // on its next turn, and once by a learner in the trace viewer.
        errors: result.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      };
    },
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      return options.execute(args as z.infer<S>, ctx);
    },
  };
}

/** The provider-neutral shape sent to the model, and stored in `agent_runs.tools`. */
export const toToolDefinition = (tool: ToolSpec): ToolDefinition => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});
