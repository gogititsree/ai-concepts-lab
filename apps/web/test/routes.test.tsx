import { fireEvent, render, screen } from '@testing-library/react';

import { Providers } from './harness';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App';

function renderAt(path: string) {
  return render(
    <Providers path={path}>
      <App />
    </Providers>,
  );
}

describe('routes', () => {
  it('lists all six modules on /modules', () => {
    renderAt('/modules');
    expect(screen.getAllByTestId('module-card')).toHaveLength(6);
    expect(screen.getByRole('heading', { name: /six modules/i })).toBeInTheDocument();
  });

  it('shows a module overview with its lessons, exercise and quiz', () => {
    renderAt('/modules/neurons');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Neurons & perceptrons' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What a neuron computes/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the playground/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Take the quiz/ })).toBeInTheDocument();
  });

  it('renders a lesson with prev/next navigation and a completion toggle', () => {
    renderAt('/modules/neurons/lessons/the-perceptron-rule');

    expect(
      screen.getByRole('heading', { level: 1, name: /Learning by nudging/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('What a neuron computes')).toBeInTheDocument();
    expect(screen.getByText('Reading the code')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(screen.getByRole('button', { name: /completed/i })).toBeInTheDocument();
  });

  it('says so, without crashing, for an exercise kind M3 does not implement', () => {
    renderAt('/modules/how-llms-work/exercise');
    expect(screen.getByText(/coming in a later milestone/i)).toBeInTheDocument();
  });

  it('grades a quiz in the browser and shows the explanations', () => {
    renderAt('/modules/neurons/quiz');

    // Answer the sample question correctly, leave the rest blank.
    const options = screen.getAllByRole('radio');
    fireEvent.click(options[1]!);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));

    const result = screen.getByTestId('quiz-result');
    expect(result).toHaveTextContent('1/8');
    expect(result).toHaveTextContent(/not passed/i);
    expect(screen.getAllByText(/the step activation outputs 1/i).length).toBeGreaterThan(0);
  });

  it('404s on a module that does not exist', () => {
    renderAt('/modules/nope');
    expect(screen.getByText(/does not exist/i)).toBeInTheDocument();
  });
});
