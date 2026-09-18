---
slug: text-to-tokens-bpe
title: Text to tokens: byte-pair encoding
orderIndex: 1
estimatedMinutes: 12
---

# Text to tokens: byte-pair encoding

A model cannot read characters and it cannot afford a vocabulary of every word, so it
works with subwords. Byte-pair encoding finds them mechanically: start from single
characters, count every adjacent pair in the corpus, merge the most frequent pair into a
new symbol, and repeat a few thousand times. Common words end up as one token, rare ones
break into familiar pieces.

This explains several things that look like magic failures from the outside. A model
struggles to count the letters in "strawberry" because it never sees the letters -- it
sees two or three chunks, and the spelling is an inference, not a lookup. Unusual
formatting, long numbers, and non-English text all cost more tokens, which is to say they
cost more money and more of the context window.

The exercise trains BPE in your browser on a small corpus so you can watch the merge table
grow. Slide the merge count from 50 to 500 and the same sentence goes from a shower of
fragments to a handful of chunks: that slider is the whole tradeoff between vocabulary
size and sequence length.
