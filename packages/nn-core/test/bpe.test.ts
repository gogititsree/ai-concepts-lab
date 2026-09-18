import { describe, expect, it } from 'vitest';
import {
  END_OF_WORD,
  UNKNOWN_TOKEN,
  bytesPerToken,
  decode,
  detokenize,
  encode,
  encodeToTokens,
  normalizeWhitespace,
  renderToken,
  tokensForIds,
  trainBpe,
  utf8Length,
} from '../src/bpe.js';

/** The textbook BPE corpus: enough repetition that the merges are easy to reason about. */
const CORPUS =
  'low low low low low lower lower lowest newest newest newest newest newest newest ' +
  'wider wider wider new new';

describe('trainBpe', () => {
  it('is deterministic for a fixed corpus and merge count', () => {
    const a = trainBpe(CORPUS, 10);
    const b = trainBpe(CORPUS, 10);
    expect(a.merges).toEqual(b.merges);
    expect(a.vocab).toEqual(b.vocab);
    expect(a.tokenToId).toEqual(b.tokenToId);
  });

  it('learns the expected merges, most frequent pair first', () => {
    const model = trainBpe(CORPUS, 6);
    expect(model.merges).toEqual([
      ['w', 'e'],
      ['l', 'o'],
      ['n', 'e'],
      ['w', END_OF_WORD],
      ['we', 's'],
      ['wes', 't'],
    ]);
  });

  it('learns exactly the requested number of merges when the corpus supports it', () => {
    expect(trainBpe(CORPUS, 10).merges).toHaveLength(10);
    expect(trainBpe(CORPUS, 3).merges).toHaveLength(3);
    expect(trainBpe(CORPUS, 0).merges).toHaveLength(0);
  });

  it('stops early once no pair occurs twice, rather than inventing merges', () => {
    const model = trainBpe(CORPUS, 1000);
    expect(model.merges.length).toBeLessThan(1000);
    expect(model.merges.length).toBeGreaterThan(10);
  });

  it('starts from the characters in the corpus, plus the two special tokens', () => {
    const model = trainBpe('ab ab', 0);
    expect(model.vocab).toEqual([UNKNOWN_TOKEN, END_OF_WORD, 'a', 'b']);
    expect(model.tokenToId[UNKNOWN_TOKEN]).toBe(0);
  });

  it('adds one vocabulary entry per merge', () => {
    const base = trainBpe(CORPUS, 0).vocab.length;
    const model = trainBpe(CORPUS, 7);
    expect(model.vocab).toHaveLength(base + 7);
    expect(new Set(model.vocab).size).toBe(model.vocab.length);
  });

  it('keeps the vocabulary and its reverse index in sync', () => {
    const model = trainBpe(CORPUS, 12);
    model.vocab.forEach((token, id) => {
      expect(model.tokenToId[token]).toBe(id);
    });
  });

  it('rejects a negative merge count', () => {
    expect(() => trainBpe(CORPUS, -1)).toThrow(RangeError);
  });

  it('copes with an empty corpus', () => {
    const model = trainBpe('   ', 5);
    expect(model.merges).toEqual([]);
    expect(encode(model, '')).toEqual([]);
  });
});

describe('encode and decode', () => {
  const model = trainBpe(CORPUS, 10);

  it('round-trips text whose characters the model has seen', () => {
    for (const text of ['low', 'lowest newest wider', 'new lower low', 'lowest']) {
      expect(decode(model, encode(model, text))).toBe(text);
    }
  });

  it('round-trips after normalising whitespace', () => {
    expect(decode(model, encode(model, '  low   newest \n wider '))).toBe('low newest wider');
  });

  it('produces token strings alongside the ids', () => {
    expect(encodeToTokens(model, 'lowest newer')).toEqual(['lo', 'west</w>', 'ne', 'we', 'r</w>']);
    expect(encode(model, 'lowest newer')).toEqual(
      encodeToTokens(model, 'lowest newer').map((token) => model.tokenToId[token]),
    );
  });

  it('gives every word an end-of-word marker, so word boundaries survive', () => {
    const tokens = encodeToTokens(model, 'low new');
    expect(tokens.filter((token) => token.endsWith(END_OF_WORD))).toHaveLength(2);
  });

  it('compresses: more merges means fewer tokens', () => {
    const few = trainBpe(CORPUS, 2);
    const many = trainBpe(CORPUS, 15);
    const text = 'lowest newest wider';
    expect(encode(many, text).length).toBeLessThan(encode(few, text).length);
  });

  it('maps unseen characters to <unk> instead of throwing', () => {
    // 'z', 'b' and 'a' never appear in the corpus; 'e' and 'r' do.
    expect(encodeToTokens(model, 'zebra')).toEqual([
      UNKNOWN_TOKEN,
      'e',
      UNKNOWN_TOKEN,
      'r',
      UNKNOWN_TOKEN,
      END_OF_WORD,
    ]);
    // Round-tripping is therefore lossy for unseen characters -- by design, and visibly so.
    expect(decode(model, encode(model, 'zebra'))).toBe('<unk>e<unk>r<unk>');
  });

  it('decodes an out-of-range id as <unk> rather than crashing', () => {
    expect(tokensForIds(model, [99999])).toEqual([UNKNOWN_TOKEN]);
  });

  it('encodes an empty string to no tokens', () => {
    expect(encode(model, '')).toEqual([]);
    expect(encodeToTokens(model, '   ')).toEqual([]);
  });
});

describe('helpers', () => {
  const model = trainBpe(CORPUS, 10);

  it('normalizeWhitespace collapses runs and trims', () => {
    expect(normalizeWhitespace('  a \t\n b  ')).toBe('a b');
    expect(normalizeWhitespace('')).toBe('');
  });

  it('detokenize turns end-of-word markers back into spaces', () => {
    expect(detokenize(['lo', 'w</w>', 'ne', 'w</w>'])).toBe('low new');
  });

  it('renderToken shows the end-of-word marker as an underscore for the UI', () => {
    expect(renderToken('low</w>')).toBe('low_');
    expect(renderToken('lo')).toBe('lo');
  });

  it('utf8Length counts bytes, not code units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('\u{1f600}')).toBe(4);
    expect(utf8Length('')).toBe(0);
  });

  it('bytesPerToken reports the compression the tokenizer achieves', () => {
    expect(bytesPerToken(model, 'lowest newest')).toBeCloseTo(13 / 3, 12);
    expect(bytesPerToken(model, '')).toBe(0);
  });
});
