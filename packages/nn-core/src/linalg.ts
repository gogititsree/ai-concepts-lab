/**
 * The smallest linear algebra library that the rest of this package needs.
 *
 * Everything is a plain `number[]` or `number[][]` (row-major: `m[row][col]`). No typed
 * arrays, no classes, no matrix object with methods. That is deliberate: these values get
 * put straight into a Zustand store, serialised to JSON, and diffed in tests, and a plain
 * array survives all three.
 *
 * Note on `!`: the project compiles with `noUncheckedIndexedAccess`, so `a[i]` has type
 * `number | undefined`. Every loop below is bounded by the length of the array it indexes,
 * so the non-null assertions are provably safe and keep the arithmetic readable.
 */

/** Throw if two vectors cannot be combined element-wise. */
function assertSameLength(a: readonly number[], b: readonly number[], operation: string): void {
  if (a.length !== b.length) {
    throw new RangeError(`${operation}: length mismatch (${a.length} vs ${b.length})`);
  }
}

/** A vector of `n` zeros. */
export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/** A `rows x cols` matrix of zeros. Each row is a fresh array (no shared references). */
export function zerosMatrix(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => zeros(cols));
}

/** `[rows, cols]` of a matrix; cols is the length of the first row (0 for an empty matrix). */
export function shape(m: readonly number[][]): [number, number] {
  return [m.length, m.length === 0 ? 0 : m[0]!.length];
}

/** Deep copy of a matrix. */
export function cloneMatrix(m: readonly number[][]): number[][] {
  return m.map((row) => [...row]);
}

/** Inner product `a · b`. */
export function dot(a: readonly number[], b: readonly number[]): number {
  assertSameLength(a, b, 'dot');
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += a[i]! * b[i]!;
  }
  return total;
}

/** Element-wise `a + b` as a new vector. */
export function add(a: readonly number[], b: readonly number[]): number[] {
  assertSameLength(a, b, 'add');
  return a.map((value, i) => value + b[i]!);
}

/** Element-wise `a - b` as a new vector. */
export function subtract(a: readonly number[], b: readonly number[]): number[] {
  assertSameLength(a, b, 'subtract');
  return a.map((value, i) => value - b[i]!);
}

/** `a * scalar` as a new vector. */
export function scale(a: readonly number[], scalar: number): number[] {
  return a.map((value) => value * scalar);
}

/** Element-wise `a * b` (Hadamard product) as a new vector. */
export function multiply(a: readonly number[], b: readonly number[]): number[] {
  assertSameLength(a, b, 'multiply');
  return a.map((value, i) => value * b[i]!);
}

/** `target += delta`, mutating and returning `target` (the hot path in gradient accumulation). */
export function addInPlace(target: number[], delta: readonly number[]): number[] {
  assertSameLength(target, delta, 'addInPlace');
  for (let i = 0; i < target.length; i += 1) {
    target[i]! += delta[i]!;
  }
  return target;
}

/** `target *= scalar`, mutating and returning `target`. */
export function scaleInPlace(target: number[], scalar: number): number[] {
  for (let i = 0; i < target.length; i += 1) {
    target[i]! *= scalar;
  }
  return target;
}

/** Matrix-vector product `m · v`; `m` is `rows x v.length`, the result has `rows` entries. */
export function matVec(m: readonly number[][], v: readonly number[]): number[] {
  return m.map((row) => dot(row, v));
}

/** Transpose: `transpose(m)[c][r] === m[r][c]`. */
export function transpose(m: readonly number[][]): number[][] {
  const [rows, cols] = shape(m);
  const out = zerosMatrix(cols, rows);
  for (let r = 0; r < rows; r += 1) {
    const row = m[r]!;
    if (row.length !== cols) {
      throw new RangeError(
        `transpose: ragged matrix (row ${r} has ${row.length}, expected ${cols})`,
      );
    }
    for (let c = 0; c < cols; c += 1) {
      out[c]![r] = row[c]!;
    }
  }
  return out;
}

/** Matrix product `a · b`, with `a` being `n x k` and `b` being `k x m`. */
export function matMul(a: readonly number[][], b: readonly number[][]): number[][] {
  const [, aCols] = shape(a);
  const [bRows, bCols] = shape(b);
  if (aCols !== bRows) {
    throw new RangeError(`matMul: inner dimensions differ (${aCols} vs ${bRows})`);
  }
  const out = zerosMatrix(a.length, bCols);
  for (let i = 0; i < a.length; i += 1) {
    const aRow = a[i]!;
    const outRow = out[i]!;
    for (let k = 0; k < aCols; k += 1) {
      const aik = aRow[k]!;
      if (aik === 0) continue;
      const bRow = b[k]!;
      for (let j = 0; j < bCols; j += 1) {
        outRow[j]! += aik * bRow[j]!;
      }
    }
  }
  return out;
}

/** Outer product: `outer(a, b)[i][j] === a[i] * b[j]`. This is the shape of `dL/dW`. */
export function outer(a: readonly number[], b: readonly number[]): number[][] {
  return a.map((value) => b.map((other) => value * other));
}

/** Sum of the entries. */
export function sum(v: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < v.length; i += 1) {
    total += v[i]!;
  }
  return total;
}

/** Arithmetic mean; 0 for an empty vector. */
export function mean(v: readonly number[]): number {
  return v.length === 0 ? 0 : sum(v) / v.length;
}

/** Euclidean (L2) length. */
export function norm(v: readonly number[]): number {
  return Math.sqrt(dot(v, v));
}

/** Unit vector in the same direction. Throws for the zero vector, which has no direction. */
export function normalize(v: readonly number[]): number[] {
  const length = norm(v);
  if (length === 0) {
    throw new RangeError('normalize: cannot normalize the zero vector');
  }
  return scale(v, 1 / length);
}

/** Index of the largest entry (first one wins on a tie); -1 for an empty vector. */
export function argMax(v: readonly number[]): number {
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i]! > bestValue) {
      bestValue = v[i]!;
      best = i;
    }
  }
  return best;
}

/** Column-wise means of a `rows x cols` matrix; the first step of PCA. */
export function columnMeans(data: readonly number[][]): number[] {
  const [rows, cols] = shape(data);
  const out = zeros(cols);
  for (let r = 0; r < rows; r += 1) {
    addInPlace(out, data[r]!);
  }
  return rows === 0 ? out : scaleInPlace(out, 1 / rows);
}
