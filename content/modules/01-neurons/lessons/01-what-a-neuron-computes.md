---
slug: what-a-neuron-computes
title: What a neuron computes
orderIndex: 1
estimatedMinutes: 10
---

# What a neuron computes

A neuron takes a handful of numbers, multiplies each one by a weight, adds a bias, and pushes the
result through an activation function. That is the whole of it:

$$
z = \mathbf{w} \cdot \mathbf{x} + b = \sum_{i=1}^{n} w_i x_i + b,
\qquad
\hat{y} = f(z).
$$

The weights say how much each input matters and in which direction. A large positive $w_i$ means
"more of this input pushes the answer towards 1"; a negative one means the opposite; a weight near
zero means the neuron has learned to ignore that input. The bias $b$ shifts everything up or down
independently of any input — it is the neuron's opinion before it has seen anything.

## The geometry is the whole story

Set $n = 2$ so we can draw it. The set of points where the neuron is undecided,

$$
w_1 x_1 + w_2 x_2 + b = 0,
$$

is a straight line. Everything on one side gives $z > 0$, everything on the other gives $z < 0$.
So a neuron does not "recognise" anything; it splits the plane in two and reports which half a
point landed in.

Two facts about that line are worth carrying with you for the rest of the course:

1. **The weight vector $\mathbf{w}$ is perpendicular to the line, and points towards the positive
   side.** Rotating $\mathbf{w}$ rotates the boundary. In the exercise, the arrow drawn from the
   origin is $\mathbf{w}$; watch it stay at right angles to the line as you drag the sliders.
2. **The bias only slides the line.** Solving for $x_2$ gives
   $x_2 = -\frac{w_1}{w_2} x_1 - \frac{b}{w_2}$: the slope depends only on the ratio of the
   weights, the intercept only on $b$. Changing $b$ alone translates the boundary without turning
   it.

The perpendicular distance from a point to the boundary is $|z| / \lVert \mathbf{w} \rVert$, which
is a useful way to read the sign and the magnitude of $z$ at the same time: the sign is the
answer, the magnitude is the confidence.

## The activation decides what "output" means

The **step** function is the original choice and the one this module uses:

$$
\operatorname{step}(z) = \begin{cases} 1 & z \ge 0 \\ 0 & z < 0 \end{cases}
$$

Note the convention: $z = 0$ outputs 1. That boundary case is arbitrary, but it has to be written
down, because a point sitting exactly on the line has to go somewhere. The quiz asks about it.

The **sigmoid** $\sigma(z) = 1 / (1 + e^{-z})$ is the smooth version. It squashes any real number
into $(0, 1)$, so the output reads like a probability, and — the reason Module 2 cannot do without
it — it has a derivative everywhere: $\sigma'(z) = \sigma(z)\,(1 - \sigma(z))$. The step function's
derivative is zero everywhere it exists, which is exactly why a perceptron needs its own learning
rule instead of gradient descent.

A third framing that pays off later: with sigmoid, a single neuron _is_ logistic regression. The
machinery you are about to build is not a toy version of something real — it is the real thing,
with one unit.

> **Where is this in the code?**
> `packages/nn-core/src/perceptron.ts` — `netInput(p, x)` is the weighted sum, `predict(p, x)` is
> the step activation, and `decisionLine(p)` turns the weights into the two endpoints the canvas
> draws. The step convention lives in `packages/nn-core/src/activations.ts`.

## Try it before you read on

Open the exercise, pick the **blobs** dataset, and move the three sliders by hand until the line
separates the two colours. You are doing, slowly and badly, what the next lesson's learning rule
does quickly and automatically. Notice how hard it is to fix one misclassified point without
breaking another — that tension is what training resolves.
