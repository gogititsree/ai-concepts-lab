import type { RunToolSelection, ToolDefinition } from '@lab/shared';

import { catalogTool, TOOL_CATALOG } from './catalog.js';
import { createMockTool } from './mock.js';
import { toToolDefinition, type ToolSpec } from './types.js';

export { CalculatorError, evaluateExpression, tokenize } from './calculator.js';
export { TOOL_CATALOG, catalogTool } from './catalog.js';
export { createMockTool } from './mock.js';
export { defineTool, ToolError, toToolDefinition } from './types.js';
export type { ToolContext, ToolParseResult, ToolSpec } from './types.js';
export { zodToJsonSchema } from './zodJsonSchema.js';

/**
 * Turns a validated `{catalog, mock}` selection into the tools one run may use.
 *
 * The catalog side is a lookup, not a filter, so there is no path by which a name that
 * is not in `CatalogToolNameSchema` reaches an implementation. The mock side is
 * constructed from data. Both end up as the same `ToolSpec`, which is why the loop has
 * exactly one code path for "execute a tool" and the trace looks identical either way.
 */
export function resolveTools(selection: RunToolSelection): ToolSpec[] {
  return [
    ...selection.catalog.map((name) => catalogTool(name)),
    ...selection.mock.map((definition) => createMockTool(definition)),
  ];
}

/** Indexed by name, which is how the loop looks up whatever the model asked for. */
export function toolMap(tools: ToolSpec[]): Map<string, ToolSpec> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export const toolDefinitions = (tools: ToolSpec[]): ToolDefinition[] => tools.map(toToolDefinition);

/** The catalog as the browser's tool picker needs it: name, description, schema. */
export const catalogDefinitions = (): ToolDefinition[] =>
  Object.values(TOOL_CATALOG).map(toToolDefinition);
