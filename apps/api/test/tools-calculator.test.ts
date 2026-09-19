import { describe, expect, it } from 'vitest';

import {
  CalculatorError,
  evaluateExpression,
  MAX_EXPRESSION_LENGTH,
  tokenize,
} from '../src/model/tools/calculator.js';

/**
 * The calculator parser.
 *
 * Two thirds of this file is about what the parser **refuses**, and that is the right
 * proportion: this tool evaluates a string a language model wrote, so the security
 * property is not "it computes 2+2" but "there is no input for which it does anything
 * other than arithmetic". The rejection tests are the ones that would fail if someone
 * ever decided a quick `new Function(expr)` would be simpler.
 */

const evaluate = (expression: string): number => evaluateExpression(expression);

describe('arithmetic', () => {
  it.each([
    ['1 + 1', 2],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['10 - 2 - 3', 5],
    ['100 / 5 / 2', 10],
    ['7 % 3', 1],
    ['-5 + 2', -3],
    ['--5', 5],
    ['+7', 7],
    ['2 ^ 3', 8],
    ['2 ** 3', 8],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['2 ^ -2', 0.25],
    ['1.5 * 2', 3],
    ['.5 + .25', 0.75],
    ['1e3 + 1', 1001],
    ['1,234 + 1', 1235],
    ['((((1+1))))', 2],
  ])('evaluates %s to %d', (expression, expected) => {
    expect(evaluate(expression)).toBeCloseTo(expected, 10);
  });

  it('gets the compound-interest task right', () => {
    // The number Module 5's `compound-interest` task checks against.
    expect(evaluate('2500 * 1.07^8')).toBeCloseTo(4295.4654, 4);
  });

  it('applies precedence rather than left-to-right', () => {
    // The whole reason this is a parser and not a fold: `2 + 3 * 4` is 14, not 20.
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('2 * 3 + 4')).toBe(10);
  });

  it('treats ^ as exponentiation, right-associatively', () => {
    // Not xor, and not (2^3)^2 = 64. Models write `2^8` when they mean a power.
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
  });
});

describe('arithmetic failures', () => {
  it('rejects division by zero instead of returning Infinity', () => {
    // Infinity would be reported to the model as an answer; an error is an observation
    // it can act on.
    expect(() => evaluate('1 / 0')).toThrow(/division by zero/);
    expect(() => evaluate('1 % 0')).toThrow(/division by zero/);
    expect(() => evaluate('(4 - 4) / (2 - 2)')).toThrow(/division by zero/);
  });

  it('rejects a result that overflows to Infinity', () => {
    expect(() => evaluate('9e300 ^ 4')).toThrow(CalculatorError);
  });

  it('rejects unbalanced and empty expressions', () => {
    expect(() => evaluate('(1 + 2')).toThrow(/missing "\)"/);
    expect(() => evaluate('1 + 2)')).toThrow(/already ended/);
    expect(() => evaluate('   ')).toThrow(/empty/);
    expect(() => evaluate('1 +')).toThrow(CalculatorError);
    expect(() => evaluate('* 3')).toThrow(CalculatorError);
  });
});

describe('it is not an evaluator', () => {
  // Each of these is something `eval` would happily do.
  it.each([
    'process.env.SESSION_SECRET',
    'require("fs").readFileSync("/etc/passwd")',
    'globalThis',
    'constructor.constructor("return 1")()',
    '(function(){return 1})()',
    'this',
    '[].map(x=>x)',
    '`${1+1}`',
    'Math.max(1,2)',
    '1;console.log(2)',
    'a = 1',
    '0x10',
    '1 & 2',
    '1 | 2',
    'true',
    'null',
    '"1" + "1"',
    '1 < 2',
  ])('refuses %s', (expression) => {
    expect(() => evaluate(expression)).toThrow(CalculatorError);
  });

  it('names the offending character, because that error goes back to the model', () => {
    expect(() => evaluate('2 + process')).toThrow(/unexpected character "p" at position 4/);
  });

  it('produces no identifier token at all', () => {
    // The tokeniser is the boundary: if it cannot emit a name, nothing downstream can
    // possibly call one.
    const tokens = tokenize('2 * (3 + 4)');
    expect(new Set(tokens.map((token) => token.kind))).toEqual(
      new Set(['number', 'operator', 'lparen', 'rparen']),
    );
  });
});

describe('denial-of-service ceilings', () => {
  it('rejects an over-long expression before parsing it', () => {
    const long = `1${'+1'.repeat(MAX_EXPRESSION_LENGTH)}`;
    expect(() => evaluate(long)).toThrow(/limit is 500/);
  });

  it('rejects nesting deeper than the cap rather than overflowing the stack', () => {
    const deep = `${'('.repeat(80)}1${')'.repeat(80)}`;
    expect(() => evaluate(deep)).toThrow(/nests deeper/);
  });
});
