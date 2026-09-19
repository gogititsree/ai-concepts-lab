import { describe, expect, it } from 'vitest';

import {
  meetsExactly,
  parseComparison,
  satisfiesComparison,
} from '../src/features/exercises/checkRules';

describe('parseComparison', () => {
  it('reads every operator the content schema allows', () => {
    expect(parseComparison('>=20')).toEqual({ op: '>=', value: 20 });
    expect(parseComparison('<0.05')).toEqual({ op: '<', value: 0.05 });
    expect(parseComparison('> 0.95')).toEqual({ op: '>', value: 0.95 });
    expect(parseComparison('<=1')).toEqual({ op: '<=', value: 1 });
    expect(parseComparison('==3')).toEqual({ op: '==', value: 3 });
  });

  it('throws on anything else, naming what it could not read', () => {
    expect(() => parseComparison('lots')).toThrow(/Unparseable check rule/);
    expect(() => parseComparison('>')).toThrow();
  });
});

describe('satisfiesComparison', () => {
  it('compares in the direction the rule reads', () => {
    expect(satisfiesComparison('>=20', 20)).toBe(true);
    expect(satisfiesComparison('>=20', 19.999)).toBe(false);
    expect(satisfiesComparison('<0.05', 0.049)).toBe(true);
    expect(satisfiesComparison('<0.05', 0.05)).toBe(false);
    expect(satisfiesComparison('>0.95', 0.951)).toBe(true);
  });

  it('never passes on a measurement that is not a number', () => {
    expect(satisfiesComparison('<0.05', Number.NaN)).toBe(false);
    expect(satisfiesComparison('<0.05', Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('meetsExactly', () => {
  it('tolerates float64 division', () => {
    expect(meetsExactly(1, 100 / 100)).toBe(true);
    expect(meetsExactly(0.7, 7 / 10)).toBe(true);
    expect(meetsExactly(1, 99 / 100)).toBe(false);
  });
});
