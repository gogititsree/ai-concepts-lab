---
slug: attention
title: Attention: which words look at which
orderIndex: 3
estimatedMinutes: 15
---

# Attention: which words look at which

Embeddings give every token a vector, but the vector for `it` is the same vector in every sentence
ever written. Something has to mix in the context. Attention is that something, and it is one
equation:

$$
\text{Attention}(Q, K, V) = \text{softmax}\!\left(\frac{QK^{\top}}{\sqrt{d_k}}\right) V .
$$

Read it right to left. Each position emits three vectors, all three produced from its embedding by
learned matrices:

- a **query** $\mathbf{q}$ — what am I looking for?
- a **key** $\mathbf{k}$ — what do I offer to someone looking?
- a **value** $\mathbf{v}$ — what do I hand over if chosen?

Position $i$ dots its query against every key, turns the resulting row of scores into weights that
sum to one, and takes that weighted average of the value vectors. The output for a position is
therefore a blend of the whole sentence, mixed in proportion to relevance that the model itself
decided.

## A worked example you can check

Take the eight tokens a model has seen just before it predicts what comes after "it":

> the · cat · sat · on · the · mat · because · it

with $d_k = 3$. The three dimensions are hand-authored here to be legible: roughly _thing_,
_place_ and _glue_. The exercise ships exactly these numbers, so every figure below is on the
screen in the attention tab.

The query for `it` is $\mathbf{q}_8 = (2.4,\ 2.4,\ -0.8)$ — looking for something that is a thing
**and** a place, and actively uninterested in function words. The eight key vectors, dotted
against it:

| $i$ | word      | $\mathbf{k}_i$    | $\mathbf{q}_8 \cdot \mathbf{k}_i$ | $\div\sqrt{3}$ | $\exp$      | weight         |
| --- | --------- | ----------------- | --------------------------------- | -------------- | ----------- | -------------- |
| 1   | `the`     | `(0.1, 0.0, 1.0)` | `-0.56`                           | `-0.323316`    | `0.723745`  | `0.024925`     |
| 2   | `cat`     | `(1.0, 0.1, 0.0)` | `2.64`                            | `1.524205`     | `4.591491`  | `0.158129`     |
| 3   | `sat`     | `(0.2, 0.6, 0.1)` | `1.84`                            | `1.062324`     | `2.893088`  | `0.099636`     |
| 4   | `on`      | `(0.0, 0.9, 0.8)` | `1.52`                            | `0.877572`     | `2.405054`  | `0.082829`     |
| 5   | `the`     | `(0.1, 0.0, 1.0)` | `-0.56`                           | `-0.323316`    | `0.723745`  | `0.024925`     |
| 6   | `mat`     | `(0.9, 1.0, 0.0)` | `4.56`                            | `2.632717`     | `13.911519` | **`0.479105`** |
| 7   | `because` | `(0.0, 0.1, 0.9)` | `-0.48`                           | `-0.277128`    | `0.757957`  | `0.026104`     |
| 8   | `it`      | `(0.5, 0.4, 0.3)` | `1.92`                            | `1.108513`     | `3.029848`  | `0.104346`     |

The exponentials sum to `29.036448`; each weight is its own exponential over that sum, and the
eight weights sum to 1 by construction. `mat` takes 48 % of the row, `cat` 16 %. Multiply the
weights by the value rows and the output for `it` is `(0.524806, 0.566305, 0.096969)` — a vector
that is mostly `mat` with a splash of `cat`. The pronoun has been given content.

Two things to take from the table rather than from the formula. First, softmax is what guarantees
the row sums to one: it exponentiates (so everything is positive) and divides by the total. No
other step in the equation does that. Second, the row is **not** one-hot. Even the winner only
gets half, and that softness is the point — a mechanism that could attend to exactly one position
would be a lookup table.

## Why divide by $\sqrt{d_k}$

If the components of $\mathbf{q}$ and $\mathbf{k}$ are roughly independent with unit variance,
their dot product has variance $d_k$ and therefore a typical magnitude of $\sqrt{d_k}$. Scores
grow with the width of the model, purely as an accident of dimension. Push large numbers into a
softmax and it saturates: the biggest score takes nearly everything, the others get
$\approx 0$ — and the gradient through a saturated softmax is $\approx 0$ too, so the layer stops
learning.

Dividing by $\sqrt{d_k}$ cancels that growth and keeps the scores in a range where softmax still
has slope. Turn the toggle off in the exercise: `mat` goes from `0.479` to `0.741` and the four
function words fall under `0.005`. That is the saturation, in miniature, at $d_k = 3$. At
$d_k = 128$ it is not miniature.

The temperature slider is the same lever from the other side. Dividing the scores by $T$ before
the softmax sharpens the row when $T < 1$ and flattens it towards uniform when $T > 1$; at
$T = 2$ the `mat` weight falls back to `0.278`. It changes the weights and never the scores —
which is exactly the sampling temperature you will meet in Module 4, applied one layer earlier.

Try the edit-vectors mode: change $\mathbf{k}_6$, the key for `mat`, and watch its column move
while every row re-normalises. Nothing local happens in attention. Changing one key changes every
query's opinion of every other key, because they all share a denominator.

**Multi-head**, in one sentence: run several of these in parallel with different learned
projections, concatenate the outputs, and one head can track syntax while another tracks
coreference.

> **Where is this in the code?**
> `packages/nn-core/src/attention.ts` — `scaledDotProductAttention(Q, K, V, { scale, temperature })`
> returns `{ scores, weights, output }`, and every number in the table above is what it returns
> for the config in `content/modules/03-how-llms-work/exercises.json`.
> `packages/nn-core/test/attention.test.ts` asserts that rows sum to 1 within $10^{-12}$ and that
> identical keys give uniform weights — attention with nothing to distinguish its keys has no
> opinion.
