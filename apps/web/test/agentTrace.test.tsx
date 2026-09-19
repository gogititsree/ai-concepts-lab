import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentTrace } from '../src/features/runs/AgentTrace';
import { HAPPY_STEPS, MIXED_STEPS, step } from './fixtures/runs';
import { renderWithProviders } from './harness';

/**
 * The trace viewer.
 *
 * It is the component three modules share, so the tests are about the contract rather
 * than the styling: every step kind renders, errors are distinguishable by something
 * other than colour, the JSON is reachable, and the markup is a list with headings so a
 * screen reader can navigate it.
 */

describe('rendering steps', () => {
  it('renders one card per step, in order, with a testid per index', () => {
    renderWithProviders(<AgentTrace steps={HAPPY_STEPS} />);
    for (const entry of HAPPY_STEPS) {
      expect(screen.getByTestId(`step-${entry.stepIndex}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('trace-count')).toHaveTextContent('5 steps · 2 iterations');
  });

  it('renders every step kind with its label', () => {
    renderWithProviders(<AgentTrace steps={MIXED_STEPS} />);
    const kinds = MIXED_STEPS.map(
      (entry) => screen.getByTestId(`step-${entry.stepIndex}`).dataset.kind,
    );
    expect(kinds).toEqual(['model_call', 'tool_call', 'tool_result', 'final', 'error']);
    expect(screen.getByText(/model call/)).toBeInTheDocument();
    expect(screen.getByText(/tool call · calculator/)).toBeInTheDocument();
    expect(screen.getByText(/tool result · calculator/)).toBeInTheDocument();
    expect(screen.getByText(/final answer/)).toBeInTheDocument();
  });

  it('marks error steps as error in the DOM, not only in colour', () => {
    renderWithProviders(<AgentTrace steps={MIXED_STEPS} />);
    expect(screen.getByTestId('step-2').dataset.error).toBe('true');
    expect(screen.getByTestId('step-0').dataset.error).toBe('false');
    expect(within(screen.getByTestId('step-2')).getByText('error')).toBeInTheDocument();
    // A parse failure gets its own badge: it is a different fault from a failed tool.
    expect(within(screen.getByTestId('step-1')).getByText('parse failed')).toBeInTheDocument();
  });

  it('shows latency and token badges where the step has them', () => {
    renderWithProviders(<AgentTrace steps={HAPPY_STEPS} />);
    expect(within(screen.getByTestId('step-0')).getByText('23.5 s')).toBeInTheDocument();
    expect(within(screen.getByTestId('step-0')).getByText('227/27 tok')).toBeInTheDocument();
    // Sub-second tool execution stays in milliseconds: "0.0 s" would hide the point.
    expect(within(screen.getByTestId('step-2')).getByText('2 ms')).toBeInTheDocument();
  });

  it('explains an empty model_call instead of rendering a blank card', () => {
    renderWithProviders(<AgentTrace steps={HAPPY_STEPS} />);
    expect(
      within(screen.getByTestId('step-0')).getByText(/spent this call deciding to use a tool/i),
    ).toBeInTheDocument();
  });

  it('exposes arguments, raw arguments and results as expandable JSON', () => {
    renderWithProviders(<AgentTrace steps={MIXED_STEPS} />);
    expect(
      within(screen.getByTestId('step-1')).getByText('raw arguments (parsing failed)'),
    ).toBeInTheDocument();
    const result = within(screen.getByTestId('step-2')).getByText('result');
    expect(result).toBeInTheDocument();
    expect(screen.getByText(/ARGUMENTS_NOT_JSON/)).toBeInTheDocument();
  });
});

describe('structure and accessibility', () => {
  it('is a list of steps grouped into labelled iteration sections', () => {
    renderWithProviders(<AgentTrace steps={HAPPY_STEPS} />);
    expect(screen.getByRole('region', { name: 'Iteration 1' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Iteration 2' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(HAPPY_STEPS.length);
    // A table would make a screen reader announce cells; a list announces steps.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('gives every card a position announcement for screen readers', () => {
    renderWithProviders(<AgentTrace steps={HAPPY_STEPS} />);
    expect(screen.getByText('Step 1 of 5:')).toBeInTheDocument();
    expect(screen.getByText('Step 5 of 5:')).toBeInTheDocument();
  });
});

describe('empty and live states', () => {
  it('says what to do when there is nothing yet', () => {
    renderWithProviders(<AgentTrace steps={[]} />);
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/Press Run/);
  });

  it('sets expectations about the wait while a run is starting', () => {
    renderWithProviders(<AgentTrace steps={[]} isRunning />);
    expect(screen.getByTestId('trace-empty')).toHaveTextContent(/6–45 seconds/);
  });

  it('shows a streaming indicator once steps are arriving', () => {
    renderWithProviders(<AgentTrace steps={[step(0, 'model_call')]} isRunning />);
    expect(screen.getByTestId('trace-live')).toBeInTheDocument();
  });
});
