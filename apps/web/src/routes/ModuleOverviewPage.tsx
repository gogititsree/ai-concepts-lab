import { ApiError } from '../lib/apiClient';
import { Link, useParams } from 'react-router';

import { Eyebrow, Panel } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import { useModule } from '../features/content/queries';
import { NotFound } from './NotFound';

const STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
} as const;

/**
 * One module: its lessons, its exercise and its quiz, each with the status the API has
 * for this learner. `GET /modules/:slug` answers all of that in one request, which is
 * also where the page gets the ids the lesson/exercise/quiz routes need.
 */
export function ModuleOverviewPage() {
  const { slug = '' } = useParams();
  const query = useModule(slug);

  // A 404 is not an error state, it is a page: the slug in the URL is wrong.
  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NotFound what={`Module "${slug}"`} />;
  }

  const fallback = queryFallback(query, {
    label: 'Loading the module…',
    signInFor: 'read this module',
  });
  if (fallback) return <div className="mx-auto max-w-2xl">{fallback}</div>;
  if (!query.data) return null;

  const { module, lessons, exercises, quiz } = query.data;
  const exercise = exercises[0];
  const best = quiz?.bestAttempt ?? null;
  const firstUnread = lessons.find((lesson) => lesson.status !== 'completed') ?? lessons[0];
  const requiredTasks =
    exercise && exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 1;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div>
        <Link to="/modules" className="eyebrow hover:text-ink">
          &larr; All modules
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">{module.title}</h1>
        <p className="text-muted mt-3 max-w-2xl leading-7">{module.summary}</p>

        <section className="mt-8">
          <Eyebrow>Lessons</Eyebrow>
          <ol className="border-rule divide-rule mt-2 divide-y overflow-hidden rounded-lg border">
            {lessons.map((lesson, index) => (
              <li key={lesson.slug} className="bg-surface">
                <Link
                  to={`/modules/${module.slug}/lessons/${lesson.slug}`}
                  className="hover:bg-sunk flex items-baseline gap-3 px-4 py-3 transition-colors"
                >
                  <span className="readout text-muted w-8 shrink-0 text-xs">
                    {module.orderIndex}.{index + 1}
                  </span>
                  <span className="flex-1 font-medium">{lesson.title}</span>
                  <span className="readout text-muted shrink-0 text-xs">
                    {lesson.status === 'completed' ? 'done' : `${lesson.estimatedMinutes} min`}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-8 grid gap-4 sm:grid-cols-2">
          {exercise && (
            <Panel className="p-5">
              <Eyebrow>Exercise</Eyebrow>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{exercise.title}</h2>
              <p className="text-muted mt-2 text-sm leading-6">
                {exercise.tasksCompleted.length > 0
                  ? `${exercise.tasksCompleted.length} of ${requiredTasks} tasks checked off.`
                  : 'Auto-checked tasks; your work is saved to your account.'}
              </p>
              <Link
                to={`/modules/${module.slug}/exercise`}
                className="readout border-ink bg-ink text-paper mt-4 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium hover:opacity-90"
              >
                Open the playground
              </Link>
            </Panel>
          )}

          {quiz && (
            <Panel className="p-5">
              <Eyebrow>Quiz</Eyebrow>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{quiz.title}</h2>
              <p className="text-muted mt-2 text-sm leading-6">
                {best
                  ? `Best attempt ${best.scorePoints}/${best.maxPoints} -- ${
                      best.passed ? 'passed' : 'not passed yet'
                    }.`
                  : `${quiz.questionCount} questions, ${Math.round(
                      quiz.passThreshold * 100,
                    )} % to pass.`}
              </p>
              <Link
                to={`/modules/${module.slug}/quiz`}
                className="readout border-rule bg-surface hover:bg-sunk mt-4 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
              >
                {best ? 'Retake the quiz' : 'Take the quiz'}
              </Link>
            </Panel>
          )}
        </section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Panel className="p-5">
          <Eyebrow>Your progress</Eyebrow>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Lessons</dt>
              <dd className="readout">
                {module.progress.lessonsDone}/{module.progress.lessonsTotal}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Exercise</dt>
              <dd className="readout">{STATUS_LABEL[exercise?.status ?? 'not_started']}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Quiz</dt>
              <dd className="readout">{best ? `${Math.round(best.fraction * 100)} %` : '--'}</dd>
            </div>
          </dl>
          {firstUnread && (
            <Link
              to={`/modules/${module.slug}/lessons/${firstUnread.slug}`}
              className="readout border-rule hover:bg-sunk mt-5 flex w-full items-center justify-center rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {module.progress.lessonsDone === 0 ? 'Start reading' : 'Continue'}
            </Link>
          )}
          <p className="text-muted mt-4 text-xs leading-5">
            Saved to your account, so it follows you between browsers.
          </p>
        </Panel>
      </aside>
    </div>
  );
}
