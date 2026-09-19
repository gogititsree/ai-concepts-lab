import { Link, useParams } from 'react-router';

import { Eyebrow, Panel } from '../components/ui';
import { getModule } from '../content/static';
import { EXERCISE_REGISTRY } from '../features/exercises/registry';
import { NotFound } from './NotFound';

export function ExercisePage() {
  const { slug = '' } = useParams();
  const module = getModule(slug);

  if (!module) return <NotFound what={`Module "${slug}"`} />;
  const exercise = module.exercises[0];
  if (!exercise) return <NotFound what={`An exercise for "${slug}"`} />;

  const Component = EXERCISE_REGISTRY[exercise.kind];

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to={`/modules/${module.slug}`} className="eyebrow hover:text-ink">
            &larr; {module.title}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{exercise.title}</h1>
        </div>
        <p className="readout text-muted text-xs">
          kind: {exercise.kind} &middot; nothing here is saved to a server yet
        </p>
      </header>

      {Component ? (
        <Component module={module} exercise={exercise} />
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
      )}
    </div>
  );
}
