---
slug: reading-the-code
title: Reading the code
orderIndex: 3
estimatedMinutes: 10
---

# Reading the code

`packages/nn-core/src/perceptron.ts` is about forty lines of TypeScript and it contains everything
in this module. Open it next to this page. The point of the lesson is not the syntax — it is that
the file and the test file say the same thing twice, once as instructions and once as claims.

## The data

```ts
interface Perceptron {
  weights: number[];
  bias: number;
}
```

No class, no `train()` method, no hidden state. A model is a plain object, which means it drops
straight into a Zustand store, survives `JSON.stringify` into the database, and comes back without
a revival step. Every function in the file takes the model as its first argument. That is a
deliberate constraint across the whole package: **plain data, free functions**.

## The four functions

`netInput(p, x)` returns $\mathbf{w} \cdot \mathbf{x} + b$. `predict(p, x)` applies the step
convention $z \ge 0 \rightarrow 1$. `trainStep(p, x, y, lr)` is the rule from Lesson 2 — note that
it returns a boolean, `true` only when the weights actually moved, which is how the caller detects
"this epoch was quiet". `trainEpoch(p, dataset, lr)` walks the dataset **in the given order** and
returns how many examples were misclassified when they were seen.

Two design decisions hide in there, and both are the kind of thing that is invisible until it
bites:

- **`trainStep` mutates `p`.** For a 3-parameter model in an animation loop that is the right
  call — no allocation per step. The price is that `clone(p)` exists, and you must call it if you
  want a "before" snapshot. Explicit sharing beats accidental sharing.
- **No shuffling.** Shuffling needs a seeded random number generator to stay reproducible, and a
  silent `Math.random()` inside a training loop makes every test flaky. The caller shuffles, with
  a seed, or does not shuffle at all.

`decisionLine(p)` is the one function that exists purely for the visualisation, and it returns a
discriminated union rather than a slope and an intercept:

```ts
type DecisionLine =
  | { kind: 'sloped'; slope: number; intercept: number; points: [Point, Point] }
  | { kind: 'vertical'; x: number; points: [Point, Point] }
  | { kind: 'none' };
```

Because $w_1 x_1 + w_2 x_2 + b = 0$ is not always a function of $x_1$. When $w_2 = 0$ the line is
vertical and the slope is infinite; when both weights are zero there is no line at all. The type
forces the canvas code to handle all three, at compile time, instead of quietly drawing a
`NaN`-coordinate line that never appears and takes an hour to debug.

## The test is the other half

`packages/nn-core/test/perceptron.test.ts` asserts three things that are really the module's
three claims:

1. The quiz example: $\mathbf{w} = (2, -1)$, $b = -1$, $\mathbf{x} = (1,1)$ gives $z = 0$ and
   output 1. A single assertion pins the boundary convention forever.
2. Training reaches 100 % accuracy on `diagonal`, a separable dataset.
3. Training **never** reaches 100 % on XOR, however many epochs it runs.

That third test is unusual and worth noticing: it asserts a limitation. Most test suites only
check that things work. Pinning the failure is what stops someone "fixing" the perceptron later by
quietly adding a hidden layer and breaking the pedagogy. A test can encode intent, not just
behaviour.

Run them yourself:

```bash
pnpm --filter @lab/nn-core test
```

> **Where is this in the code?**
> `packages/nn-core/src/perceptron.ts` and its neighbour `packages/nn-core/test/perceptron.test.ts`.
> The browser imports the first one directly — the code that draws your decision line is the code
> those tests prove correct. There is no second implementation.

> **What to measure**
> Every module ends with this box, because "does it work?" is a question with numbers in it. For a
> perceptron, watch three:
>
> - **Accuracy** — the fraction classified correctly. It is the headline, and it is not enough on
>   its own: 95 % is excellent on balanced blobs and useless on data that is 95 % one class.
> - **Misclassified per epoch** (`trainEpoch`'s return value) — the learning curve. On separable
>   data it should trend to zero and stay there. A flat non-zero line means it is cycling.
> - **Epochs to convergence** — how long the answer took. Halve the learning rate and watch this
>   number move; that is a dose–response experiment on a hyperparameter.
>
> The habit generalises. In Module 5 the same instinct becomes tool-call parse-failure rate, and in
> the SRE milestones it becomes an SLO. Pick the number that would tell you first that something
> broke, and put it on the screen.
