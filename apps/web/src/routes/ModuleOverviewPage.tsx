import { Link, useParams } from 'react-router';

import { Eyebrow, Panel } from '../components/ui';
import { getModule } from '../content/static';
import { useProgress } from '../hooks/useProgress';
import { exerciseKey, lessonKey, summariseModule } from '../lib/localProgress';
import { NotFound } from './NotFound';

const STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
} as const;

export function ModuleOverviewPage() {
  const { slug = '' } = useParams();
  const module = getModule(slug);
  const progress = useProgress();

  if (!module) return <NotFound what={`Module "${slug}"`} />;

  const summary = summariseModule(progress, module);
  const exercise = module.exercises[0];
  const exerciseStatus = exercise
    ? (progress.exercises[exerciseKey(module.slug, exercise.slug)] ?? null)
    : null;
  const quiz = progress.quizzes[module.slug] ?? null;
  const firstUnread =
    module.lessons.find(
      (lesson) => progress.lessons[lessonKey(module.slug, lesson.slug)]?.status !== 'completed',
    ) ?? module.lessons[0];

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
            {module.lessons.map((lesson, index) => {
              const status = progress.lessons[lessonKey(module.slug, lesson.slug)]?.status;
              return (
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
                      {status === 'completed' ? 'done' : `${lesson.estimatedMinutes} min`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="mt-8 grid gap-4 sm:grid-cols-2">
          {exercise && (
            <Panel className="p-5">
              <Eyebrow>Exercise</Eyebrow>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">{exercise.title}</h2>
              <p className="text-muted mt-2 text-sm leading-6">
                {exerciseStatus
                  ? `${exerciseStatus.tasksCompleted.length} of ${
                      exercise.completionRule.type === 'tasks'
                        ? exercise.completionRule.required
                        : 1
                    } tasks checked off.`
                  : 'Auto-checked tasks; your work stays in this browser.'}
              </p>
              <Link
                to={`/modules/${module.slug}/exercise`}
                className="readout border-ink bg-ink text-paper mt-4 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium hover:opacity-90"
              >
                Open the playground
              </Link>
            </Panel>
          )}

          <Panel className="p-5">
            <Eyebrow>Quiz</Eyebrow>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{module.quiz.title}</h2>
            <p className="text-muted mt-2 text-sm leading-6">
              {quiz
                ? `Best attempt ${quiz.scorePoints}/${quiz.maxPoints} -- ${
                    quiz.passed ? 'passed' : 'not passed yet'
                  }.`
                : `${module.quiz.questions.length} questions, ${Math.round(
                    module.quiz.passThreshold * 100,
                  )} % to pass.`}
            </p>
            <Link
              to={`/modules/${module.slug}/quiz`}
              className="readout border-rule bg-surface hover:bg-sunk mt-4 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {quiz ? 'Retake the quiz' : 'Take the quiz'}
            </Link>
          </Panel>
        </section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <Panel className="p-5">
          <Eyebrow>Your progress</Eyebrow>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Lessons</dt>
              <dd className="readout">
                {summary.lessonsCompleted}/{summary.lessonCount}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Exercise</dt>
              <dd className="readout">{STATUS_LABEL[summary.exerciseStatus]}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Quiz</dt>
              <dd className="readout">
                {quiz ? `${Math.round((quiz.scorePoints / quiz.maxPoints) * 100)} %` : '--'}
              </dd>
            </div>
          </dl>
          {firstUnread && (
            <Link
              to={`/modules/${module.slug}/lessons/${firstUnread.slug}`}
              className="readout border-rule hover:bg-sunk mt-5 flex w-full items-center justify-center rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {summary.lessonsCompleted === 0 ? 'Start reading' : 'Continue'}
            </Link>
          )}
          <p className="text-muted mt-4 text-xs leading-5">
            Kept in this browser until the progress API lands in M7.
          </p>
        </Panel>
      </aside>
    </div>
  );
}
