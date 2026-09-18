import { describe, expect, it } from 'vitest';
import { add } from '../src/index.js';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('is exact for the float case the docs use', () => {
    expect(add(0.1, 0.2)).toBeCloseTo(0.3, 10);
  });
});
