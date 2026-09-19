---
slug: from-attention-to-an-llm
title: From attention to an LLM
orderIndex: 4
estimatedMinutes: 14
---

# From attention to an LLM

You have three pieces: text becomes tokens, tokens become vectors, attention mixes the vectors by
relevance. This lesson is the assembly diagram — what surrounds attention to make a language
model, and what that model is trained to do.

## The transformer block

A block takes a sequence of vectors and returns a sequence of the same shape. That
shape-preservation is what makes stacking possible. Inside, two sublayers:

$$
\mathbf{h} = \mathbf{x} + \text{Attention}(\text{LN}(\mathbf{x})), \qquad
\mathbf{y} = \mathbf{h} + \text{MLP}(\text{LN}(\mathbf{h})).
$$

**Attention** mixes _across positions_ — the only part of the architecture that does. **The MLP**
is the Module 2 network applied to each position independently: one hidden layer, usually four
times as wide, a nonlinearity, back down. Attention decides what to read; the MLP decides what to
think about it.

The two `+` signs are **residual connections**, and they are load-bearing. Each sublayer writes a
_correction_ onto a running representation instead of replacing it, so the gradient has a direct
path from the loss back to layer one; without them the vanishing gradient you watched on the edge
widths in Module 2 makes an 80-layer stack untrainable. **Layer normalisation** rescales each
vector to zero mean and unit variance before each sublayer, keeping the numbers where the
nonlinearities and the softmax still have slope — the same concern as $\sqrt{d_k}$, one level up.

Then you stack it: a dozen blocks in a small model, eighty in a large one. Every layer is the same
shape, so depth is a hyperparameter rather than a redesign.

## Position, because attention has none

Ask where word order enters the attention equation. It does not. Shuffle the tokens and the set of
scores is the same set, permuted. Attention is a function on a _bag_ of vectors.

So position is added explicitly: the original transformer added fixed sine waves to the
embeddings, while modern models more often rotate the query and key vectors by an angle
proportional to position (RoPE), making the dot product depend on the _distance_ between two
tokens. Either way, order is data you inject, not structure you get free.

## What it is trained to do

One objective: **predict the next token**. The final vector at each position goes through a linear
layer with one output per vocabulary entry, softmax turns those logits into a distribution, and
the loss is Module 2's cross-entropy — now over 50,000 classes instead of two. Every position in
every training document is a labelled example, which is why the training signal is free.

Generation is that forward pass in a loop: run the context, get a distribution, pick one token,
append it, run again. Picking is where **temperature** returns. Dividing the logits by $T$ before
the softmax is the identical operation you moved with the slider last lesson: $T \to 0$ is greedy
and repetitive, $T = 1$ is the model's own distribution, high $T$ is flat and incoherent.

So an LLM is not a database and does not "look things up". It is a next-token distribution,
sampled repeatedly. Fluent wrong answers are not a bug in the retrieval; there is no retrieval.

## The context window

Attention scores every query against every key, so an $n$-token sequence costs $n^2$. Eight tokens
is 64 scores — the grid in the exercise. Eight thousand is 64 million, per layer, per head. That
quadratic is the real reason the window is finite, and it is measured in **tokens**, which loops
back to Lesson 3.1: the tokenizer decides how much text fits.

Everything outside the window does not exist to the model. Not "is forgotten" — never existed. The
context is the entire working memory, and deciding what goes into it is Module 6's subject.

> **Where is this in the code?**
> The mixing step is `packages/nn-core/src/attention.ts`, the per-position MLP is
> `packages/nn-core/src/mlp.ts` from Module 2, and the final softmax is the same stable `softmax`
> in `packages/nn-core/src/activations.ts` that normalises each attention row. This app never
> trains a transformer — that is a GPU-week, not a browser tab — but every component above is a
> file here, and the sampling loop arrives in Module 4 as `POST /api/v1/model/chat`.

> **What to measure**
> Once a real model is running, four numbers tell you almost everything. Watch them together;
> each alone will mislead you.
>
> - **Tokens in and tokens out, per call.** The unit of cost, latency and context. Input tokens are
>   processed in parallel, output tokens one at a time, so 200 in and 800 out is a far slower call
>   than 800 in and 200 out.
> - **Bytes per token on your own text.** From Lesson 3.1. Near 4 is the tokenizer's comfort zone;
>   near 1.5 you are paying triple, and reformatting is cheaper than a bigger model.
> - **Context utilisation.** Prompt tokens over window size. Crossing it does not degrade
>   gracefully: the call fails, or the front of the conversation silently disappears.
> - **Time to first token versus tokens per second.** The first measures the prompt pass and the
>   queue, the second generation. A slow app is one or the other, and the fix differs.
>
> M9 turns these into Prometheus metrics and puts them on a dashboard. Reading them here first, on
> numbers you computed by hand, is why they will mean something there.
