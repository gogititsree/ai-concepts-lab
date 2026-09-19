import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PerceptronExercise } from '../src/features/exercises/perceptron/PerceptronExercise';
import {
  STATE_DEBOUNCE_MS,
  useExercisePersistence,
} from '../src/features/content/useExercisePersistence';
import { exerciseDetail, installApiMock } from './fixtures/content';
import { Providers, renderWithProviders } from './harness';

/**
 * The save schedule, which is the one piece of M7's frontend that is a *policy* rather
 * than a rendering: `state` is debounced by two seconds, task completion is immediate.
 * Fake timers make both assertable without waiting two real seconds per case.
 */

const exercise = exerciseDetail('neurons');
const SAVE_ROUTE = `PUT /api/v1/progress/exercises/${exercise.id}`;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useExercisePersistence', () => {
  it('seeds itself from the exercise the API returned', () => {
    installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result } = renderHook(
      () =>
        useExercisePersistence(
          exerciseDetail('neurons', {
            state: { reflection: 'earlier' },
            tasksCompleted: ['separate-blobs'],
          }),
        ),
      { wrapper: Providers },
    );

    expect(result.current.state).toEqual({ reflection: 'earlier' });
    expect(result.current.tasksCompleted).toEqual(['separate-blobs']);
  });

  it('debounces a state save by two seconds and coalesces the edits', async () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result } = renderHook(() => useExercisePersistence(exercise), {
      wrapper: Providers,
    });

    act(() => result.current.patchState({ reflection: 'a' }));
    act(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS - 1));
    act(() => result.current.patchState({ reflection: 'ab' }));
    act(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS - 1));

    // Still nothing: each keystroke restarted the clock.
    expect(api.calls.filter((call) => call === SAVE_ROUTE)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(1));
    await waitFor(() => expect(api.calls.filter((c) => c === SAVE_ROUTE)).toHaveLength(1));
    // One request, carrying the latest value.
    expect(api.bodies.at(-1)).toEqual({ state: { reflection: 'ab' } });
  });

  it('ignores a patch that changes nothing', () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result } = renderHook(
      () => useExercisePersistence(exerciseDetail('neurons', { state: { reflection: 'same' } })),
      { wrapper: Providers },
    );

    act(() => result.current.patchState({ reflection: 'same' }));
    act(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS * 2));
    expect(api.calls).toHaveLength(0);
  });

  it('saves a task the instant it passes, with no debounce', async () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result } = renderHook(() => useExercisePersistence(exercise), {
      wrapper: Providers,
    });

    act(() => result.current.reportTasks(['separate-blobs']));
    await waitFor(() => expect(api.calls).toContain(SAVE_ROUTE));
    expect(api.bodies.at(-1)).toMatchObject({ tasksCompleted: ['separate-blobs'] });
  });

  it('only grows the task union, and does not re-save a task it already has', async () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result } = renderHook(() => useExercisePersistence(exercise), {
      wrapper: Providers,
    });

    act(() => result.current.reportTasks(['try-xor']));
    await waitFor(() => expect(api.calls).toHaveLength(1));

    act(() => result.current.reportTasks(['try-xor']));
    act(() => result.current.reportTasks([]));
    expect(api.calls).toHaveLength(1);

    act(() => result.current.reportTasks(['separate-blobs']));
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(result.current.tasksCompleted).toEqual(['separate-blobs', 'try-xor']);
  });

  it('flushes a pending state save on unmount', async () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    const { result, unmount } = renderHook(() => useExercisePersistence(exercise), {
      wrapper: Providers,
    });

    act(() => result.current.patchState({ reflection: 'half a sentence' }));
    expect(api.calls).toHaveLength(0);

    unmount();
    await waitFor(() => expect(api.calls).toContain(SAVE_ROUTE));
    expect(api.bodies.at(-1)).toEqual({ state: { reflection: 'half a sentence' } });
  });
});

describe('the perceptron playground', () => {
  it('debounces the reflection box through the same path', async () => {
    const api = installApiMock({ [SAVE_ROUTE]: { body: {} } });
    renderWithProviders(
      <PerceptronExercise
        exercise={exerciseDetail('neurons', { tasksCompleted: ['separate-blobs', 'try-xor'] })}
      />,
    );

    // The reflection box only appears once the tasks are done.
    const box = screen.getByPlaceholderText(/a sentence is enough/i);
    fireEvent.change(box, { target: { value: 'the line kept trading off' } });
    expect(api.calls).toHaveLength(0);

    act(() => vi.advanceTimersByTime(STATE_DEBOUNCE_MS));
    await waitFor(() => expect(api.calls).toContain(SAVE_ROUTE));
    expect(api.bodies.at(-1)).toEqual({
      state: { reflection: 'the line kept trading off' },
    });
  });
});
