/**
 * A four-function calculator that never evaluates JavaScript.
 *
 * **Why this file is fifteen times longer than `eval(expression)`.** The string being
 * evaluated here was written by a language model, which was in turn influenced by text a
 * learner typed and by whatever a tool result put into the transcript. That is the
 * textbook definition of untrusted input, and `eval` / `new Function` would hand it the
 * whole Node process: `process.env.SESSION_SECRET`, `require('fs')`, an outbound socket.
 * "It only ever sends arithmetic" is a statement about the model's *behaviour*, and the
 * entire point of Module 5's guardrails lesson is that the model's behaviour is not a
 * security boundary.
 *
 * So: a tokeniser that recognises exactly numbers, six operators and parentheses, and a
 * recursive-descent parser over that token stream. There is no identifier token. There
 * is no way to spell `process`, a function call, a property access or a template
 * literal, because the grammar has no production that could accept one — the failure
 * happens in the tokeniser, before any parsing, with a message naming the offending
 * character.
 *
 * Grammar (precedence climbing, lowest first):
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('+' | '-') unary | power
 *   power      := primary (('^' | '**') unary)?        // right-associative
 *   primary    := NUMBER | '(' expression ')'
 *
 * `^` is exponentiation, not xor: every model this app talks to writes `2^8` when it
 * means a power, and a calculator tool that silently computed a bitwise xor would be a
 * wrong answer rather than an error. `**` is accepted as the same operator.
 */

/** A failure the loop is expected to hand back to the model as an observation. */
export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

/**
 * Ceilings, because a tool is a denial-of-service surface too. 500 characters is far more
 * than any arithmetic question needs, and the nesting cap stops `((((…))))` from turning
 * recursive descent into a stack overflow (which would crash the process, not the run).
 */
export const MAX_EXPRESSION_LENGTH = 500;
export const MAX_DEPTH = 32;

type TokenKind = 'number' | 'operator' | 'lparen' | 'rparen';

interface Token {
  kind: TokenKind;
  /** Numeric value for `number`, the operator text otherwise. */
  value: string;
  /** Index in the source string, so an error can point at the character. */
  at: number;
}

const OPERATORS = new Set(['+', '-', '*', '/', '%', '^', '**']);

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/**
 * Source text → tokens, rejecting anything that is not arithmetic.
 *
 * This is the security boundary. Everything downstream operates on a `Token[]` that, by
 * construction, contains only numbers, the six operators and parentheses.
 */
