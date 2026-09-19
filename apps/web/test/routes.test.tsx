import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import {
  exerciseDetail,
  HEALTH_OK,
  installApiMock,
  lessonDetail,
  moduleDetail,
  moduleList,
  progressSummary,
  quizDetail,
  SERVER_ERROR,
  UNAUTHENTICATED,
  type MockRoute,
} from './fixtures/content';
import { Providers } from './harness';

/**
 * The six content pages, driven through the real router against a mocked API.
 *
 * Every page has to answer three questions and they are all tested here: what does it
 * show while the request is in flight, what does it show when the caller is signed out
 * (a panel and a link — *not* a redirect, because `App.tsx` does not wrap these routes
 * in `RequireAuth`), and what does it show when the request genuinely failed.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string, routes: Record<string, MockRoute>) {
  installApiMock({ 'GET /api/v1/health': HEALTH_OK, ...routes });
  return render(
    <Providers path={path}>
      <App />
    </Providers>,
  );
}

const NEURONS = {
  'GET /api/v1/modules': { body: moduleList() },
  'GET /api/v1/modules/neurons': { body: moduleDetail('neurons') },
} satisfies Record<string, MockRoute>;

describe('/modules', () => {
  it('shows a quiet loading state, then the six module cards', async () => {
    renderAt('/modules', NEURONS);
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

    expect(await screen.findAllByTestId('module-card')).toHaveLength(6);
    expect(screen.getByRole('heading', { name: /six modules/i })).toBeInTheDocument();
  });

  it('invites a signed-out visitor to sign in instead of redirecting', async () => {
    renderAt('/modules', { 'GET /api/v1/modules': UNAUTHENTICATED });

    expect(await screen.findByTestId('sign-in-panel')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    // Still on /modules, not bounced to the login route.
    expect(screen.getByRole('heading', { name: /six modules/i })).toBeInTheDocument();
  });

  it('offers a retry on a real failure', async () => {
    const api = installApiMock({ 'GET /api/v1/modules': SERVER_ERROR });
    render(
      <Providers path="/modules">
        <App />
      </Providers>,
    );

    expect(await screen.findByTestId('error-panel')).toHaveTextContent(/internal server error/i);
    const before = api.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(before));
  });
});

describe('/modules/:slug', () => {
  it('shows the lessons, the exercise and the quiz', async () => {
    renderAt('/modules/neurons', NEURONS);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Neurons & perceptrons' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What a neuron computes/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the playground/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Take the quiz/ })).toBeInTheDocument();
  });

  it('shows the progress the API reports', async () => {
    renderAt('/modules/neurons', {
      'GET /api/v1/modules/neurons': {
        body: moduleDetail('neurons', {
          lessonsDone: 2,
          lessonStatus: {
            'what-a-neuron-computes': 'completed',
            'the-perceptron-rule': 'completed',
          },
          exerciseStatus: 'completed',
          tasksCompleted: ['separate-blobs', 'try-xor'],
        }),
      },
    });

    expect(await screen.findByText('2/3')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 tasks checked off/)).toBeInTheDocument();
  });

  it('404s a module the API does not have', async () => {
    renderAt('/modules/nope', {
      'GET /api/v1/modules/nope': {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Module "nope" not found' } },
      },
    });
    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
  });
});

describe('a lesson', () => {
  const lesson = lessonDetail('neurons', 'the-perceptron-rule');
  const routes = {
    ...NEURONS,
    [`GET /api/v1/lessons/${lesson.id}`]: { body: lesson },
  } satisfies Record<string, MockRoute>;

  it('renders the body with prev/next navigation', async () => {
    renderAt('/modules/neurons/lessons/the-perceptron-rule', routes);

    expect(
      await screen.findByRole('heading', { level: 1, name: /Learning by nudging/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('What a neuron computes')).toBeInTheDocument();
    expect(screen.getByText('Reading the code')).toBeInTheDocument();
  });

  it('marks the lesson complete through the API', async () => {
    const api = installApiMock({
      'GET /api/v1/health': HEALTH_OK,
      ...routes,
      [`PUT /api/v1/progress/lessons/${lesson.id}`]: {
        body: {
          lessonId: lesson.id,
          status: 'completed',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    render(
      <Providers path="/modules/neurons/lessons/the-perceptron-rule">
        <App />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /mark complete/i }));
    await waitFor(() => expect(api.calls).toContain(`PUT /api/v1/progress/lessons/${lesson.id}`));
    expect(api.bodies.at(-1)).toEqual({ status: 'completed' });
  });

  it('asks a signed-out reader to sign in', async () => {
    renderAt('/modules/neurons/lessons/the-perceptron-rule', {
      'GET /api/v1/modules/neurons': UNAUTHENTICATED,
    });
    expect(await screen.findByTestId('sign-in-panel')).toBeInTheDocument();
  });
});

describe('the exercise route', () => {
  it('mounts the playground with the learner’s saved state', async () => {
    const exercise = exerciseDetail('neurons', { state: { reflection: 'my earlier note' } });
    renderAt('/modules/neurons/exercise', {
      ...NEURONS,
      [`GET /api/v1/exercises/${exercise.id}`]: { body: exercise },
    });

    expect(await screen.findByTestId('perceptron-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('task-separate-blobs')).toBeInTheDocument();
  });

  it('says so, without crashing, for an exercise kind no milestone implements yet', async () => {
    // M11 filled in `harness`, so every kind that `content/` actually uses now has a
    // component. The two that remain unmapped are `embeddings` and `attention`: they have
    // config schemas of their own but Module 3 ships all three tabs as one `tokenizer`
    // record, so nothing seeds them. Standing one up by hand keeps the route's
    // "not implemented" branch covered rather than deleting a test because it went green
    // for the wrong reason.
    const exercise = { ...exerciseDetail('harnesses'), kind: 'embeddings' as const, config: {} };
    renderAt('/modules/harnesses/exercise', {
      'GET /api/v1/modules/harnesses': { body: moduleDetail('harnesses') },
      [`GET /api/v1/exercises/${exercise.id}`]: { body: exercise },
    });

    expect(await screen.findByText(/coming in a later milestone/i)).toBeInTheDocument();
  });
});

describe('the quiz route', () => {
  const quiz = quizDetail('neurons');
  const firstQuestion = quiz.questions[0]!;

  const gradedBody = {
    attemptId: quiz.id,
    quizId: quiz.id,
    submittedAt: new Date().toISOString(),
    scorePoints: 1,
    maxPoints: 8,
    fraction: 0.125,
    passThreshold: 0.7,
    passed: false,
    questions: [
      {
        questionId: firstQuestion.id,
        orderIndex: 1,
        isCorrect: true,
        pointsAwarded: 1,
        points: 1,
        answer: { optionIds: ['b'] },
        correct: { optionIds: ['b'] },
        explanationMd: 'z = 0, and the step activation outputs 1 at zero.',
      },
    ],
  };

  const routes = {
    ...NEURONS,
    [`GET /api/v1/quizzes/${quiz.id}`]: { body: quiz },
    [`GET /api/v1/quizzes/${quiz.id}/attempts`]: { body: { attempts: [] } },
  } satisfies Record<string, MockRoute>;

  it('renders the questions with no answers anywhere in the payload', async () => {
    renderAt('/modules/neurons/quiz', routes);

    expect(
      await screen.findByRole('heading', { level: 1, name: /Neurons & perceptrons quiz/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('0/8 answered')).toBeInTheDocument();
    expect(screen.queryByTestId('explanation')).not.toBeInTheDocument();
  });

  it('submits to the API and renders the returned explanations', async () => {
    installApiMock({
      'GET /api/v1/health': HEALTH_OK,
      ...routes,
      [`POST /api/v1/quizzes/${quiz.id}/attempts`]: { status: 201, body: gradedBody },
    });
    render(
      <Providers path="/modules/neurons/quiz">
        <App />
      </Providers>,
    );

    const options = await screen.findAllByRole('radio');
    fireEvent.click(options[1]!);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));

    const result = await screen.findByTestId('quiz-result');
    expect(result).toHaveTextContent('1/8');
    expect(result).toHaveTextContent(/not passed/i);
    // The explanation came from the API response, not from the bundle.
    expect(screen.getByText(/the step activation outputs 1 at zero/i)).toBeInTheDocument();
  });

  it('shows the attempt history', async () => {
    renderAt('/modules/neurons/quiz', {
      ...routes,
      [`GET /api/v1/quizzes/${quiz.id}/attempts`]: {
        body: {
          attempts: [
            {
              id: quiz.id,
              scorePoints: 7,
              maxPoints: 8,
              fraction: 0.875,
              passed: true,
              submittedAt: new Date('2026-01-02T03:04:05Z').toISOString(),
            },
          ],
        },
      },
    });

    const history = await screen.findByTestId('attempt-history');
    expect(history).toHaveTextContent('7/8');
    expect(history).toHaveTextContent(/passed/);
  });

  it('reports a failed submission without losing the answers', async () => {
    installApiMock({
      'GET /api/v1/health': HEALTH_OK,
      ...routes,
      [`POST /api/v1/quizzes/${quiz.id}/attempts`]: SERVER_ERROR,
    });
    render(
      <Providers path="/modules/neurons/quiz">
        <App />
      </Providers>,
    );

    const options = await screen.findAllByRole('radio');
    fireEvent.click(options[1]!);
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not submit/i);
    expect(options[1]!).toBeChecked();
  });
});

describe('the dashboard', () => {
  it('draws a ring per module and a continue link', async () => {
    renderAt('/', {
      'GET /api/v1/progress': {
        body: progressSummary({
          neurons: { lessonsDone: 3, exerciseDone: true, quizPassed: true },
        }),
      },
    });

    expect(await screen.findAllByTestId('dashboard-module')).toHaveLength(6);
    expect(screen.getByTestId('continue-link')).toHaveAttribute('href', '/modules/neural-networks');
    expect(screen.getByTestId('health-status')).toHaveTextContent('ok');
  });

  it('keeps working signed out, with one panel asking for a session', async () => {
    renderAt('/', { 'GET /api/v1/progress': UNAUTHENTICATED });

    expect(await screen.findByTestId('sign-in-panel')).toBeInTheDocument();
    expect(screen.getByTestId('health-status')).toHaveTextContent('ok');
    expect(screen.getByRole('link', { name: /browse the curriculum/i })).toBeInTheDocument();
  });
});
