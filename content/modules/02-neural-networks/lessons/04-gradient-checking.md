---
slug: gradient-checking
title: 'Trust but verify: gradient checking'
orderIndex: 4
estimatedMinutes: 12
---

# Trust but verify: gradient checking

Backpropagation has a nasty property as software: **when it is wrong, it still works.** Flip a sign
in one layer, transpose the wrong matrix, forget a derivative factor — the loss will still go down,
just more slowly and to a worse place. There is no crash, no stack trace, no failing assertion.
You get a mediocre model and no reason to suspect the code.

So we check it against something that cannot be wrong for the same reasons.

## The definition, used literally

A derivative is a limit of a ratio, so approximate it with a finite $\varepsilon$:

$$
\frac{\partial L}{\partial w} \approx \frac{L(w + \varepsilon) - L(w - \varepsilon)}{2\varepsilon}.
$$

Nudge one parameter up, run the forward pass, record the loss. Nudge it down, run forward again,
record. Divide. Repeat for all nine (or ninety, or nine thousand) parameters. It is absurdly
slow — two forward passes **per parameter**, so it could never be a training algorithm — but it
uses nothing except `forward` and `loss`. It shares no code with `backward`, which is exactly what
makes it a witness rather than a mirror.

**Why the central difference?** The one-sided version $(L(w + \varepsilon) - L(w))/\varepsilon$
looks simpler and is much worse. Expand both in a Taylor series: the forward difference leaves an
error term proportional to $\varepsilon$, while the symmetric one cancels the second-order term and
leaves an error proportional to $\varepsilon^2$. At $\varepsilon = 10^{-5}$ that is the difference
between about $10^{-5}$ and $10^{-10}$ of truncation error — five orders of magnitude, for one
extra forward pass.

**Why $\varepsilon = 10^{-5}$?** Two errors fight each other. Truncation error shrinks as
$\varepsilon$ shrinks. Floating-point cancellation grows: $L(w+\varepsilon)$ and
$L(w-\varepsilon)$ are nearly equal numbers, and subtracting nearly equal float64 values throws
away significant digits. Around $10^{-5}$ the two curves cross. Try $10^{-12}$ and the check fails
loudly — not because backprop is wrong, but because the checker has become noise.

## Comparing the two answers

Absolute difference is the wrong comparison: a gradient of $10^{-9}$ and one of $10^{-3}$ deserve
different tolerances. Use relative error:

$$
\text{rel} = \frac{\lvert a - b \rvert}{\max(\lvert a \rvert, \lvert b \rvert, 10^{-8})}.
$$

The floor in the denominator keeps the ratio meaningful when both gradients are legitimately near
zero — without it, $10^{-18}$ versus $2 \times 10^{-18}$ reads as "100 % wrong".

Rules of thumb, and they are sharper than most in this field:

- $< 10^{-7}$: correct.
- $10^{-7}$ to $10^{-4}$: suspicious. Fine if you are using a kink like ReLU, where a parameter
  can sit near the non-differentiable point and the two sides genuinely disagree. Not fine
  otherwise.
- $> 10^{-3}$: there is a bug. Look at `entries` in the result — it names the worst parameter, like
  `layer0.W[1][0]`, and a pattern in _which_ parameters fail (one layer? only biases? only the
  output?) usually points straight at the line.

On the 2-4-3-1 network with seed 42, across both losses and sigmoid/tanh/relu hidden layers, the
observed maximum relative error is about $5 \times 10^{-8}$. The test gate is $10^{-6}$.

## This is the unit test for calculus

Here is the SDLC lesson of the module, and it generalises far past neural networks: you verified an
optimised implementation against a slow, obviously-correct one, on a fixed seed, with a numeric
tolerance. That is the pattern. It is how you test a cache against the uncached path, a query
against a full table scan, an incremental algorithm against a recomputation.

The bug this catches is not hypothetical. Every practitioner has shipped a transposed matrix, and
the ones who gradient-check found it in a minute instead of a fortnight.

> **Where is this in the code?**
> `packages/nn-core/src/gradcheck.ts` — `gradientCheck(mlp, x, y, lossKind, eps)` returns
> `{ maxRelativeError, worst, entries, parameterCount, eps }` and probes a deep copy so your model
> is never touched. The gate lives in `packages/nn-core/test/mlp.gradcheck.test.ts`, which is the
> flagship test of this whole repository.

> **What to measure**
> An MLP gives you four instruments. Learn to read them together, because any one of them alone
> will lie to you.
>
> - **Training loss per epoch.** The primary signal. Falling is good; flat-and-high means stuck;
>   spiking means the learning rate is too large. Plot it, always — a single final number hides
>   everything interesting.
> - **Accuracy.** What you actually care about, and a coarser instrument than loss: it can sit
>   still for fifty epochs while the loss quietly improves, because nothing crossed the 0.5
>   threshold yet.
> - **Gradient magnitude per layer.** The exercise's edge widths are this. Early-layer gradients
>   orders of magnitude below late-layer ones is the vanishing gradient, and it is a _diagnosis_,
>   not a mood.
> - **Max relative error from the gradient check.** The only one that is pass/fail. Run it on a
>   fixed seed in CI; if it ever moves, your maths changed.
>
> And one number that is not on the screen: **parameter count**. It is the capacity you are
> spending. `circle` needs a hidden size of three or four; spending sixteen on it is how you learn
> what overfitting feels like.
