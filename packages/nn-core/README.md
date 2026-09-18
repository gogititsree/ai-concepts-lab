# `@lab/nn-core`

The from-scratch ML math behind Modules 1–3 of AI Concepts Lab: a perceptron, a multilayer
perceptron with backpropagation, a gradient checker, toy datasets, a byte-pair-encoding
tokenizer, scaled dot-product attention and PCA.

Three rules shape the whole package:

- **Zero runtime dependencies.** The browser imports it to draw decision boundaries, and Vitest
  imports it to prove the numbers right. Same code, same answers.
- **Plain data, no classes.** A model is `{ layerSizes, layers: [{ weights, biases, activation }] }`
  — arrays and numbers. It goes straight into a Zustand store, survives `JSON.stringify` into
  `user_exercise_progress.state`, and comes back without a revival step.
- **Deterministic.** Anything random comes from a seeded PRNG (`createRng`). Same seed, same
  network, same picture, same test result.

```bash
pnpm --filter @lab/nn-core test        # 204 unit tests
pnpm --filter @lab/nn-core test:coverage   # with the 90 % gate
pnpm --filter @lab/nn-core typecheck
```

---

## Worked example — Lesson 2.2

This is the network Lesson 2.2 walks through, and it is asserted to 1e-9 in
`test/mlp.forward.test.ts`. If the lesson and the code ever disagree, the test fails.

A 2-2-1 network, sigmoid everywhere:

```
W1 = [[0.15, 0.20],   b1 = [0.35, 0.35]
      [0.25, 0.30]]
W2 = [[0.40, 0.45]]   b2 = [0.60]
x  = [0.05, 0.10]     y  = [0.01]
```

**Forward pass.**

| Quantity | Arithmetic                                   | Value            |
| -------- | -------------------------------------------- | ---------------- |
| `z1_1`   | `0.15·0.05 + 0.20·0.10 + 0.35`               | `0.377500000000` |
| `z1_2`   | `0.25·0.05 + 0.30·0.10 + 0.35`               | `0.392500000000` |
| `a1_1`   | `σ(0.3775)`                                  | `0.593269992107` |
| `a1_2`   | `σ(0.3925)`                                  | `0.596884378260` |
| `z2`     | `0.40·0.593269992 + 0.45·0.596884378 + 0.60` | `1.105905967060` |
| `ŷ = a2` | `σ(1.105905967)`                             | `0.751365069552` |

**Loss.** With `y = 0.01`:

| Loss  | Formula                         | Value            |
| ----- | ------------------------------- | ---------------- |
| `mse` | `½(ŷ − y)²`                     | `0.274811083176` |
| `bce` | `−[y·ln ŷ + (1 − y)·ln(1 − ŷ)]` | `1.380710541466` |

**Backward pass (MSE).** The output delta is `δ = (ŷ − y)·σ'(z2) = (ŷ − y)·ŷ(1 − ŷ)`:

| Gradient | Formula                         | Value            |
| -------- | ------------------------------- | ---------------- |
| `δ_out`  | `0.741365070 × 0.186815602`     | `0.138498561629` |
| `∂L/∂w5` | `δ_out · a1_1`                  | `0.082167040564` |
| `∂L/∂w6` | `δ_out · a1_2`                  | `0.082667627848` |
| `∂L/∂b2` | `δ_out`                         | `0.138498561629` |
| `δ_h1`   | `δ_out · 0.40 · a1_1(1 − a1_1)` | `0.013367920423` |
| `δ_h2`   | `δ_out · 0.45 · a1_2(1 − a1_2)` | `0.014996075489` |
| `∂L/∂w1` | `δ_h1 · x1`                     | `0.000668396021` |
| `∂L/∂w2` | `δ_h1 · x2`                     | `0.001336792042` |
| `∂L/∂w3` | `δ_h2 · x1`                     | `0.000749803774` |
| `∂L/∂w4` | `δ_h2 · x2`                     | `0.001499607549` |

A gradient check on this network (central differences, `eps = 1e-5`) gives a maximum relative
error of about **7e-9** across all nine parameters.

```ts
import { backward, forward, gradientCheck, loss } from '@lab/nn-core';

const pass = forward(net, [0.05, 0.1]);
pass.output; // [0.751365069552...]
loss('mse', pass.output, [0.01]); // 0.274811083176...
backward(net, pass, [0.01], 'mse').dWeights[1][0][0]; // 0.082167040564...
gradientCheck(net, [0.05, 0.1], [0.01], 'mse').maxRelativeError; // ~7e-9
```

---

## `random.ts` — seeded PRNG

```ts
createRng(seed: number): Rng
DEFAULT_SEED = 42
```

