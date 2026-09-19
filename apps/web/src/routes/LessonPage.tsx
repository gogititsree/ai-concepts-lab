import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { Markdown } from '../components/Markdown';
import { Button, Eyebrow } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import { useLesson, useModule, useSetLessonStatus } from '../features/content/queries';
import { ApiError } from '../lib/apiClient';
import { NotFound } from './NotFound';

/**
 * A lesson. Two requests, not one: the module gives the lesson's id (the router only
 * knows slugs) and the prev/next chain, and `GET /lessons/:id` gives the Markdown body.
 * Both are cached, so walking a module fetches each module once and each body once.
 */
export function LessonPage() {
  const { slug = '', lessonSlug = '' } = useParams();
  const moduleQuery = useModule(slug);
  const setStatus = useSetLessonStatus();

  const lessons = moduleQuery.data?.lessons ?? [];
  const index = lessons.findIndex((entry) => entry.slug === lessonSlug);
  const summary = index === -1 ? undefined : lessons[index];
  const lessonQuery = useLesson(summary?.id);

  // A new lesson starts at the top of the page.
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [slug, lessonSlug]);

  if (moduleQuery.error instanceof ApiError && moduleQuery.error.status === 404) {
    return <NotFound what={`Module "${slug}"`} />;
  }
  const moduleFallback = queryFallback(moduleQuery, {
    label: 'Loading the lesson…',
    signInFor: 'read the lessons',
  });
  if (moduleFallback) return <div className="mx-auto max-w-2xl">{moduleFallback}</div>;
  if (!moduleQuery.data) return null;
  if (index === -1) return <NotFound what={`Lesson "${lessonSlug}"`} />;

  const lessonFallback = queryFallback(lessonQuery, {
    label: 'Loading the lesson…',
    signInFor: 'read the lessons',
  });

  const module = moduleQuery.data.module;
  const previous = lessons[index - 1];
  const next = lessons[index + 1];
  const lesson = lessonQuery.data;
  const isComplete = (lesson?.status ?? summary?.status) === 'completed';

  return (
    <article className="mx-auto max-w-2xl">
      <nav className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/modules/${module.slug}`} className="eyebrow hover:text-ink">
          {module.title}
        </Link>
        <span className="eyebrow" aria-hidden="true">
          /
        </span>
        <Eyebrow>
          Lesson {module.orderIndex}.{summary?.orderIndex ?? index + 1} &middot;{' '}
          {summary?.estimatedMinutes ?? 0} min
        </Eyebrow>
      </nav>

      {lessonFallback ?? <Markdown className="mt-6">{lesson?.bodyMd ?? ''}</Markdown>}

      {lesson && (
        <div className="border-rule mt-10 flex flex-wrap items-center gap-3 border-t pt-6">
          <Button
            variant={isComplete ? 'secondary' : 'primary'}
            aria-pressed={isComplete}
            disabled={setStatus.isPending}
            onClick={() =>
              setStatus.mutate({
                lessonId: lesson.id,
                status: isComplete ? 'in_progress' : 'completed',
              })
            }
          >
            {isComplete ? 'Completed -- undo' : 'Mark complete'}
          </Button>
          {moduleQuery.data.exercises[0] && (
            <Link
              to={`/modules/${module.slug}/exercise`}
              className="readout text-muted hover:text-ink px-2 py-1.5 text-xs"
            >
              Open the exercise
            </Link>
          )}
          {setStatus.error && (
            <span className="readout text-xs" role="alert">
              Could not save: {setStatus.error.message}
            </span>
          )}
        </div>
      )}

      <nav className="mt-6 grid gap-3 sm:grid-cols-2" aria-label="Lesson navigation">
        {previous ? (
          <Link
            to={`/modules/${module.slug}/lessons/${previous.slug}`}
            className="border-rule bg-surface hover:border-ink/40 rounded-lg border p-4 transition-colors"
          >
            <Eyebrow>Previous</Eyebrow>
            <p className="mt-1 text-sm font-medium">{previous.title}</p>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link
            to={`/modules/${module.slug}/lessons/${next.slug}`}
            className="border-rule bg-surface hover:border-ink/40 rounded-lg border p-4 text-right transition-colors"
          >
            <Eyebrow>Next</Eyebrow>
            <p className="mt-1 text-sm font-medium">{next.title}</p>
          </Link>
        ) : (
          <Link
            to={`/modules/${module.slug}/quiz`}
            className="border-rule bg-surface hover:border-ink/40 rounded-lg border p-4 text-right transition-colors"
          >
            <Eyebrow>Last lesson</Eyebrow>
            <p className="mt-1 text-sm font-medium">Take the quiz</p>
          </Link>
        )}
      </nav>
    </article>
  );
}