export function tokenize(input: string): Token[] {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorError(
      `expression is ${input.length} characters; the limit is ${MAX_EXPRESSION_LENGTH}`,
    );
  }

  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    // Whitespace of any kind, including the newlines a model puts in a long expression.
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (isDigit(char) || (char === '.' && isDigit(input[index + 1] ?? ''))) {
      const start = index;
      // A comma between two digits is a thousands separator, not an operator: models
      // write "1,234" and a calculator that choked on it would be a wrong answer for a
      // formatting habit.
      while (
        index < input.length &&
        (isDigit(input[index] as string) ||
          (input[index] === ',' &&
            isDigit(input[index - 1] ?? '') &&
            isDigit(input[index + 1] ?? '')))
      ) {
        index += 1;
      }
      if (input[index] === '.') {
        index += 1;
        while (index < input.length && isDigit(input[index] as string)) index += 1;
      }
      // Scientific notation: `1.5e3`. Only accepted immediately after a number, which is
      // why it lives here rather than as a letter the tokeniser would otherwise reject.
      if (input[index] === 'e' || input[index] === 'E') {
        const save = index;
        index += 1;
        if (input[index] === '+' || input[index] === '-') index += 1;
        if (isDigit(input[index] ?? '')) {
          while (index < input.length && isDigit(input[index] as string)) index += 1;
        } else {
          index = save;
        }
      }
      const text = input.slice(start, index).replace(/,/g, '');
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalculatorError(`"${text}" is not a finite number`);
      }
      tokens.push({ kind: 'number', value: text, at: start });
      continue;
    }

    if (char === '(') {
      tokens.push({ kind: 'lparen', value: char, at: index });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', value: char, at: index });
      index += 1;
      continue;
    }

    if (char === '*' && input[index + 1] === '*') {
      tokens.push({ kind: 'operator', value: '**', at: index });
      index += 2;
      continue;
    }
    if (OPERATORS.has(char)) {
      tokens.push({ kind: 'operator', value: char, at: index });
      index += 1;
      continue;
    }

    // The one rejection that matters. No identifiers, no strings, no calls, no dots.
    throw new CalculatorError(
      `unexpected character "${char}" at position ${index}: this tool evaluates arithmetic only ` +
        '(digits, + - * / % ^ and parentheses)',
    );
  }

  if (tokens.length === 0) throw new CalculatorError('the expression is empty');
  return tokens;
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private eat(): Token {
    const token = this.tokens[this.position];
    if (!token) throw new CalculatorError('the expression ends unexpectedly');
    this.position += 1;
    return token;
  }

  private isOperator(...values: string[]): boolean {
    const token = this.peek();
    return token?.kind === 'operator' && values.includes(token.value);
  }

  parse(): number {
    const value = this.expression(0);
    const extra = this.peek();
    if (extra) {
      throw new CalculatorError(
        `unexpected "${extra.value}" at position ${extra.at}: the expression already ended`,
      );
    }
    return value;
  }

  private expression(depth: number): number {
    this.guard(depth);
    let left = this.term(depth);
    while (this.isOperator('+', '-')) {
      const operator = this.eat().value;
      const right = this.term(depth);
      left = operator === '+' ? left + right : left - right;
      this.finite(left, operator);
    }
    return left;
  }

  private term(depth: number): number {
    let left = this.unary(depth);
    while (this.isOperator('*', '/', '%')) {
      const token = this.eat();
      const right = this.unary(depth);
      if ((token.value === '/' || token.value === '%') && right === 0) {
        // Not Infinity, and not NaN: a model that is told "Infinity" will happily report
        // it as an answer, whereas an error goes back into the transcript as something
        // it can react to. This is the loop's error-as-observation contract.
        throw new CalculatorError('division by zero');
      }
      left = token.value === '*' ? left * right : token.value === '/' ? left / right : left % right;
      this.finite(left, token.value);
    }
    return left;
  }

  private unary(depth: number): number {
    if (this.isOperator('+', '-')) {
      const operator = this.eat().value;
      const value = this.unary(depth + 1);
      return operator === '-' ? -value : value;
    }
    return this.power(depth);
  }

  private power(depth: number): number {
    const base = this.primary(depth);
    if (this.isOperator('^', '**')) {
      this.eat();
      // Right-associative, and the exponent may itself be unary-negated: `2^-3`.
      const exponent = this.unary(depth + 1);
      const value = base ** exponent;
      this.finite(value, '^');
      return value;
    }
    return base;
  }

  private primary(depth: number): number {
    const token = this.eat();
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'lparen') {
      const value = this.expression(depth + 1);
      const close = this.peek();
      if (close?.kind !== 'rparen') {
        throw new CalculatorError(`missing ")" for the "(" at position ${token.at}`);
      }
      this.eat();
      return value;
    }
    throw new CalculatorError(
      `expected a number but found "${token.value}" at position ${token.at}`,
    );
  }

  private guard(depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new CalculatorError(`the expression nests deeper than ${MAX_DEPTH} levels`);
    }
  }

  private finite(value: number, operator: string): void {
    if (!Number.isFinite(value)) {
      throw new CalculatorError(
        `"${operator}" produced ${Number.isNaN(value) ? 'NaN' : 'a number too large to represent'}`,
      );
    }
  }
}

/** Parses and evaluates an arithmetic expression. Throws `CalculatorError` on anything else. */
export function evaluateExpression(expression: string): number {
  return new Parser(tokenize(expression)).parse();
}
