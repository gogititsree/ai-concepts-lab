import { Link, useParams } from 'react-router';

import { Eyebrow, Panel } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import { useExercise, useModule } from '../features/content/queries';
import { EXERCISE_REGISTRY } from '../features/exercises/registry';
import { ApiError } from '../lib/apiClient';
import { NotFound } from './NotFound';

/**
 * The module's playground. The module gives the exercise id; `GET /exercises/:id` gives
 * the config *and* the learner's saved `state`, which is why the component below is not
 * mounted until that second request has landed — a playground that seeded itself from
 * defaults and then had state arrive underneath it would lose the first edit.
 */
export function ExercisePage() {
  const { slug = '' } = useParams();
  const moduleQuery = useModule(slug);
  const exerciseId = moduleQuery.data?.exercises[0]?.id;
  const exerciseQuery = useExercise(exerciseId);

  if (moduleQuery.error instanceof ApiError && moduleQuery.error.status === 404) {
    return <NotFound what={`Module "${slug}"`} />;
  }
  const moduleFallback = queryFallback(moduleQuery, {
    label: 'Loading the exercise…',
    signInFor: 'use the playground',
  });
  if (moduleFallback) return <div className="mx-auto max-w-2xl">{moduleFallback}</div>;
  if (!moduleQuery.data) return null;

  const module = moduleQuery.data.module;
  if (!exerciseId) return <NotFound what={`An exercise for "${slug}"`} />;

  const exerciseFallback = queryFallback(exerciseQuery, {
    label: 'Loading your saved work…',
    signInFor: 'use the playground',
  });
  const exercise = exerciseQuery.data;
  const Component = exercise ? EXERCISE_REGISTRY[exercise.kind] : undefined;

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to={`/modules/${module.slug}`} className="eyebrow hover:text-ink">
            &larr; {module.title}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {exercise?.title ?? moduleQuery.data.exercises[0]?.title}
          </h1>
        </div>
        <p className="readout text-muted text-xs">
          kind: {moduleQuery.data.exercises[0]?.kind} &middot; saved to your account
        </p>
      </header>

      {exerciseFallback}

      {exercise &&
        (Component ? (
          <Component exercise={exercise} />
        ) : (
          <Panel className="p-8 text-center">
            <Eyebrow>Not built yet</Eyebrow>
            <p className="mt-2 text-lg font-medium">
              The <code>{exercise.kind}</code> playground is coming in a later milestone.
            </p>
            <p className="text-muted mx-auto mt-2 max-w-md text-sm leading-6">
              The content for it already exists and is validated -- only the interface is missing.
              Modules 1 and 2 are playable today.
            </p>
            <Link
              to="/modules"
              className="readout border-rule hover:bg-sunk mt-5 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              Back to the modules
            </Link>
          </Panel>
        ))}
    </div>
  );
}