`Rng` has `next()` (uniform in `[0, 1)`), `range(min, max)`, `int(maxExclusive)` and
`normal(mean = 0, stdDev = 1)`. The generator is **mulberry32** (32-bit state, three mixing
steps); normals come from Marsaglia's polar method with the second sample cached. It is _not_
cryptographically secure — never use it for tokens or passwords.

---

## `linalg.ts` — vectors and matrices

Row-major `number[][]`, so `m[row][col]`.

| Function                                                    | Notes                                             |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `zeros(n)`, `zerosMatrix(r, c)`                             | Fresh arrays; rows are never shared.              |
| `shape(m)` → `[rows, cols]`                                 | `[0, 0]` for an empty matrix.                     |
| `cloneMatrix(m)`                                            | Deep copy.                                        |
| `dot(a, b)`                                                 | Inner product.                                    |
| `add`, `subtract`, `scale`, `multiply`                      | Element-wise, returning new vectors.              |
| `addInPlace`, `scaleInPlace`                                | Mutate and return the target (gradient hot path). |
| `matVec(m, v)`, `matMul(a, b)`, `transpose(m)`              | Shape errors throw `RangeError`.                  |
| `outer(a, b)`                                               | `outer(δ, a)` is the shape of `∂L/∂W`.            |
| `sum`, `mean`, `norm`, `normalize`, `argMax`, `columnMeans` | Summaries.                                        |

---

## `activations.ts`

```ts
(sigmoid, sigmoidPrime, tanh, tanhPrime, relu, reluPrime, step, stepPrime);
(ACTIVATIONS, getActivation(kind), applyActivation(kind, zs), applyActivationDerivative(kind, zs));
softmax(scores);
```

**Every `*Prime` takes the pre-activation `z`, not the activation `a`.** So
`sigmoidPrime(z) = σ(z)(1 − σ(z))`. Backprop caches `z` per layer, and this convention keeps
`backward` free of special cases.

- `sigmoid` uses a two-branch form so neither `exp` call can overflow: `sigmoid(1000) === 1`,
  `sigmoid(-1000) === 0`, no `NaN`.
- `step` uses the `z >= 0 → 1` convention (the Module 1 quiz depends on it being stated).
- `stepPrime` is 0 everywhere — which is _why_ a perceptron needs its own update rule rather
  than gradient descent.
- `softmax` subtracts the maximum before exponentiating. That changes nothing mathematically
  and everything numerically: `softmax([1000, 1001, 1002])` works.

---

## `perceptron.ts` — Module 1

```ts
createPerceptron(inputSize, rng?): Perceptron   // { weights: number[], bias: number }
netInput(p, x): number                          // z = w·x + b
predict(p, x): 0 | 1                            // step(z), with z >= 0 → 1
trainStep(p, x, y, lr): boolean                 // true if an update happened
trainEpoch(p, dataset, lr): number              // misclassified count
accuracy(p, dataset): number
clone(p): Perceptron
decisionLine(p, xMin?, xMax?): DecisionLine
```

`trainStep` applies `w ← w + lr(y − ŷ)x`, `b ← b + lr(y − ŷ)` and returns `false` when the
prediction was already right — which is why a run over separable data eventually goes quiet.
`trainEpoch` returning 0 means the epoch ended with a separating line.

`decisionLine` is a discriminated union, because `w1·x1 + w2·x2 + b = 0` is not always a
function of `x1`:

```ts
{
  kind: 'sloped';
  slope;
  intercept;
  points: [Point, Point];
} // the usual case
{
  kind: 'vertical';
  x;
  points: [Point, Point];
} // w2 === 0
{
  kind: 'none';
} // both weights 0
```

Exported from the package root as `perceptronPredict`, `perceptronTrainStep`,
`perceptronTrainEpoch`, `perceptronAccuracy`, `perceptronNetInput`, `clonePerceptron`, or
unprefixed via the `perceptron` namespace.

---

## `mlp.ts` — Module 2

```ts
createMlp({ layerSizes: [2, 4, 1], hiddenActivation: 'tanh', outputActivation: 'sigmoid', seed: 42 })
forward(mlp, x): { output, zs, activations }
predict(mlp, x): number[]
loss(kind, output, target): number                  // 'mse' | 'bce'
lossGradient(kind, output, target): number[]
backward(mlp, cache, target, lossKind?): Gradients  // { dWeights, dBiases }; does NOT mutate
applyGradients(mlp, grads, lr): Mlp                 // mutates and returns mlp
trainStep(mlp, x, y, lr, lossKind?): number         // loss *before* the update
trainEpoch(mlp, dataset, lr, { batchSize?, loss? }): number  // mean loss over the epoch
datasetLoss(mlp, dataset, lossKind?): number
accuracy(mlp, dataset, threshold = 0.5): number
clone(mlp), countParameters(mlp), xavierLimit(fanIn, fanOut), zeroGradients(mlp)
addGradientsInPlace(a, b), scaleGradientsInPlace(g, s), toMlpDataset(points)
```

