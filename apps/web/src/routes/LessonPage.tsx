import { useEffect } from 'react';
import { Link, useParams } from 'react-router';

import { Markdown } from '../components/Markdown';
import { Button, Eyebrow } from '../components/ui';
import { getLesson } from '../content/static';
import { useProgress } from '../hooks/useProgress';
import { lessonKey, setLessonStatus } from '../lib/localProgress';
import { NotFound } from './NotFound';

export function LessonPage() {
  const { slug = '', lessonSlug = '' } = useParams();
  const found = getLesson(slug, lessonSlug);
  const progress = useProgress();

  // A new lesson starts at the top and starts at the top of the page.
  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [slug, lessonSlug]);

  if (!found) return <NotFound what={`Lesson "${lessonSlug}"`} />;
  const { module, lesson, previous, next } = found;
  const status = progress.lessons[lessonKey(module.slug, lesson.slug)]?.status ?? 'not_started';
  const isComplete = status === 'completed';

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
          Lesson {module.orderIndex}.{lesson.orderIndex} &middot; {lesson.estimatedMinutes} min
        </Eyebrow>
      </nav>

      <Markdown className="mt-6">{lesson.bodyMd}</Markdown>

      <div className="border-rule mt-10 flex flex-wrap items-center gap-3 border-t pt-6">
        <Button
          variant={isComplete ? 'secondary' : 'primary'}
          aria-pressed={isComplete}
          onClick={() =>
            setLessonStatus(module.slug, lesson.slug, isComplete ? 'in_progress' : 'completed')
          }
        >
          {isComplete ? 'Completed -- undo' : 'Mark complete'}
        </Button>
        {module.exercises[0] && (
          <Link
            to={`/modules/${module.slug}/exercise`}
            className="readout text-muted hover:text-ink px-2 py-1.5 text-xs"
          >
            Open the exercise
          </Link>
        )}
      </div>

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
