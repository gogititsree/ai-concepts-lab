import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { getExercise, getModule } from '../src/content/static';
import { MlpExercise } from '../src/features/exercises/mlp/MlpExercise';
import { PerceptronExercise } from '../src/features/exercises/perceptron/PerceptronExercise';

/**
 * Mount tests, not pixel tests. The canvas context is a stub (see `test/setup.ts`), so what
 * these assert is the thing a stub can still prove: the component renders against the real
 * content file, the real nn-core model and the real store without throwing, and its controls
 * move the numbers.
 */

const neurons = getModule('neurons')!;
const perceptron = getExercise('neurons')!;
const networks = getModule('neural-networks')!;
const mlp = getExercise('neural-networks')!;

describe('PerceptronExercise', () => {
  it('mounts with the canvas, the readouts and both tasks', () => {
    render(<PerceptronExercise module={neurons} exercise={perceptron} />);

    expect(screen.getByTestId('perceptron-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('task-separate-blobs')).toBeInTheDocument();
    expect(screen.getByTestId('task-try-xor')).toBeInTheDocument();
    expect(screen.getByText('Accuracy')).toBeInTheDocument();
  });

  it('runs an epoch on click and the epoch counter follows', () => {
    render(<PerceptronExercise module={neurons} exercise={perceptron} />);
    expect(screen.getByText('Epochs').nextElementSibling).toHaveTextContent('0');

    fireEvent.click(screen.getByRole('button', { name: /run one epoch/i }));
    expect(screen.getByText('Epochs').nextElementSibling).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /step one example/i }));
    expect(screen.getByText('Steps').nextElementSibling).toHaveTextContent('1');
  });
});

describe('MlpExercise', () => {
  it('mounts the graph, the heatmap and the loss chart', () => {
    render(<MlpExercise module={networks} exercise={mlp} />);

    expect(screen.getByTestId('network-graph')).toBeInTheDocument();
    expect(screen.getByTestId('boundary-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('loss-chart')).toBeInTheDocument();
    expect(screen.getAllByTestId('network-node')).toHaveLength(2 + 4 + 1);
  });

  it('steps forward and backward on one example, which ticks the step-through task', () => {
    render(<MlpExercise module={networks} exercise={mlp} />);

    fireEvent.click(screen.getByRole('button', { name: /forward one example/i }));
    fireEvent.click(screen.getByRole('button', { name: /backward one example/i }));

    expect(screen.getByText(/1 steps/)).toBeInTheDocument();
    expect(screen.getByTestId('task-step-through')).toHaveTextContent(/forward and backward/i);
  });

  it('rebuilds the network when the hidden size changes', () => {
    render(<MlpExercise module={networks} exercise={mlp} />);

    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(screen.getAllByTestId('network-node')).toHaveLength(2 + 7 + 1);
    expect(screen.getAllByTestId('network-edge')).toHaveLength(2 * 7 + 7);
  });

  it('trains an epoch and records the loss', () => {
    render(<MlpExercise module={networks} exercise={mlp} />);
    fireEvent.click(screen.getByRole('button', { name: /train 1 epoch/i }));
    expect(screen.getByTestId('loss-chart')).toHaveTextContent('1 epochs');
  });
});
