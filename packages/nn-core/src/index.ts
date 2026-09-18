/**
 * Framework-free ML math. Zero runtime dependencies on purpose: this package is
 * imported both by the browser (visualizations) and by Vitest (numerical tests),
 * so the code that draws a decision boundary is the code the tests prove correct.
 *
 * M1 ships only `add` so the build/test pipeline is real; M2 fills this in
 * (perceptron, MLP + backprop, gradient check, BPE, attention, PCA).
 */
export function add(a: number, b: number): number {
  return a + b;
}
