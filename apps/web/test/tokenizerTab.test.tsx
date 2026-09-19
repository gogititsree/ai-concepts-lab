import { encodeToTokens, trainBpe } from '@lab/nn-core';
import { fireEvent, screen, within } from '@testing-library/react';
import { act, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseExerciseConfig } from '../src/features/content/exerciseConfig';
import { resolveCorpus } from '../src/features/exercises/tokenizer/bundledCorpus';
import { TokenizerTab } from '../src/features/exercises/tokenizer/TokenizerTab';
import { exerciseDetail } from './fixtures/content';
import { renderWithProviders } from './harness';

/**
 * The tokenizer tab against the real corpus and the real `trainBpe`. Nothing here is
 * mocked, because the interesting assertion — "more merges, fewer tokens" — is only true
 * if the actual algorithm is running.
 *
 * The tab debounces the merge slider by 200 ms and then defers the training, so every
 * test that moves the slider has to drive fake timers and flush React. That is the price
 * of the responsiveness measured in the component's header comment, and it is worth
 * asserting rather than working around: `advanceTimers` here is proof the debounce exists.
 */

const config = parseExerciseConfig('tokenizer', exerciseDetail('how-llms-work').config);
const tab = config.tokenizer;

const noop = () => {};

function mount(ui: ReactElement) {
  return renderWithProviders(ui);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function tokenCount(): number {
  return screen.getAllByTestId('token-chip').length;
}

describe('TokenizerTab', () => {
  it('renders one chip per token for the default text, matching nn-core exactly', () => {
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: [], answerSentenceId: null }}
        onAnswerChange={noop}
      />,
    );

    const expected = encodeToTokens(
      trainBpe(resolveCorpus(tab), tab.defaultMerges),
      tab.defaultText,
    );
    expect(tokenCount()).toBe(expected.length);
    // The stats row agrees with the chips.
    expect(screen.getByText('Tokens').nextElementSibling).toHaveTextContent(
      String(expected.length),
    );
  });

  it('colours chips by token id and exposes the id and byte length to hover and a11y', () => {
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: [], answerSentenceId: null }}
        onAnswerChange={noop}
      />,
    );
    const chip = screen.getAllByTestId('token-chip')[0] as HTMLElement;
    expect(chip.dataset.tokenId).toBeDefined();
    expect(chip.getAttribute('title')).toMatch(/id \d+ · \d+ bytes?/);
    expect(chip.getAttribute('aria-label')).toMatch(/id \d+, \d+ bytes/);
  });

  it('retrains on the merge slider and the token count falls', () => {
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: [], answerSentenceId: null }}
        onAnswerChange={noop}
      />,
    );
    const before = tokenCount();

    const slider = screen.getByLabelText(/merges/i, { selector: 'input' });
    fireEvent.change(slider, { target: { value: String(tab.mergeRange[0]) } });

    // The debounce is real: nothing has retrained yet.
    expect(screen.getByTestId('training-state')).toHaveTextContent(/training/i);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByTestId('training-state')).not.toHaveTextContent(/training/i);
    const after = tokenCount();
    expect(after).toBeGreaterThan(before);

    // And the same sentence really does tokenize that way at 50 merges.
    const expected = encodeToTokens(
      trainBpe(resolveCorpus(tab), tab.mergeRange[0]),
      tab.defaultText,
    );
    expect(after).toBe(expected.length);
  });

  it('shows the merge table in learned order with a frequency column', () => {
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: [], answerSentenceId: null }}
        onAnswerChange={noop}
      />,
    );
    const rows = screen.getAllByTestId('merge-row');
    expect(rows.length).toBe(trainBpe(resolveCorpus(tab), tab.defaultMerges).merges.length);
    expect(rows[0]).toHaveTextContent('1');
    expect(screen.getByText('in corpus')).toBeInTheDocument();
  });

  it('loading a sample records it and surfaces the unknown-token count', () => {
    const onAnswerChange = vi.fn();
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: [], answerSentenceId: null }}
        onAnswerChange={onAnswerChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'digits-and-symbols' }));
    expect(onAnswerChange).toHaveBeenCalledWith({
      tokenized: ['digits-and-symbols'],
      answerSentenceId: null,
    });

    // The digit string has no character in the corpus, so every digit is <unk>.
    expect(Number(screen.getByText('Unknown').nextElementSibling?.textContent)).toBeGreaterThan(5);
  });

  it('records the answer to the count question', () => {
    const onAnswerChange = vi.fn();
    mount(
      <TokenizerTab
        config={tab}
        answer={{ tokenized: ['in-domain'], answerSentenceId: null }}
        onAnswerChange={onAnswerChange}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: /costs the most tokens/i });
    fireEvent.click(within(group).getByRole('radio', { name: 'digits-and-symbols' }));
    expect(onAnswerChange).toHaveBeenCalledWith({
      tokenized: ['in-domain'],
      answerSentenceId: 'digits-and-symbols',
    });
  });
});
