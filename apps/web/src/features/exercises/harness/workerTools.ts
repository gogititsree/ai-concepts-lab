import type { ToolDefinition } from '@lab/shared';

/**
 * The tools the harness worker hands to the learner's `runAgent`.
 *
 * These are **browser** tools. They run in the worker, in the learner's own tab, and the
 * server never sees them — which is the whole reason Module 6's exercise can run with
 * `MODEL_PROVIDER=none` for its scripted checks. The server's catalog
 * (`apps/api/src/model/tools/`) is a different set with a different owner; these two are
 * deliberately not the same code, and the descriptions below are copies of the server's
 * because the description *is* prompt text and the real run sends it to the same model.
 *
 * Two tools, not the three docs/04 lists: `lookup_glossary` needs a Postgres query and
 * there is no read-only HTTP endpoint for it, so exposing it here would mean inventing
 * one for a single exercise. `docs/adr/0003-harness-worker-deviations.md` has the
 * argument, including the measured reason fewer tools is better here: attaching six
 * tools instead of one took the first call from 227 to 1052 prompt tokens and from 23 s
 * to 71 s on the reference machine.
 */

// ------------------------------------------------------------------ arithmetic ----

export class HarnessToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessToolError';
  }
}

const MAX_EXPRESSION_LENGTH = 500;

/**
 * A four-function evaluator that never calls `eval`.
 *
 * A deliberately independent, much smaller sibling of
 * `apps/api/src/model/tools/calculator.ts`. The duplication is real and is the price of
 * not making `apps/web` depend on `apps/api`; what is *not* duplicated is the mistake —
 * the string being evaluated was written by a language model, so the grammar below has
 * no identifier production at all. There is no way to spell a property access, a call or
 * a template literal, because the tokeniser rejects every character that is not a digit,
 * an operator or a bracket.
 *
 *   expr  := term (('+'|'-') term)*
 *   term  := unary (('*'|'/'|'%') unary)*
 *   unary := ('+'|'-') unary | power
 *   power := atom (('^'|'**') unary)?      // right-associative; `^` is a power, not xor
 *   atom  := NUMBER | '(' expr ')'
 */
export function evaluateExpression(input: string): number {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new HarnessToolError(
      `expression is ${input.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}`,
    );
  }
  // Tokenise first and completely: this is the boundary, and after it the parser only
  // ever sees numbers, six operators and brackets.
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index += 1;
    } else if (/[\d.]/.test(char)) {
      // A comma between two digits is a thousands separator: models write "1,234".
      const match = /^\d[\d,]*(?:\.\d+)?|^\.\d+/.exec(input.slice(index));
      if (!match) throw new HarnessToolError(`"${char}" is not the start of a number`);
      tokens.push(match[0].replace(/,/g, ''));
      index += match[0].length;
    } else if (char === '*' && input[index + 1] === '*') {
      tokens.push('^');
      index += 2;
    } else if ('+-*/%^()'.includes(char)) {
      tokens.push(char === '*' ? '*' : char);
      index += 1;
    } else {
      throw new HarnessToolError(
        `unexpected character "${char}" at position ${index}: this tool evaluates arithmetic ` +
          'only (digits, + - * / % ^ and parentheses)',
      );
    }
  }
  if (tokens.length === 0) throw new HarnessToolError('the expression is empty');

  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const eat = (): string => {
    const token = tokens[position];
    if (token === undefined) throw new HarnessToolError('the expression ends unexpectedly');
    position += 1;
    return token;
  };
  const finite = (value: number, operator: string): number => {
    if (!Number.isFinite(value)) {
      throw new HarnessToolError(`"${operator}" produced a result that is not a finite number`);
    }
    return value;
  };

  const expr = (depth: number): number => {
    if (depth > 32) throw new HarnessToolError('the expression nests too deeply');
    let left = term(depth);
    while (peek() === '+' || peek() === '-') {
      const operator = eat();
      const right = term(depth);
      left = finite(operator === '+' ? left + right : left - right, operator);
    }
    return left;
  };
  const term = (depth: number): number => {
    let left = unary(depth);
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = eat();
      const right = unary(depth);
      if (right === 0 && operator !== '*') {
        // Not Infinity and not NaN: an error goes back into the transcript as something
        // the model can react to, which is the loop's error-as-observation contract.
        throw new HarnessToolError('division by zero');
      }
      left = finite(
        operator === '*' ? left * right : operator === '/' ? left / right : left % right,
        operator,
      );
    }
    return left;
  };
  const unary = (depth: number): number => {
    if (peek() === '+' || peek() === '-') {
      const operator = eat();
      const value = unary(depth + 1);
      return operator === '-' ? -value : value;
    }
    return power(depth);
  };
  const power = (depth: number): number => {
    const base = atom(depth);
    if (peek() === '^') {
      eat();
      return finite(base ** unary(depth + 1), '^');
    }
    return base;
  };
  const atom = (depth: number): number => {
    const token = eat();
    if (token === '(') {
      const value = expr(depth + 1);
      if (peek() !== ')') throw new HarnessToolError('missing ")"');
      eat();
      return value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new HarnessToolError(`expected a number but found "${token}"`);
    }
    return value;
  };

  const result = expr(0);
  if (position !== tokens.length) {
    throw new HarnessToolError(`unexpected "${peek()}": the expression already ended`);
  }
  return result;
}

