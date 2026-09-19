import { describe, expect, it } from 'vitest';

import {
  AttentionConfigSchema,
  EmbeddingsConfigSchema,
  ExercisesFileSchema,
  PrecomputedEmbeddingsSchema,
  TokenizerConfigSchema,
  TokenizerTabConfigSchema,
} from '../src/content.js';

/**
 * Module 3's config is the largest hand-authored blob in `content/`, and almost every
 * field is a promise the React tabs rely on: that `Q` and `K` are `dk` wide, that the
 * task answers refer to things that exist, that the analogy's three words are plotted.
 * These tests are the enforcement, and they run at seed time too — `ExerciseFileEntrySchema`
 * re-validates `config` through the per-kind schema.
 */

const tokenizerTab = {
  corpusFile: 'corpus.txt',
  mergeRange: [50, 500],
  defaultMerges: 200,
  defaultText: 'tokens are the unit of money',
  sampleSentences: [
    { id: 'in-domain', text: 'the tokenizer counted every pair' },
    { id: 'out-of-domain', text: 'zebras waltz quixotically' },
    { id: 'digits-and-symbols', text: 'costs 1234567890 dollars' },
  ],
};

const embeddingsTab = {
  fallbackFile: 'embeddings-precomputed.json',
  defaultAnalogy: { a: 'king', b: 'man', c: 'woman' },
  words: [
    { word: 'king', cluster: 'people' },
    { word: 'queen', cluster: 'people' },
    { word: 'man', cluster: 'people' },
    { word: 'woman', cluster: 'people' },
    { word: 'cat', cluster: 'animals' },
    { word: 'dog', cluster: 'animals' },
    { word: 'wolf', cluster: 'animals' },
  ],
};

