---
slug: text-to-tokens-bpe
title: Text to tokens: byte-pair encoding
orderIndex: 1
estimatedMinutes: 12
---

# Text to tokens: byte-pair encoding

A language model has a fixed vocabulary and a lookup table with one row per entry. That single
constraint rules out both obvious choices. **Characters** give a vocabulary of a hundred and
sequences ten times longer than they need to be, so every sentence burns ten times the attention
budget. **Words** give short sequences and a vocabulary with no bottom: proper nouns, typos,
inflections and every language that is not English keep arriving, and whatever you leave out
becomes a permanent blind spot.

Subwords are the compromise, and byte-pair encoding is the algorithm that finds them without
anyone choosing them.

## The training loop

Start with the alphabet. Then repeat, as many times as you have budget for:

1. Count every adjacent pair of symbols in the training corpus.
2. Take the most frequent pair and merge it into one new symbol.
3. Write that merge down.

That is the whole algorithm. Take `lower` and `lowest`, written out as symbols with an end-of-word
marker on the tail:

| Step          | `lower`          | `lowest`           | Merge learned |
| ------------- | ---------------- | ------------------ | ------------- |
| start         | `l o w e r </w>` | `l o w e s t </w>` | —             |
| after merge 1 | `lo w e r </w>`  | `lo w e s t </w>`  | `l` + `o`     |
| after merge 2 | `low e r </w>`   | `low e s t </w>`   | `lo` + `w`    |

The pair `l o` occurred twice; nothing else did more. Then `lo w` occurred twice. On a corpus this
small everything else occurs exactly once, so training stops: merging a pair seen once compresses
nothing and just memorises a word. Ask `nn-core` for 1000 merges on a nine-word corpus and you get
17 of them.

Two implementation details separate a tokenizer from a _reproducible_ one.

**The end-of-word marker.** Every word gets `</w>` appended before counting. Without it, the end
of one word could merge with the start of the next and the decoder would lose the spaces. With it,
`decode(encode(t))` returns `t` exactly, modulo whitespace, which is normalised on the way in.

**Ties go to the first pair seen.** Counts live in a `Map`, whose iteration order is scan order,
and the winner is picked with a strict `>`. Equal counts therefore resolve to whichever pair the
scan met first — which is the reason training the same corpus twice gives the same merge table,
and therefore the reason a test can assert on it.

## Encoding is a replay

Tokenizing new text is not a search. Split into words, split each word into characters, then apply
the learned merges **in the order they were learned**. Order is load-bearing: an early merge builds
the pieces a later one expects. Two tokenizers trained on the same corpus with 200 and 500 merges
are not one tokenizer with a bigger vocabulary; they are two different tokenizers that share a
prefix.

A character never seen in training has no symbol to start from, so it becomes `<unk>` — token id 0,
which exists in every model. This is why the third sample sentence in the exercise is expensive:
the corpus is prose, it contains no digits at all, and `1234567890` is ten consecutive unknowns.
Production tokenizers work on raw _bytes_ precisely so this cannot happen; nothing is ever unknown,
only expensive. This one works on characters so that you can see the failure instead of having it
hidden from you.

## What the slider is actually trading

The exercise trains on a 4,967-byte corpus about tokenizers. Move the merge slider and watch the
whole corpus re-tokenize:

| Merges requested | Merges learned | Vocabulary | Tokens for the corpus |
| ---------------- | -------------- | ---------- | --------------------- |
| 50               | 50             | 95         | 2,965                 |
| 200              | 200            | 245        | 1,925                 |
| 500              | 429            | 474        | 1,388                 |

Vocabulary up, sequence length down. That is the only trade there is, and every tokenizer in every
model is one particular answer to it. Notice that 500 requested yields 429 learned: the corpus ran
out of pairs worth merging.

Now tokenize the three sample sentences. The in-domain one collapses from 33 tokens to 13 as the
merges accumulate, because the merges were _fitted to this text_; the out-of-domain one barely
improves. Bytes per token makes it one number: about 4.9 for prose the tokenizer knows, about 1.3
for prose it does not. A tokenizer is a compressed portrait of its training data, which is why a
model trained mostly on English charges more per character for everything else.

And this is the real explanation for the model that cannot spell "strawberry". It never saw the
letters. It saw two or three chunks and has to infer the spelling from them. Rhyme, acrostics,
letter counting and reversal all live in that blind spot, and the cause is not intelligence and
not attention. It is the tokenizer.

> **Where is this in the code?**
> `packages/nn-core/src/bpe.ts` — `trainBpe(corpus, numMerges)` is the loop above,
> `encodeToTokens(model, text)` is the replay, and `bytesPerToken` is the stat. The `<unk>`
> behaviour and the first-seen tie-break are pinned by
> `packages/nn-core/test/bpe.test.ts`, which also asserts `decode(encode(x)) === x`. Training the
> whole corpus at 500 merges takes about 60 ms in a browser tab, which is why the slider can
> retrain live instead of shipping a precomputed table.
