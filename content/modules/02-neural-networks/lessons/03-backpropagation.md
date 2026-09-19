---
slug: backpropagation
title: Backpropagation
orderIndex: 3
estimatedMinutes: 15
---

# Backpropagation

Backpropagation has a reputation it does not deserve. It is the chain rule, applied to the graph
from the last lesson, with the intermediate results written down instead of recomputed. That is
the entire idea: **bookkeeping, not magic.**

## One quantity does all the work

Define the **delta** of a layer as the sensitivity of the loss to that layer's pre-activation:

$$
\boldsymbol{\delta}^{(l)} = \frac{\partial L}{\partial \mathbf{z}^{(l)}}.
$$

Once you have $\boldsymbol{\delta}^{(l)}$, the gradients for that layer's parameters are immediate:

$$
\frac{\partial L}{\partial W^{(l)}} = \boldsymbol{\delta}^{(l)} \left(\mathbf{a}^{(l-1)}\right)^{\!\top},
\qquad
\frac{\partial L}{\partial \mathbf{b}^{(l)}} = \boldsymbol{\delta}^{(l)}.
$$

Read the first one in words: **the gradient of a weight is the delta at the end of the edge times
the activation at its start.** An edge is blamed in proportion to how loudly its input was talking
and how wrong its destination was. That sentence is worth more than the notation.

Two steps produce the deltas. At the output layer,

$$
\boldsymbol{\delta}^{(L)} = \nabla_{\hat{\mathbf{y}}} L \odot \sigma'\!\left(\mathbf{z}^{(L)}\right),
$$

and then, walking backwards,

$$
\boldsymbol{\delta}^{(l)} = \left(W^{(l+1)}\right)^{\!\top} \boldsymbol{\delta}^{(l+1)} \odot \sigma'\!\left(\mathbf{z}^{(l)}\right).
$$

The transpose is the forward pass running in reverse: forwards, $W$ sends activations from layer
$l$ to layer $l+1$; backwards, $W^\top$ sends blame from $l+1$ back to $l$, along the same edges
with the same weights. A big weight carried a lot of signal forwards and therefore receives a lot
of blame backwards.

## The same worked example, backwards

Continuing Lesson 2.2's network ($\hat{y} = 0.751365069552$, $y = 0.01$, MSE), the output delta is
$\delta = (\hat{y} - y)\,\hat{y}(1 - \hat{y})$:

| Gradient                      | Formula                             | Value            |
| ----------------------------- | ----------------------------------- | ---------------- |
| $\delta_{out}$                | `0.741365070 * 0.186815602`         | `0.138498561629` |
| $\partial L/\partial w_5$     | `delta_out * a1_1`                  | `0.082167040564` |
| $\partial L/\partial w_6$     | `delta_out * a1_2`                  | `0.082667627848` |
| $\partial L/\partial b^{(2)}$ | `delta_out`                         | `0.138498561629` |
| $\delta_{h_1}$                | `delta_out * 0.40 * a1_1(1 - a1_1)` | `0.013367920423` |
| $\delta_{h_2}$                | `delta_out * 0.45 * a1_2(1 - a1_2)` | `0.014996075489` |
| $\partial L/\partial w_1$     | `delta_h1 * x1`                     | `0.000668396021` |
| $\partial L/\partial w_2$     | `delta_h1 * x2`                     | `0.001336792042` |
| $\partial L/\partial w_3$     | `delta_h2 * x1`                     | `0.000749803774` |
| $\partial L/\partial w_4$     | `delta_h2 * x2`                     | `0.001499607549` |

Stare at the magnitudes. The output weights get gradients around $0.08$; the input weights get
gradients around $0.001$ — **a hundred times smaller**, after crossing a single layer. Two
multiplications did that: $\sigma' \le 0.25$ once, and a weight of $0.4$ once. This is the vanishing
gradient, visible in a two-layer network with honest numbers, and it is why early layers learn
slowly and why the exercise's edge animation shows near-invisible strokes on the left.

Also notice the inputs are $0.05$ and $0.10$, so $\partial L/\partial w_2$ is exactly twice
$\partial L/\partial w_1$. An input that is twice as loud takes twice the blame. Feature scaling
stops being folklore once you have seen that.

## From gradients to a step

The gradient points uphill, so go the other way:

$$
W^{(l)} \leftarrow W^{(l)} - \eta \frac{\partial L}{\partial W^{(l)}}.
$$

With $\eta = 0.5$, $w_5$ moves from $0.40$ to $0.40 - 0.5 \times 0.082167 = 0.358917$. One example,
one small correction. Repeat for every example (an **epoch**), repeat for hundreds of epochs, and
the loss curve in the exercise slides down.

Three knobs matter and all three are in the exercise:

- **Learning rate.** Too small and you crawl; too large and you overshoot the valley and the loss
  climbs or oscillates. Set $\eta = 10$ on XOR and watch a network destroy itself in four epochs —
  the boundary heatmap goes flat as every sigmoid saturates.
- **Epochs.** The loss curve is your instrument: flat-and-high means stuck (try a different seed or
  a wider layer), noisy-and-falling is healthy, flat-and-low means done.
- **Batch size.** `trainEpoch` defaults to `batchSize: 1` — update after every example, which is
  noisy and fast. Full batch averages every gradient before stepping: smooth, slow, and more
  parallel. Gradients are averaged over the batch, so the step size does not silently change when
  you change the batch size.

One deliberate choice in the code: `backward` applies the general chain rule — loss gradient, then
activation derivative — instead of hard-coding the famous $\delta = \hat{y} - y$ shortcut that
sigmoid-plus-cross-entropy allows. It costs a little precision and buys the ability to swap loss
and activation independently, and it means the gradient check in the next lesson tests the chain
rule rather than a special case.

> **Where is this in the code?**
> `packages/nn-core/src/mlp.ts` — `backward(mlp, cache, target, lossKind)` returns
> `{ dWeights, dBiases }` and **does not mutate the model**; `applyGradients(mlp, grads, lr)` takes
> the step. The separation is what lets the exercise show you a gradient before deciding whether to
> apply it.