const attentionTab = {
  words: ['the', 'cat', 'sat'],
  dk: 2,
  Q: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  K: [
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  V: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

const config = {
  tabs: ['tokenizer', 'embeddings', 'attention'],
  tokenizer: tokenizerTab,
  embeddings: embeddingsTab,
  attention: attentionTab,
  tasks: [
    {
      id: 'tokenize-three',
      label: 'Tokenize all three',
      check: { kind: 'tokenize', sentencesTokenized: 3, answerSentenceId: 'digits-and-symbols' },
    },
    {
      id: 'find-neighbour',
      label: 'Nearest to wolf',
      check: { kind: 'neighbour', targetWord: 'wolf', acceptable: ['dog'] },
    },
    {
      id: 'attention-row',
      label: 'Read a row',
      check: { kind: 'attention-row', queryIndex: 2, expectedKeyIndex: 1 },
    },
  ],
};

const asExercise = (cfg: unknown) => [
  {
    slug: 'tokens-embeddings-attention',
    title: 'Tokens, embeddings and attention',
    kind: 'tokenizer',
    orderIndex: 1,
    config: cfg,
    completionRule: { type: 'tasks', required: 2 },
  },
];

describe('TokenizerConfigSchema', () => {
  it('accepts a full three-tab config and applies the tab defaults', () => {
    const parsed = TokenizerConfigSchema.parse(config);
    expect(parsed.embeddings.neighbourCount).toBe(3);
    expect(parsed.attention.defaultTemperature).toBe(1);
    expect(parsed.attention.defaultScale).toBe(true);
  });

  it('validates through ExercisesFileSchema and reports the path under config', () => {
    expect(ExercisesFileSchema.safeParse(asExercise(config)).success).toBe(true);

    const result = ExercisesFileSchema.safeParse(
      asExercise({ ...config, tokenizer: { ...tokenizerTab, defaultMerges: 9000 } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path.slice(0, 2)).toEqual([0, 'config']);
    }
  });

  it('rejects a task whose answer names a sentence that does not exist', () => {
    const bad = {
      ...config,
      tasks: [
        {
          ...config.tasks[0],
          check: { kind: 'tokenize', sentencesTokenized: 3, answerSentenceId: 'nope' },
        },
      ],
    };
    expect(TokenizerConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a neighbour task whose words are not plotted', () => {
    const bad = {
      ...config,
      tasks: [
        {
          ...config.tasks[1],
          check: { kind: 'neighbour', targetWord: 'wolf', acceptable: ['aardvark'] },
        },
      ],
    };
    expect(TokenizerConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an attention task pointing past the end of the sentence', () => {
    const bad = {
      ...config,
      tasks: [
        {
          ...config.tasks[2],
          check: { kind: 'attention-row', queryIndex: 2, expectedKeyIndex: 99 },
        },
      ],
    };
    expect(TokenizerConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicated tab', () => {
    expect(
      TokenizerConfigSchema.safeParse({ ...config, tabs: ['tokenizer', 'tokenizer'] }).success,
    ).toBe(false);
  });
});

describe('TokenizerTabConfigSchema', () => {
  it('needs exactly one corpus source', () => {
    expect(
      TokenizerTabConfigSchema.safeParse({ ...tokenizerTab, corpusFile: undefined }).success,
    ).toBe(false);
    expect(
      TokenizerTabConfigSchema.safeParse({
        ...tokenizerTab,
        corpusText: 'x'.repeat(100),
      }).success,
    ).toBe(false);
    const inline = TokenizerTabConfigSchema.safeParse({
      ...tokenizerTab,
      corpusFile: undefined,
      corpusText: 'low low lower lowest newest newest '.repeat(4),
    });
    expect(inline.success).toBe(true);
  });

  it('rejects a corpus filename that could escape the module directory', () => {
    for (const corpusFile of ['../corpus.txt', 'sub/corpus.txt', 'Corpus.txt', 'corpus.md']) {
      expect(TokenizerTabConfigSchema.safeParse({ ...tokenizerTab, corpusFile }).success).toBe(
        false,
      );
    }
  });

  it('rejects an inverted merge range and a default outside it', () => {
    expect(
      TokenizerTabConfigSchema.safeParse({ ...tokenizerTab, mergeRange: [500, 50] }).success,
    ).toBe(false);
    expect(TokenizerTabConfigSchema.safeParse({ ...tokenizerTab, defaultMerges: 20 }).success).toBe(
      false,
    );
  });

  it('rejects duplicate sample sentence ids', () => {
    const bad = {
      ...tokenizerTab,
      sampleSentences: tokenizerTab.sampleSentences.map((s) => ({ ...s, id: 'same' })),
    };
    expect(TokenizerTabConfigSchema.safeParse(bad).success).toBe(false);
  });
});

describe('EmbeddingsConfigSchema', () => {
  it('rejects an analogy word that is not in the list', () => {
    const bad = { ...embeddingsTab, defaultAnalogy: { a: 'king', b: 'man', c: 'duchess' } };
    const result = EmbeddingsConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['defaultAnalogy', 'c']);
    }
  });

  it('rejects a repeated word and a word that is not one lowercase token', () => {
    expect(
      EmbeddingsConfigSchema.safeParse({
        ...embeddingsTab,
        words: [...embeddingsTab.words, { word: 'king', cluster: 'people' }],
      }).success,
    ).toBe(false);
    expect(
      EmbeddingsConfigSchema.safeParse({
        ...embeddingsTab,
        words: [...embeddingsTab.words, { word: 'New York', cluster: 'places' }],
      }).success,
    ).toBe(false);
  });
});

describe('AttentionConfigSchema', () => {
  it('requires Q and K to be dk wide, and V to be internally consistent', () => {
    expect(AttentionConfigSchema.safeParse(attentionTab).success).toBe(true);

    const wideQ = { ...attentionTab, Q: attentionTab.Q.map((row) => [...row, 1]) };
    expect(AttentionConfigSchema.safeParse(wideQ).success).toBe(false);

    const raggedV = {
      ...attentionTab,
      V: [
        [1, 0, 0],
        [0, 1],
        [0, 0, 1],
      ],
    };
    expect(AttentionConfigSchema.safeParse(raggedV).success).toBe(false);
  });

  it('requires one row per word', () => {
    const short = { ...attentionTab, K: attentionTab.K.slice(0, 2) };
    const result = AttentionConfigSchema.safeParse(short);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('2 rows but there are 3 words');
    }
  });

  it('requires dimensionLabels to match dk when given', () => {
    expect(
      AttentionConfigSchema.safeParse({ ...attentionTab, dimensionLabels: ['a'] }).success,
    ).toBe(false);
    expect(
      AttentionConfigSchema.safeParse({ ...attentionTab, dimensionLabels: ['a', 'b'] }).success,
    ).toBe(true);
  });
});

describe('PrecomputedEmbeddingsSchema', () => {
  const file = {
    model: 'nomic-embed-text',
    dimensions: 3,
    generatedAt: '2026-09-19T00:00:00.000Z',
    vectors: { cat: [0.1, 0.2, 0.3], dog: [0.4, 0.5, 0.6] },
  };

  it('accepts a well-formed file', () => {
    expect(PrecomputedEmbeddingsSchema.parse(file).dimensions).toBe(3);
  });

  it('rejects a vector of the wrong length, naming the word', () => {
    const result = PrecomputedEmbeddingsSchema.safeParse({
      ...file,
      vectors: { ...file.vectors, dog: [0.4, 0.5] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['vectors', 'dog']);
    }
  });

  it('rejects a non-finite component and a non-ISO timestamp', () => {
    expect(
      PrecomputedEmbeddingsSchema.safeParse({
        ...file,
        vectors: { cat: [0.1, Number.NaN, 0.3], dog: [0.4, 0.5, 0.6] },
      }).success,
    ).toBe(false);
    expect(PrecomputedEmbeddingsSchema.safeParse({ ...file, generatedAt: 'today' }).success).toBe(
      false,
    );
  });
});
