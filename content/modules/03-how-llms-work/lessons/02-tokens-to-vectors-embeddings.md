---
slug: tokens-to-vectors-embeddings
title: Tokens to vectors: embeddings
orderIndex: 2
estimatedMinutes: 13
---

# Tokens to vectors: embeddings

A token is an integer, and an integer is a terrible thing to do arithmetic on. Token 4,182 is not
"more" than token 91, and it is not two thousand times token 2. The id is an address, not a
quantity. So the first layer of every language model is a lookup table: one row of real numbers
per vocabulary entry, learned along with everything else. That row is the token's **embedding**.

## One-hot, and why nobody stops there

The honest way to feed a category to a matrix is one-hot: a vector of zeros with a single 1 at the
token's index. It works, and it has two fatal properties. It is enormous — one dimension per
vocabulary entry, fifty thousand of them — and every pair of distinct tokens is exactly as
dissimilar as every other pair. `cat` and `dog` are as far apart as `cat` and `semicolon`.

Now notice what a matrix does to a one-hot vector: $W\mathbf{e}_i$ is just column $i$ of $W$.
Multiplying by a one-hot _is_ a table lookup. So the "first layer" and the "embedding table" are
the same object seen twice, and the only question left is how wide to make it. A few hundred
dimensions is enough, they are dense rather than mostly zero, and — the whole point — they are
learned, so similar tokens can end up near each other.

## Similarity is an angle

Near each other in what sense? Dot product is the raw ingredient:

$$
\mathbf{a} \cdot \mathbf{b} = \sum_i a_i b_i = \lVert\mathbf{a}\rVert\,\lVert\mathbf{b}\rVert\cos\theta .
$$

But dot product rewards length, and an embedding's length mostly encodes how often the token
appears, which is not what you want to ask about. Divide it out and you get **cosine similarity**:

$$
\text{cos}(\mathbf{a}, \mathbf{b}) =
\frac{\mathbf{a} \cdot \mathbf{b}}{\lVert\mathbf{a}\rVert\,\lVert\mathbf{b}\rVert} \in [-1, 1].
$$

One means the same direction, zero means unrelated, negative means opposed. Identical vectors give
exactly 1, which is the quickest sanity check there is on an embedding pipeline. The zero vector
has no direction at all, so `nn-core` throws rather than returning a number that would quietly be
`NaN`.

In the exercise, click two words and read the cosine. With the shipped vectors, `wolf` and `dog`
sit at 0.72, `dog` and `horse` at 0.69, `write` and `read` at 0.66 — and `salmon` is nearer to
`swim` (0.54) than to most of the other animals, which tells you something true about how these
vectors were made. Nothing taught the model that wolves are like dogs. It read a lot of text in
which they appeared in similar places.

## Analogies, and the honest version of them

The famous demonstration is vector arithmetic: $\mathbf{king} - \mathbf{man} + \mathbf{woman}$
lands nearest to `queen`. It genuinely works here — cosine 0.79 against the shipped vectors, with
`princess` a distant second at 0.65 — and you can type your own triples into the exercise.

It is also oversold, and knowing why is more useful than the trick. The candidate list excludes
the three input words, and without that exclusion the nearest neighbour is very often just `king`
again. It works best on relations that are densely attested in text (royalty, capitals, plurals)
and falls apart elsewhere: try `france - germany + japan` and the shipped vectors return `canada`
at a limp 0.40. There is no "gender direction" stored anywhere; there is a cloud of co-occurrence
statistics that sometimes happens to be linear.

## Squashing 768 numbers onto a page

The exercise's vectors come from `nomic-embed-text`, which produces 768 dimensions. A screen has
two. **PCA** picks the two directions along which the data varies most and projects onto them:
mean-centre, build the covariance matrix, find its top eigenvector by power iteration, subtract
that direction out, and find the next one.

Be honest about what survives. For these 42 words the first two components explain about 8.4 %
and 7.1 % of the variance — roughly **15 % of the picture**. The clusters you can see are real,
but two words that look adjacent on the scatter may be far apart in the other 766 dimensions.
Always read the cosine, which uses the full vector, rather than the distance on screen.

One implementation note that matters for a picture: an eigenvector is only defined up to sign, so
a naive PCA flips the scatter left-to-right between runs. `nn-core` forces the largest-magnitude
entry of each component positive, and the plot stops jumping.

> **Where is this in the code?**
> `packages/nn-core/src/pca.ts` — `pca(data, 2)` runs power iteration with deflation,
> `project(model, data)` applies it, and `cosineSimilarity(a, b)` is the readout under the
> scatter. `packages/nn-core/test/pca.test.ts` proves it recovers the direction of a rank-1
> matrix. The vectors themselves come from `POST /api/v1/model/embed` when Ollama is reachable
> and from `content/modules/03-how-llms-work/embeddings-precomputed.json` otherwise; the tab
> says which. That file is regenerated by `pnpm content:embeddings`
> (`apps/api/scripts/generate-embeddings.mjs`).
