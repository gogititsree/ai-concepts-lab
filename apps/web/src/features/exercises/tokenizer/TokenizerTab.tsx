import {
  bytesPerToken,
  encode,
  encodeToTokens,
  normalizeWhitespace,
  trainBpe,
  UNKNOWN_TOKEN,
  utf8Length,
  type BpeModel,
} from '@lab/nn-core';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import { Button, Eyebrow, Panel, Readout, Slider } from '../../../components/ui';
import type { TokenizerTabConfig } from '@lab/shared';
import { resolveCorpus } from './bundledCorpus';
import { MergeTable } from './MergeTable';
import { TokenChips } from './TokenChips';
import type { TokenizeAnswer } from './checks';

/**
 * Tab 1: train BPE in the browser, tokenize live, watch the merge count change the shape
 * of the output.
 *
 * **On retraining performance.** Training the shipped 4,967-byte corpus measures at
 * 15 ms for 50 merges and 58 ms for 500 on a warm laptop — each round rescans the deduped
 * word list, so cost is roughly linear in the merge count. That is well inside a frame
 * budget's neighbourhood but not inside a frame, so dragging the slider would drop
 * frames if every intermediate value retrained. Two cheap mechanisms instead of a Web
 * Worker, which at this cost would be more message-passing than compute:
 *
 *  1. a 200 ms debounce from the slider to the committed merge count, so a drag from 50
 *     to 500 trains once rather than 450 times, and
 *  2. `useDeferredValue` on the committed value, so React keeps the slider, the text area
 *     and the "training…" badge interactive while the new model is being built.
 *
 * If a future corpus makes this slow enough to matter, the seam is one `useMemo`: move
 * `trainBpe` into a worker and await it. The measurement is the reason that has not
 * happened, and the numbers are here so the next person can re-measure rather than guess.
 */

const TRAIN_DEBOUNCE_MS = 200;

export interface TokenizerTabProps {
  config: TokenizerTabConfig;
  answer: TokenizeAnswer;
  onAnswerChange: (answer: TokenizeAnswer) => void;
}

/** How often each merged symbol survives in the encoded corpus (the MergeTable column). */
function mergeFrequencies(model: BpeModel, corpus: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of encodeToTokens(model, corpus)) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

export function TokenizerTab({ config, answer, onAnswerChange }: TokenizerTabProps) {
  const corpus = useMemo(() => resolveCorpus(config), [config]);
  const [minMerges, maxMerges] = config.mergeRange;

  const [text, setText] = useState(config.defaultText);
  // Three values, deliberately: what the slider shows, what we have committed to training
  // on, and what has actually been trained. The gap between them is the "training…" badge.
  const [sliderMerges, setSliderMerges] = useState(config.defaultMerges);
  const [merges, setMerges] = useState(config.defaultMerges);
  const trainedMerges = useDeferredValue(merges);

  useEffect(() => {
    if (sliderMerges === merges) return;
    const timer = setTimeout(() => setMerges(sliderMerges), TRAIN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sliderMerges, merges]);

  const model = useMemo(() => trainBpe(corpus, trainedMerges), [corpus, trainedMerges]);
  const frequencies = useMemo(() => mergeFrequencies(model, corpus), [model, corpus]);
  const isTraining = sliderMerges !== trainedMerges;

  const tokens = useMemo(() => encodeToTokens(model, text), [model, text]);
  const ids = useMemo(() => encode(model, text), [model, text]);
  const characters = normalizeWhitespace(text).length;
  const bytes = utf8Length(normalizeWhitespace(text));
  const unknowns = tokens.filter((token) => token === UNKNOWN_TOKEN).length;

  const loadSample = (id: string, sentence: string) => {
    setText(sentence);
    onAnswerChange({
      tokenized: [...new Set([...answer.tokenized, id])],
      answerSentenceId: answer.answerSentenceId,
    });
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Panel className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Eyebrow>Text to tokenize</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
              {config.sampleSentences.map((sentence) => (
                <Button
                  key={sentence.id}
                  variant={answer.tokenized.includes(sentence.id) ? 'primary' : 'secondary'}
                  onClick={() => loadSample(sentence.id, sentence.text)}
                >
                  {sentence.id}
                </Button>
              ))}
            </div>
          </div>
          <label className="mt-2 block">
            <span className="sr-only">Text to tokenize</span>
            <textarea
              data-testid="tokenizer-input"
              className="border-rule bg-surface min-h-20 w-full rounded-md border p-2 font-mono text-sm leading-6"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>

          <div className="mt-3">
            <TokenChips tokens={tokens} ids={ids} />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Readout label="Tokens" value={tokens.length} />
            <Readout label="Characters" value={characters} />
            <Readout
              label="Bytes / token"
              value={bytesPerToken(model, text).toFixed(2)}
              hint={`${bytes} UTF-8 bytes over ${tokens.length} tokens`}
            />
            <Readout
              label="Unknown"
              value={unknowns}
              hint="Characters the corpus never contained, encoded as <unk>"
            />
          </div>
          {unknowns > 0 && (
            <p className="text-muted mt-2 text-xs leading-5">
              {unknowns} token{unknowns === 1 ? '' : 's'} came out as{' '}
              <code className="bg-sunk border-rule rounded border px-1">{UNKNOWN_TOKEN}</code>: the
              corpus contains no such character, so no merge can ever apply to it. Real tokenizers
              work on raw bytes to avoid this — nothing unknown, only expensive.
            </p>
          )}
        </Panel>

        <Panel className="p-4">
          <Eyebrow>Which sample costs the most tokens?</Eyebrow>
          <p className="text-muted mt-1 text-xs leading-5">
            Load each of the three above, read the token count, then answer. The answer is the same
            at every merge setting — which is itself the interesting part.
          </p>
          <div
            className="mt-2 flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label="Which sample sentence costs the most tokens?"
          >
            {config.sampleSentences.map((sentence) => (
              <Button
                key={sentence.id}
                role="radio"
                aria-checked={answer.answerSentenceId === sentence.id}
                variant={answer.answerSentenceId === sentence.id ? 'primary' : 'secondary'}
                onClick={() =>
                  onAnswerChange({ tokenized: answer.tokenized, answerSentenceId: sentence.id })
                }
              >
                {sentence.id}
              </Button>
            ))}
          </div>
          <p className="readout text-muted mt-2 text-xs">
            tokenized {new Set(answer.tokenized).size} of {config.sampleSentences.length}
          </p>
        </Panel>

        <Panel className="space-y-3 p-4">
          <Slider
            label="Merges"
            min={minMerges}
            max={maxMerges}
            step={10}
            value={sliderMerges}
            onChange={(value) => setSliderMerges(Math.round(value))}
            format={(value) => String(Math.round(value))}
          />
          <div className="flex flex-wrap items-center gap-3">
            <span className="readout text-muted text-xs" data-testid="training-state">
              {isTraining ? 'training…' : `${model.merges.length} merges learned`}
            </span>
            <span className="readout text-muted text-xs">vocabulary {model.vocab.length}</span>
          </div>
          <p className="text-muted text-xs leading-5">
            Asking for more merges than the corpus can support stops early: once no pair occurs
            twice, merging compresses nothing. Vocabulary up, sequence length down — that is the
            only trade there is.
          </p>
        </Panel>
      </div>

      <Panel className="p-4">
        <Eyebrow>Merge table</Eyebrow>
        <p className="text-muted mt-1 mb-3 text-xs leading-5">
          In the order learned, which is the order they are replayed in when encoding.
        </p>
        <MergeTable model={model} frequencies={frequencies} />
      </Panel>
    </div>
  );
}
