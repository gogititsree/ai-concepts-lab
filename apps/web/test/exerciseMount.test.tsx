import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MlpExercise } from '../src/features/exercises/mlp/MlpExercise';
import { PerceptronExercise } from '../src/features/exercises/perceptron/PerceptronExercise';
import { exerciseDetail, installApiMock } from './fixtures/content';
import { renderWithProviders } from './harness';

/**
 * Mount tests, not pixel tests. The canvas context is a stub (see `test/setup.ts`), so what
 * these assert is the thing a stub can still prove: the component renders against the real
 * content file, the real nn-core model and the real store without throwing, and its controls
 * move the numbers.
 *
 * Since M7 they also need the two providers and a mocked API, because completing a task
 * writes to `PUT /progress/exercises/:id`.
 */

const perceptron = exerciseDetail('neurons');
const mlp = exerciseDetail('neural-networks');

function mount(ui: React.ReactElement) {
  installApiMock({ 'PUT /api/v1/progress/exercises/*': { body: {} } });
  return renderWithProviders(ui);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PerceptronExercise', () => {
  it('mounts with the canvas, the readouts and both tasks', () => {
    mount(<PerceptronExercise exercise={perceptron} />);

    expect(screen.getByTestId('perceptron-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('task-separate-blobs')).toBeInTheDocument();
    expect(screen.getByTestId('task-try-xor')).toBeInTheDocument();
    expect(screen.getByText('Accuracy')).toBeInTheDocument();
  });

  it('runs an epoch on click and the epoch counter follows', () => {
    mount(<PerceptronExercise exercise={perceptron} />);
    expect(screen.getByText('Epochs').nextElementSibling).toHaveTextContent('0');

    fireEvent.click(screen.getByRole('button', { name: /run one epoch/i }));
    expect(screen.getByText('Epochs').nextElementSibling).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /step one example/i }));
    expect(screen.getByText('Steps').nextElementSibling).toHaveTextContent('1');
  });

  it('shows the tasks the API already has recorded as done', () => {
    mount(
      <PerceptronExercise
        exercise={exerciseDetail('neurons', { tasksCompleted: ['separate-blobs'] })}
      />,
    );
    expect(screen.getByTestId('task-list')).toHaveTextContent('1/2 to complete');
  });
});

describe('MlpExercise', () => {
  it('mounts the graph, the heatmap and the loss chart', () => {
    mount(<MlpExercise exercise={mlp} />);

    expect(screen.getByTestId('network-graph')).toBeInTheDocument();
    expect(screen.getByTestId('boundary-heatmap')).toBeInTheDocument();
    expect(screen.getByTestId('loss-chart')).toBeInTheDocument();
    expect(screen.getAllByTestId('network-node')).toHaveLength(2 + 4 + 1);
  });

  it('steps forward and backward on one example, which ticks the step-through task', () => {
    mount(<MlpExercise exercise={mlp} />);

    fireEvent.click(screen.getByRole('button', { name: /forward one example/i }));
    fireEvent.click(screen.getByRole('button', { name: /backward one example/i }));

    expect(screen.getByText(/1 steps/)).toBeInTheDocument();
    expect(screen.getByTestId('task-step-through')).toHaveTextContent(/forward and backward/i);
  });

  it('rebuilds the network when the hidden size changes', () => {
    mount(<MlpExercise exercise={mlp} />);

    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(screen.getAllByTestId('network-node')).toHaveLength(2 + 7 + 1);
    expect(screen.getAllByTestId('network-edge')).toHaveLength(2 * 7 + 7);
  });

  it('trains an epoch and records the loss', () => {
    mount(<MlpExercise exercise={mlp} />);
    fireEvent.click(screen.getByRole('button', { name: /train 1 epoch/i }));
    expect(screen.getByTestId('loss-chart')).toHaveTextContent('1 epochs');
  });
});
