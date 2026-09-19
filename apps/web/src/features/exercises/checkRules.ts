/**
 * The grammar for the thresholds authored in `exercises.json`: `">=20"`, `"<0.05"`, `">0.95"`.
 *
 * `packages/shared` validates the *spelling* of these strings at seed time; this file is the
 * matching interpreter, and it is a pure function of (rule, measurement) so the auto-checks
 * can be unit-tested without mounting a canvas.
 */

export type ComparisonOperator = '>=' | '<=' | '>' | '<' | '==';

export interface Comparison {
  op: ComparisonOperator;
  value: number;
}

const COMPARISON = /^(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/;

export function parseComparison(rule: string): Comparison {
  const match = COMPARISON.exec(rule.trim());
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(`Unparseable check rule: ${JSON.stringify(rule)}`);
  }
  return { op: match[1] as ComparisonOperator, value: Number(match[2]) };
}

/** `satisfies('>=20', 21) === true`. Non-finite measurements never satisfy anything. */
export function satisfiesComparison(rule: string, actual: number): boolean {
  if (!Number.isFinite(actual)) return false;
  const { op, value } = parseComparison(rule);
  switch (op) {
    case '>=':
      return actual >= value;
    case '<=':
      return actual <= value;
    case '>':
      return actual > value;
    case '<':
      return actual < value;
    case '==':
      return actual === value;
  }
}

/**
 * Equality for a measured fraction. Accuracy arrives as `correct / total`, so an exact `1.0`
 * is safe, but `0.7` from `7/10` is not exactly 0.7 in binary floating point -- hence the
 * epsilon rather than `===`.
 */
export function meetsExactly(target: number, actual: number, epsilon = 1e-9): boolean {
  return Number.isFinite(actual) && Math.abs(actual - target) <= epsilon;
}
