---
slug: stacking-neurons
title: 'Stacking neurons: layers and hidden features'
orderIndex: 1
estimatedMinutes: 12
---

# Stacking neurons: layers and hidden features

Module 1 ended at a wall: one neuron draws one line, and XOR needs more than one line. The fix is
almost insultingly simple. Put two neurons side by side, feed both of them the same input, and let
a third neuron read their outputs.

## Solving XOR by hand

Here is a 2-2-1 network with weights chosen, not learned. The hidden units use a step activation
for now so we can do the arithmetic in our heads.

- Hidden unit $h_1$ is an **OR** detector: $w = (1, 1)$, $b = -0.5$. It fires when at least one
  input is 1.
- Hidden unit $h_2$ is an **AND** detector: $w = (1, 1)$, $b = -1.5$. It fires only when both are.
- The output unit computes $h_1 \text{ AND NOT } h_2$: $w = (1, -2)$, $b = -0.5$.

Trace all four inputs through it:

| $x_1$ | $x_2$ | $h_1$ (OR) | $h_2$ (AND) | $z_{out}$            | $\hat{y}$ | XOR |
| ----- | ----- | ---------- | ----------- | -------------------- | --------- | --- |
| 0     | 0     | 0          | 0           | $-0.5$               | 0         | 0   |
| 0     | 1     | 1          | 0           | $1 - 0 - 0.5 = 0.5$  | 1         | 1   |
| 1     | 0     | 1          | 0           | $0.5$                | 1         | 1   |
| 1     | 1     | 1          | 1           | $1 - 2 - 0.5 = -1.5$ | 0         | 0   |

Nine numbers, and the wall is gone. Notice what the network did _not_ do: it did not find a curved
boundary in the input space. It drew **two straight lines** — OR and AND — and then classified
points by which combination of sides they fell on. The region between the two parallel lines is
the XOR region. Curvature, when you see it in the exercise's heatmap, is always this: many straight
cuts, recombined.

## Hidden units are learned features

The word "hidden" only means "not observed at the boundary of the system" — hidden units are not
inputs and not outputs, so nothing outside the network ever sees them. What they actually are is
**features**: re-descriptions of the input that make the output layer's job easy.

In the hand-built network above, the features are "at least one input is on" and "both inputs are
on". The output layer is then a plain Module 1 perceptron operating in $(h_1, h_2)$ space, where
the four XOR points _are_ linearly separable. That is the trick in one sentence: **a hidden layer
bends the space until a line is enough.**

Nobody chose OR and AND when the network is trained rather than hand-set. Training discovers some
pair of lines that does the job, usually not the pair a human would pick, and often a rotated or
mirrored version. In the exercise, hit reset with a different seed and watch two different sets of
hidden weights solve the same problem. There is no canonical solution, only a family of them.

## Why the nonlinearity is not optional

Suppose the activation were the identity — just pass $z$ through. Then

$$
\mathbf{a}^{(2)} = W^{(2)}\left(W^{(1)}\mathbf{x} + \mathbf{b}^{(1)}\right) + \mathbf{b}^{(2)}
= \underbrace{\left(W^{(2)}W^{(1)}\right)}_{\text{one matrix}} \mathbf{x}
+ \underbrace{\left(W^{(2)}\mathbf{b}^{(1)} + \mathbf{b}^{(2)}\right)}_{\text{one vector}}.
$$

A composition of linear maps is a linear map. A hundred layers would collapse into a single
equivalent neuron, and you would be back at one line. **The nonlinearity between layers is the
only reason depth buys anything.**

Which nonlinearity? This module offers two:

- $\sigma(z) = 1/(1 + e^{-z})$, output in $(0,1)$, derivative $\sigma(z)(1-\sigma(z))$ — which
  peaks at $0.25$ and decays fast, so deep stacks of sigmoids starve the gradient.
- $\tanh(z)$, output in $(-1,1)$, derivative $1 - \tanh^2(z)$ — which peaks at $1$. Zero-centred
  outputs and a four-times-larger maximum slope usually make it train faster.

Try both on the spiral dataset and watch the loss curves. That difference is the first
hyperparameter in this course where you can see the mechanism, not just the result.

## Naming things

From here on, layers are numbered from 1 and superscripted: $W^{(l)}$ is layer $l$'s weight matrix,
$\mathbf{b}^{(l)}$ its biases, $\mathbf{a}^{(l)}$ its outputs, with $\mathbf{a}^{(0)} = \mathbf{x}$.
A "2-3-1 network" has 2 inputs, 3 hidden units, 1 output — and
$2 \times 3 + 3 + 3 \times 1 + 1 = 13$ parameters. The exercise prints that count; watch it grow
quadratically as you widen the hidden layer.

> **Where is this in the code?**
> `packages/nn-core/src/mlp.ts` — `createMlp({ layerSizes: [2, 3, 1] })` builds the object, and
> `layers[l].weights[j][i]` is the weight from input `i` into unit `j` of layer `l`. That index
> order (unit first) is the one the `NetworkGraph` iterates to draw its edges.
