import { Link } from 'react-router';

import { Eyebrow, Panel, ProgressRing } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import { useModules } from '../features/content/queries';

/**
 * The curriculum index, now from `GET /modules`. Six cards in reading order, because the
 * course is a sequence and the order carries information: a perceptron before a network
 * before a language model.
 *
 * The listing carries the caller's progress, so it needs a session — a signed-out visitor
 * gets the "sign in" panel in place rather than a redirect (see `QueryStates.tsx`).
 */
export function ModulesPage() {
  const modules = useModules();
  const fallback = queryFallback(modules, {
    label: 'Loading the curriculum…',
    signInFor: 'see the curriculum',
  });

  return (
    <div>
      <header className="max-w-2xl">
        <Eyebrow>Curriculum</Eyebrow>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance">
          Six modules, neurons to harnesses
        </h1>
        <p className="text-muted mt-3 leading-7">
          Each module is a few short lessons, one interactive exercise with auto-checked tasks, and
          a quiz at 70 %. Modules 1 and 2 run entirely in your browser on the same maths the test
          suite proves correct.
        </p>
      </header>

      {fallback ? (
        <div className="mt-8">{fallback}</div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {modules.data?.modules.map((module) => (
            <li key={module.slug}>
              <Panel className="hover:border-ink/40 h-full transition-colors">
                <Link
                  to={`/modules/${module.slug}`}
                  className="flex h-full flex-col gap-3 p-5"
                  data-testid="module-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Eyebrow>Module {module.orderIndex}</Eyebrow>
                    <ProgressRing fraction={module.progress.fraction} />
                  </div>
                  <h2 className="text-lg leading-snug font-semibold tracking-tight">
                    {module.title}
                  </h2>
                  <p className="text-muted flex-1 text-sm leading-6">{module.summary}</p>
                  <p className="readout text-muted flex flex-wrap items-center gap-x-3 text-xs">
                    <span>
                      {module.progress.lessonsDone}/{module.progress.lessonsTotal} lessons
                    </span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{module.counts.exercises} exercise</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{module.counts.quizQuestions} questions</span>
                    {module.requiresModel && (
                      <span className="border-rule text-muted rounded border px-1.5 py-0.5">
                        needs local model
                      </span>
                    )}
                  </p>
                </Link>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