**Shapes.** `layers[l].weights[j][i]` connects input `i` to unit `j` of layer `l`.
`cache.activations[0]` is the input, so `cache.activations[l]` is the _input_ to layer `l` and
`cache.zs[l]` is that layer's pre-activation.

**Losses.** Both are averaged over the output units:
`mse = mean(½(ŷ − y)²)` and `bce = mean(−[y ln ŷ + (1 − y) ln(1 − ŷ)])`, with `ŷ` clamped to
`[1e-12, 1 − 1e-12]` so `ln` never returns `−Infinity`.

**Backprop.** `backward` applies the general chain rule — `lossGradient` then the activation
derivative — rather than hard-coding the famous `δ = ŷ − y` shortcut for sigmoid + BCE. That
costs a little precision and buys two things: loss and activation stay independent, and the
gradient check actually tests the chain rule instead of a special case. (The shortcut is still
visible: with sigmoid + BCE the output `δ` comes out equal to `(ŷ − y)/n`, asserted in
`test/mlp.forward.test.ts`.)

**Initialisation.** Xavier/Glorot uniform, `U(−limit, limit)` with `limit = √(6/(fanIn + fanOut))`,
drawn unit-major from the seeded `Rng`. Biases start at 0 — there is no symmetry to break in a
bias. Changing the draw order would change every seeded fixture in the tests.

**Batching.** `trainEpoch` walks the dataset **in the given order** with no internal shuffling:
shuffling needs a seeded `Rng` to stay reproducible, and a hidden `Math.random()` would make
every test flaky. `batchSize` defaults to 1 (pure SGD); `batchSize: dataset.length` gives
full-batch gradient descent. Gradients are averaged over the batch, so the effective step size
does not depend on batch size.

Exported from the package root as `mlpPredict`, `mlpTrainStep`, `mlpTrainEpoch`, `mlpAccuracy`,
`cloneMlp`, or unprefixed via the `mlp` namespace. `forward`, `backward`, `loss`,
`applyGradients` and friends keep their plain names.

---

## `gradcheck.ts` — Module 2, Lesson 2.4

```ts
gradientCheck(mlp, x, y, lossKind = 'mse', eps = 1e-5): GradCheckResult
relativeError(a, b): number
```

For every parameter it computes the central difference `(L(w + ε) − L(w − ε)) / 2ε` and compares
it with `backward`'s analytic gradient. Returns `{ maxRelativeError, worst, entries,
parameterCount, eps }`, where each entry names its parameter (`layer0.W[1][0]`, `layer1.b[0]`).

- **Central**, not forward, differences: error is `O(ε²)` instead of `O(ε)` for one extra
  forward pass.
- `ε = 1e-5` is the float64 sweet spot — larger and truncation error dominates, smaller and
  `L(w+ε) − L(w−ε)` loses its significant digits to cancellation.
- `relativeError` divides by `max(|a|, |b|, 1e-8)`; the floor keeps the ratio meaningful when
  both gradients are legitimately near zero.
- The model is **never modified**: probing happens on a deep copy.

Observed on the tested configurations (2-4-3-1, seed 42, both losses, sigmoid/tanh/relu hidden
layers): max relative error **≈ 5e-8**, comfortably under the 1e-6 gate.

---

## `datasets.ts`

```ts
(blobs(opts), diagonal(opts), xor(), xorNoisy(opts), circle(opts), moons(opts), spiral(opts));
makeDataset(kind, opts); // kind: DATASET_KINDS
```

Options are `{ n?, seed?, noise? }`; every generator returns `{ x: [x1, x2], y: 0 | 1 }[]` inside
roughly `[-1.6, 1.6]` on both axes. The difficulty ladder is the point:

| Dataset             | Needs                                                  |
| ------------------- | ------------------------------------------------------ |
| `diagonal`, `blobs` | Linearly separable — a single perceptron solves these. |
| `xor`               | Exactly 4 points, no randomness: the counter-example.  |
| `circle`, `moons`   | A curved boundary.                                     |
| `spiral`            | A wide network and patience.                           |

`diagonal` rejects points inside a margin band around `x2 = x1`, so 100 % accuracy is actually
attainable and the perceptron demo terminates.

---

## `bpe.ts` — Module 3, Lesson 3.1

```ts
trainBpe(corpus, numMerges): BpeModel   // { merges: [string, string][], vocab, tokenToId }
encode(model, text): number[]
encodeToTokens(model, text): string[]
decode(model, ids): string
tokensForIds(model, ids), detokenize(tokens), renderToken(token)
normalizeWhitespace(text), utf8Length(text), bytesPerToken(model, text)
END_OF_WORD = '</w>', UNKNOWN_TOKEN = '<unk>'
```

Design decisions worth knowing:

- **Word-based with an end-of-word marker.** Text is split on whitespace and each word gets
  `</w>` appended, so letters cannot merge across a word boundary and the decoder knows where the
  spaces go. Whitespace is normalised on the way in, so
  `decode(encode(t)) === normalizeWhitespace(t)`.
- **First-seen tie-breaking.** Pair counts live in a `Map`, whose insertion order is scan order,
  and the winner is chosen with a strict `>`. Equal counts therefore resolve to the pair seen
  first — which is what makes training deterministic.
- **Early stop.** Training halts once no pair occurs at least twice, so `merges.length` can be
  less than `numMerges` on a small corpus. Asking the reference corpus for 1000 merges yields 17.
- **Unknown characters** encode to `<unk>` (always id 0) and decode back as the literal text
  `<unk>`. Round-tripping is exact only for text whose characters appeared in the training
  corpus: `decode(encode(model, 'zebra'))` on a `low/lower/newest` corpus gives
  `'<unk>e<unk>r<unk>'`, because only `e` and `r` were ever seen.

```ts
const model = trainBpe('low low low lower lowest newest newest wider new', 10);
encodeToTokens(model, 'lowest newer'); // ['lo', 'west</w>', 'ne', 'we', 'r</w>']
```

---

## `attention.ts` — Module 3, Lesson 3.3

```ts
scaledDotProductAttention(Q, K, V, { scale = true, temperature = 1 });
// → { scores, weights, output }
softmaxRows(matrix, (temperature = 1));
```

`Attention(Q, K, V) = softmax(QKᵀ / √d_k)·V`. `Q` is `nQueries × d_k`, `K` is `nKeys × d_k`,
`V` is `nKeys × d_v`. `scores` are the dot products after the `√d_k` scaling and before the
softmax; every row of `weights` sums to 1 (to within 1e-12).

- `scale: false` shows what the scaling prevents: dot products grow with dimension, the softmax
  saturates into a one-hot row, and the gradient through it vanishes.
- `temperature < 1` sharpens the weights, `> 1` flattens them towards uniform. It changes
  `weights` but not `scores`.
- Identical keys ⇒ uniform weights ⇒ the output is just the mean of the value rows. Attention
  with nothing to distinguish its keys has no opinion.

---

## `pca.ts` — Module 3, Lesson 3.2

```ts
pca(data, k = 2, { maxIterations = 500, tolerance = 1e-12, seed = 7 }): PcaModel
  // → { components, mean, explained, eigenvalues }
