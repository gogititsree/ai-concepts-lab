---
slug: the-forward-pass
title: The forward pass as a computation graph
orderIndex: 2
estimatedMinutes: 14
---

# The forward pass as a computation graph

A network's forward pass is two lines of notation repeated once per layer:

$$
\mathbf{z}^{(l)} = W^{(l)} \mathbf{a}^{(l-1)} + \mathbf{b}^{(l)},
\qquad
\mathbf{a}^{(l)} = \sigma\!\left(\mathbf{z}^{(l)}\right),
\qquad
\mathbf{a}^{(0)} = \mathbf{x}.
$$

Read it as a **computation graph**: every $z$ and every $a$ is a node, every weight is an edge, and
the arrows only point forwards. Backpropagation, next lesson, is the same graph walked in reverse.
Get comfortable with the nodes now and the reverse walk costs you nothing.

## The worked example

This is the network Lesson 2.2 and the exercise share, and it is asserted to $10^{-9}$ in
`packages/nn-core/test/mlp.forward.test.ts`. If this page and the code ever disagree, that test
goes red. A 2-2-1 network, sigmoid everywhere:

$$
W^{(1)} = \begin{bmatrix} 0.15 & 0.20 \\ 0.25 & 0.30 \end{bmatrix},
\quad \mathbf{b}^{(1)} = \begin{bmatrix} 0.35 \\ 0.35 \end{bmatrix},
\quad W^{(2)} = \begin{bmatrix} 0.40 & 0.45 \end{bmatrix},
\quad \mathbf{b}^{(2)} = \begin{bmatrix} 0.60 \end{bmatrix},
$$

with input $\mathbf{x} = (0.05,\ 0.10)$ and target $y = 0.01$.

**Layer 1.** Each hidden unit is a Module 1 neuron:

| Quantity    | Arithmetic                     | Value            |
| ----------- | ------------------------------ | ---------------- |
| $z^{(1)}_1$ | `0.15*0.05 + 0.20*0.10 + 0.35` | `0.377500000000` |
| $z^{(1)}_2$ | `0.25*0.05 + 0.30*0.10 + 0.35` | `0.392500000000` |
| $a^{(1)}_1$ | `sigmoid(0.3775)`              | `0.593269992107` |
| $a^{(1)}_2$ | `sigmoid(0.3925)`              | `0.596884378260` |

**Layer 2.** The output unit reads the hidden activations, not the input:

| Quantity            | Arithmetic                                   | Value            |
| ------------------- | -------------------------------------------- | ---------------- |
| $z^{(2)}$           | `0.40*0.593269992 + 0.45*0.596884378 + 0.60` | `1.105905967060` |
| $\hat{y} = a^{(2)}$ | `sigmoid(1.105905967)`                       | `0.751365069552` |

Two things to notice in those numbers. First, the bias dominates: $0.35$ against contributions of
about $0.028$, so both hidden units sit close to $\sigma(0.38) \approx 0.59$ — barely
distinguishable from each other. An untrained network is mush, and the interesting question is how
it gets un-mushed. Second, $\hat{y} = 0.75$ while the target is $0.01$. This network is confidently
wrong, which is the most useful state to start a gradient from.

## Measuring the wrongness

A loss turns the gap between $\hat{y}$ and $y$ into one number to minimise. Both losses in
`nn-core` are averaged over the output units:

$$
L_{\text{mse}} = \frac{1}{n}\sum_j \tfrac{1}{2}\left(\hat{y}_j - y_j\right)^2,
\qquad
L_{\text{bce}} = -\frac{1}{n}\sum_j \left[ y_j \ln \hat{y}_j + (1 - y_j)\ln(1 - \hat{y}_j) \right].
$$

On this example, with $n = 1$:

| Loss  | Formula                               | Value            |
| ----- | ------------------------------------- | ---------------- |
| `mse` | `0.5 * (0.751365070 - 0.01)^2`        | `0.274811083176` |
| `bce` | `-[y ln yhat + (1 - y) ln(1 - yhat)]` | `1.380710541466` |

The factor of $\tfrac12$ in MSE exists so its derivative is exactly $(\hat{y} - y)$, with no
stray 2. That is the only reason, and it is a good one: it makes the next lesson's algebra
readable.

Why two losses? MSE treats the output as a number and punishes being wrong by the square of the
gap. Cross-entropy treats it as a probability and punishes **confident** wrongness without
bound — as $\hat{y} \to 0$ with $y = 1$, the loss goes to infinity. For classification, BCE's
larger gradients when you are badly wrong mean faster escape from a bad start. Here the same
prediction scores $0.27$ under MSE and $1.38$ under BCE; the two losses disagree about how bad
$0.75$-instead-of-$0.01$ really is, and the gradient inherits that disagreement.

Cross-entropy needs one numerical guard: $\ln(0)$ is $-\infty$, so `nn-core` clamps $\hat{y}$ into
$[10^{-12},\ 1 - 10^{-12}]$ before taking the logarithm. Unguarded, one saturated sigmoid poisons
the whole training run with `NaN` — a bug that looks like a maths failure and is really a
floating-point one.

## What the cache is for

`forward` in `nn-core` does not just return $\hat{y}$; it returns
`{ output, zs, activations }`. That is not an optimisation, it is a requirement. Backprop needs
$a^{(l-1)}$ to form $\partial L/\partial W^{(l)}$ and needs $z^{(l)}$ to evaluate the activation's
derivative. **Every derivative caches a pre-activation.** Note the convention:
`activations[0]` is the input, so `activations[l]` is the _input_ to layer `l` and `zs[l]` is that
layer's pre-activation.

> **Where is this in the code?**
> `packages/nn-core/src/mlp.ts` — `forward(mlp, x)` returns the cache above, `loss(kind, output,
target)` computes both losses, and `packages/nn-core/test/mlp.forward.test.ts` pins every number
> on this page. Click "forward one example" in the exercise to watch the same values light up node
> by node.
