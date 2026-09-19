import { Link } from 'react-router';

import { Eyebrow, Panel, ProgressRing } from '../components/ui';
import { modules } from '../content/static';
import { useProgress } from '../hooks/useProgress';
import { summariseModule } from '../lib/localProgress';

/**
 * The curriculum index. Six cards in reading order, because the course is a sequence and the
 * order carries information: a perceptron before a network before a language model.
 */
export function ModulesPage() {
  const progress = useProgress();

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

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map((module) => {
          const summary = summariseModule(progress, module);
          return (
            <li key={module.slug}>
              <Panel className="hover:border-ink/40 h-full transition-colors">
                <Link
                  to={`/modules/${module.slug}`}
                  className="flex h-full flex-col gap-3 p-5"
                  data-testid="module-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Eyebrow>Module {module.orderIndex}</Eyebrow>
                    <ProgressRing fraction={summary.fraction} />
                  </div>
                  <h2 className="text-lg leading-snug font-semibold tracking-tight">
                    {module.title}
                  </h2>
                  <p className="text-muted flex-1 text-sm leading-6">{module.summary}</p>
                  <p className="readout text-muted flex flex-wrap items-center gap-x-3 text-xs">
                    <span>
                      {summary.lessonsCompleted}/{summary.lessonCount} lessons
                    </span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{module.exercises.length} exercise</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{module.quiz.questions.length} questions</span>
                    {module.requiresModel && (
                      <span className="border-rule text-muted rounded border px-1.5 py-0.5">
                        needs local model
                      </span>
                    )}
                  </p>
                </Link>
              </Panel>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