project(model, data): number[][]
cosineSimilarity(a, b): number
```

Mean-centre → covariance (unbiased, `1/(n−1)`) → **power iteration** for the top eigenvector →
**deflate** by `λvvᵀ` → repeat. Power iteration is used instead of a full eigendecomposition
because it is ten lines, needs only matrix-vector products, and converges fast when you only want
the top two directions.

- Components are unit vectors, ordered by decreasing variance, with a **stable sign convention**
  (largest-magnitude entry forced positive) so the scatter plot does not flip between runs.
- Fewer than `k` components come back when the data has fewer dimensions or no variance left —
  a rank-1 matrix genuinely has only one direction, and `pca(rank1, 2).components.length === 1`.
- `explained[i]` is `eigenvalues[i] / trace(covariance)`.
- `cosineSimilarity` ignores magnitude, which is what embeddings want; it throws on the zero
  vector, which has no direction.

---

## Tests

`test/` mirrors `src/`, with the Module 2 flagship split out:

| File                    | Covers                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `random.test.ts`        | Determinism, ranges, a pinned mulberry32 sequence, normal moments.                 |
| `linalg.test.ts`        | Every helper and every shape error.                                                |
| `activations.test.ts`   | Known values, derivatives vs finite differences, softmax stability.                |
| `perceptron.test.ts`    | The quiz example, 100 % on `diagonal`, never 100 % on XOR.                         |
| `mlp.forward.test.ts`   | The worked example above, to 1e-9; losses; initialisation.                         |
| `mlp.gradcheck.test.ts` | **Max relative error < 1e-6** for mse/bce × sigmoid/tanh/relu.                     |
| `mlp.train.test.ts`     | XOR converges (< 0.05 in 47 epochs, seed 42); convex loss decreases monotonically. |
| `datasets.test.ts`      | Shape, seeding, labels and separability of all seven generators.                   |
| `bpe.test.ts`           | Determinism, round-trip, merge counts, unknown characters.                         |
| `attention.test.ts`     | Rows sum to 1, uniform for identical keys, scaling and temperature.                |
| `pca.test.ts`           | Rank-1 direction recovery, ordering, orthogonality, edge cases.                    |
| `index.test.ts`         | The public export surface.                                                         |

Coverage is gated at 90 % lines/functions/branches/statements in `vitest.config.ts`
(`docs/05-quality-and-ops.md`); the package currently sits at 100 %.
