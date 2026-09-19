import type { MockToolDefinition } from '@lab/shared';

import { validateAgainstSchema } from '../jsonSchema.js';
import type { ToolSpec } from './types.js';

/**
 * A learner-defined tool, executed by looking the answer up.
 *
 * docs/01-architecture.md is categorical: *tools are never learner-supplied code*. A
 * mock tool is therefore four pieces of data — a name, a description, a JSON Schema and
 * a canned response — and "executing" it means picking a value out of a table. There is
 * no sandbox to escape because there is nothing running.
 *
 * That turns out to be enough for the whole lesson. What Module 5 is teaching is how a
 * tool's *description and schema* steer the model, and how the result comes back as a
 * `tool` message: none of that needs the tool to compute anything. A learner who writes
 * `get_order_status` with an `order_id` string and a canned `{"status":"shipped"}` gets
 * the identical trace to one backed by a real warehouse.
 *
 * Arguments are validated against the learner's own JSON Schema before the lookup, using
 * the same validator the structured-output path uses. A mock tool with a `required`
 * field that the model omits therefore produces a real, readable schema error — which is
 * the most instructive thing a mock tool can do.
 */

/** Shallow equality on the keys the rule names; extra argument keys are ignored. */
function ruleMatches(when: Record<string, unknown>, args: unknown): boolean {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  return Object.entries(when).every(
    ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value),
  );
}

export function createMockTool(definition: MockToolDefinition): ToolSpec {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    catalog: false,
    parse(args: unknown) {
      const value = args ?? {};
      const result = validateAgainstSchema(value, definition.parameters);
      return result.valid ? { ok: true, value } : { ok: false, errors: result.errors };
    },
    async execute(args: unknown) {
      const rule = definition.responses?.find((entry) => ruleMatches(entry.when, args));
      // `?? null` rather than `undefined`: the result is JSON.stringify'd into a `tool`
      // message, and `JSON.stringify(undefined)` is the string "undefined", which is not
      // JSON and would be the model's first sight of a broken tool.
      return (rule ? rule.response : definition.response) ?? null;
    },
  };
}