// ----------------------------------------------------------------- the tool set ----

/** Everything a worker tool may be called with: whatever the model put in `args`. */
export type HarnessToolFn = (args: unknown) => unknown;
export type HarnessTools = Record<string, HarnessToolFn>;

const asRecord = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};

/**
 * The definitions sent to the model, copied from the server catalog's wording.
 *
 * The exercise sends these on the real run rather than fetching `GET /model/tools`,
 * because the model must be told about the tools *this worker* implements. Asking the
 * server what its own catalog looks like would describe tools the worker cannot run.
 */
export const HARNESS_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  calculator: {
    name: 'calculator',
    description:
      'Evaluate an arithmetic expression exactly. Use this for EVERY calculation, including ' +
      'ones that look easy - do not do arithmetic in your head. Supports + - * / % and ^ for ' +
      'powers, with parentheses. Example: {"expression": "2500 * 1.07^8"}. Returns the numeric ' +
      'result.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            'An arithmetic expression, e.g. "2500 * 1.07^8". Numbers and operators only.',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  get_current_time: {
    name: 'get_current_time',
    description:
      'Get the current date and time in UTC. You do not know the date; you must call this ' +
      'tool before answering any question about today, now, or the current day of the week. ' +
      'Takes no arguments: {}.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export interface WorkerToolOptions {
  /** Injected so scripted runs are reproducible to the millisecond. */
  now: () => Date;
}

/**
 * Builds the `tools` object handed to `runAgent`.
 *
 * Every tool **throws** on bad arguments rather than returning an error object, and that
 * is the pedagogy: the learner's loop has to wrap the call in a `try`/`catch` and turn
 * the failure into a `tool` message, which is exactly what `agentLoop.ts` does on the
 * server. A tool that returned `{error: ...}` would let a loop with no error handling
 * pass the malformed-arguments scenario.
 */
export function createWorkerTools(
  names: readonly string[],
  options: WorkerToolOptions,
): HarnessTools {
  const all: HarnessTools = {
    calculator(args) {
      const { expression } = asRecord(args);
      if (typeof expression !== 'string' || expression.trim() === '') {
        throw new HarnessToolError(
          'calculator: "expression" is required and must be a non-empty string, ' +
            'e.g. {"expression": "17 * 23"}',
        );
      }
      return { expression, result: evaluateExpression(expression) };
    },
    get_current_time() {
      const now = options.now();
      return {
        iso: now.toISOString(),
        timezone: 'UTC',
        weekday: now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
        unixSeconds: Math.floor(now.getTime() / 1000),
      };
    },
  };

  const tools: HarnessTools = {};
  for (const name of names) {
    const tool = all[name];
    if (tool) tools[name] = tool;
  }
  return tools;
}
