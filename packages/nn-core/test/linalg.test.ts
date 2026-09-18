import { describe, expect, it } from 'vitest';
import {
  add,
  addInPlace,
  argMax,
  cloneMatrix,
  columnMeans,
  dot,
  matMul,
  matVec,
  mean,
  multiply,
  norm,
  normalize,
  outer,
  scale,
  scaleInPlace,
  shape,
  subtract,
  sum,
  transpose,
  zeros,
  zerosMatrix,
} from '../src/linalg.js';

describe('constructors', () => {
  it('zeros builds a vector of the requested length', () => {
    expect(zeros(3)).toEqual([0, 0, 0]);
    expect(zeros(0)).toEqual([]);
  });

  it('zerosMatrix gives each row its own array', () => {
    const m = zerosMatrix(2, 3);
    expect(m).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    m[0]![0] = 9;
    expect(m[1]![0]).toBe(0);
  });

  it('shape reports rows and columns, and [0, 0] for an empty matrix', () => {
    expect(shape([[1, 2, 3]])).toEqual([1, 3]);
    expect(shape([])).toEqual([0, 0]);
  });

  it('cloneMatrix copies rows rather than aliasing them', () => {
    const original = [
      [1, 2],
      [3, 4],
    ];
    const copy = cloneMatrix(original);
    copy[0]![0] = 99;
    expect(original[0]![0]).toBe(1);
  });
});

describe('vector arithmetic', () => {
  it('dot is the sum of element-wise products', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dot([], [])).toBe(0);
  });

  it('add, subtract, scale and multiply work element-wise', () => {
    expect(add([1, 2], [3, 4])).toEqual([4, 6]);
    expect(subtract([1, 2], [3, 5])).toEqual([-2, -3]);
    expect(scale([1, -2], 3)).toEqual([3, -6]);
    expect(multiply([2, 3], [4, 5])).toEqual([8, 15]);
  });

  it('addInPlace and scaleInPlace mutate and return the target', () => {
    const target = [1, 2, 3];
    expect(addInPlace(target, [10, 20, 30])).toBe(target);
    expect(target).toEqual([11, 22, 33]);
    expect(scaleInPlace(target, 0.5)).toBe(target);
    expect(target).toEqual([5.5, 11, 16.5]);
  });

  it('sum, mean, norm and argMax summarise a vector', () => {
    expect(sum([1, 2, 3, 4])).toBe(10);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
    expect(norm([3, 4])).toBe(5);
    expect(argMax([1, 7, 7, 2])).toBe(1);
    expect(argMax([])).toBe(-1);
  });

  it('normalize returns a unit vector in the same direction', () => {
    const unit = normalize([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6, 15);
    expect(unit[1]).toBeCloseTo(0.8, 15);
    expect(norm(unit)).toBeCloseTo(1, 15);
  });

  it('rejects mismatched lengths and the zero vector', () => {
    expect(() => dot([1], [1, 2])).toThrow(RangeError);
    expect(() => add([1], [1, 2])).toThrow(/length mismatch/);
    expect(() => subtract([1], [])).toThrow(RangeError);
    expect(() => multiply([1], [])).toThrow(RangeError);
    expect(() => addInPlace([1], [1, 2])).toThrow(RangeError);
    expect(() => normalize([0, 0])).toThrow(/zero vector/);
  });
});

describe('matrix arithmetic', () => {
  it('matVec multiplies each row by the vector', () => {
    expect(
      matVec(
        [
          [1, 2],
          [3, 4],
        ],
        [1, 1],
      ),
    ).toEqual([3, 7]);
  });

  it('transpose swaps indices and is its own inverse', () => {
    const m = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(transpose(m)).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(transpose(transpose(m))).toEqual(m);
    expect(transpose([])).toEqual([]);
  });

  it('transpose rejects ragged input', () => {
    expect(() => transpose([[1, 2], [3]])).toThrow(/ragged/);
  });

  it('matMul multiplies conforming matrices, including through a zero entry', () => {
    const a = [
      [1, 0],
      [0, 2],
    ];
    const b = [
      [1, 2],
      [3, 4],
    ];
    expect(matMul(a, b)).toEqual([
      [1, 2],
      [6, 8],
    ]);
  });

  it('matMul rejects non-conforming shapes', () => {
    expect(() => matMul([[1, 2, 3]], [[1, 2]])).toThrow(/inner dimensions/);
  });

  it('outer produces the dL/dW shape', () => {
    expect(outer([1, 2], [10, 20, 30])).toEqual([
      [10, 20, 30],
      [20, 40, 60],
    ]);
  });

  it('columnMeans averages down the columns', () => {
    expect(
      columnMeans([
        [1, 10],
        [3, 20],
      ]),
    ).toEqual([2, 15]);
    expect(columnMeans([])).toEqual([]);
  });
});
