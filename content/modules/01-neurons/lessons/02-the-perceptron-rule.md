---
slug: the-perceptron-rule
title: 'Learning by nudging: the perceptron rule'
orderIndex: 2
estimatedMinutes: 12
---

# Learning by nudging: the perceptron rule

Last lesson you moved the line by hand. Rosenblatt's 1958 rule moves it for you, and it is small
enough to write on a napkin. Show the neuron one example $(\mathbf{x}, y)$, let it guess
$\hat{y} = \operatorname{step}(\mathbf{w} \cdot \mathbf{x} + b)$, then update:

$$
\mathbf{w} \leftarrow \mathbf{w} + \eta\,(y - \hat{y})\,\mathbf{x},
\qquad
b \leftarrow b + \eta\,(y - \hat{y}).
$$

That is the entire algorithm. No loss function, no derivatives, no matrices.

## Read the three cases

The error term $(y - \hat{y})$ can only take three values, and each one has a plain meaning:

| $y$ | $\hat{y}$ | $y - \hat{y}$ | What happens                                   |
| --- | --------- | ------------- | ---------------------------------------------- |
| 1   | 1         | $0$           | Nothing. Correct answers produce no update.    |
| 0   | 0         | $0$           | Nothing.                                       |
| 1   | 0         | $+1$          | $\mathbf{w}$ moves **towards** $\mathbf{x}$.   |
| 0   | 1         | $-1$          | $\mathbf{w}$ moves **away from** $\mathbf{x}$. |

The "learns only from mistakes" property is worth pausing on. A run over separable data gets
quieter and quieter and then goes completely silent: once every point is on the right side, every
update is multiplied by zero and the weights stop moving. Silence is the stopping condition.

Why does moving $\mathbf{w}$ towards $\mathbf{x}$ help? Because $z = \mathbf{w} \cdot \mathbf{x} + b$,
so after the update the new net input for that same point is

$$
z' = z + \eta\,(y - \hat{y})\,(\lVert \mathbf{x} \rVert^2 + 1).
$$

For a false negative ($y - \hat{y} = +1$) that is strictly larger than $z$, and $\lVert \mathbf{x}
\rVert^2 + 1 > 0$ guarantees it. The update always moves the misclassified point in the direction
of being classified correctly. It may not get there in one step, and it may break a different
point on the way — but it never pushes the wrong way on the point it just saw.

## What the learning rate does

$\eta$ scales the nudge. It does **not** change which points are misclassified, and — a quirk
special to the perceptron — with zero-initialised weights it does not even change the sequence of
predictions, because scaling $\mathbf{w}$ and $b$ by the same positive constant leaves the sign of
$z$ alone. What it does change is the size of a correction relative to the weights you already
have. A large $\eta$ lets one noisy point throw the line across the plane; a small $\eta$ makes the
line inch, and needs more epochs. In the exercise, set $\eta = 1$ and single-step: one bad example
visibly tears the boundary around.

An **epoch** is one pass over every example. The perceptron convergence theorem says: if the data
can be separated by _some_ line, this rule finds _a_ separating line in a finite number of
mistakes — bounded by $(R/\gamma)^2$, where $R$ is the radius of the data and $\gamma$ is the
margin of the best separator. The intuition is enough here: a fat margin is easy and converges
fast, a thin one is slow, and the bound says nothing at all about data with no separating line.

## The wall: XOR

Here are four points. $(0,0) \to 0$, $(1,1) \to 0$, $(0,1) \to 1$, $(1,0) \to 1$. Try to draw one
straight line with the two 1s on one side. You cannot, and the proof is a line of algebra: a
separating line would need $b < 0$ and $w_1 + b \ge 0$ and $w_2 + b \ge 0$ — so
$w_1 + w_2 + 2b \ge 0$ — while also needing $w_1 + w_2 + b < 0$, which forces $b > 0$.
Contradiction.

So the rule does not converge, and it cannot tell you that. It will keep cycling forever, the line
flapping between configurations, accuracy bouncing around 50–75 %. Run the `try-xor` task for 20
epochs and watch: the failure mode of a learning algorithm is as informative as its success. This
is the wall that ended the first wave of neural network research in 1969, and Module 2 walks
straight through it by adding one hidden layer.

> **Where is this in the code?**
> `packages/nn-core/src/perceptron.ts` — `trainStep(p, x, y, lr)` is the update above and returns
> `false` when no update happened; `trainEpoch(p, dataset, lr)` loops it and returns the
> misclassified count, so a return value of `0` means the line separates the data.
