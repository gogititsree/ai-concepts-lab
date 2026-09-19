import type { QuizAnswer, QuizAttemptResult } from '@lab/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { InlineMarkdown, Markdown } from '../components/Markdown';
import { Button, Eyebrow, Panel } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import {
  useModule,
  useQuiz,
  useQuizAttempts,
  useSubmitQuizAttempt,
} from '../features/content/queries';
import { ApiError } from '../lib/apiClient';
import { describeCorrect, formatPercent, isAnswered, selectedOptionIds } from '../lib/quizGrading';
import { NotFound } from './NotFound';

/**
 * The quiz, graded by the server.
 *
 * `GET /quizzes/:id` gives prompts, options and points — and nothing else; the answers
 * and the explanations only exist in the response to `POST /quizzes/:id/attempts`. So
 * this page has no notion of a right answer until it has submitted one, which is exactly
 * the property the "never leak `correct`" rule is protecting.
 */
export function QuizPage() {
  const { slug = '' } = useParams();
  const moduleQuery = useModule(slug);
  const quizId = moduleQuery.data?.quiz?.id;
  const quizQuery = useQuiz(quizId);
  const attemptsQuery = useQuizAttempts(quizId);
  const submit = useSubmitQuizAttempt();

  const [answers, setAnswers] = useState<Record<string, QuizAnswer>>({});
  const [result, setResult] = useState<QuizAttemptResult | null>(null);

  if (moduleQuery.error instanceof ApiError && moduleQuery.error.status === 404) {
    return <NotFound what={`Module "${slug}"`} />;
  }
  const moduleFallback = queryFallback(moduleQuery, {
    label: 'Loading the quiz…',
    signInFor: 'take the quiz',
  });
  if (moduleFallback) return <div className="mx-auto max-w-2xl">{moduleFallback}</div>;
  if (!moduleQuery.data) return null;
  if (!quizId) return <NotFound what={`A quiz for "${slug}"`} />;

  const quizFallback = queryFallback(quizQuery, {
    label: 'Loading the quiz…',
    signInFor: 'take the quiz',
  });
  if (quizFallback) return <div className="mx-auto max-w-2xl">{quizFallback}</div>;
  if (!quizQuery.data) return null;

  const quiz = quizQuery.data;
  const module = moduleQuery.data.module;
  const gradedById = new Map((result?.questions ?? []).map((q) => [q.questionId, q]));
  const answeredCount = quiz.questions.filter((q) => isAnswered(answers[q.id])).length;
  const history = attemptsQuery.data?.attempts ?? [];

  const setAnswer = (questionId: string, answer: QuizAnswer): void => {
    setAnswers((current) => ({ ...current, [questionId]: answer }));
  };

  const onSubmit = (): void => {
    submit.mutate(
      {
        quizId,
        answers: quiz.questions
          .filter((question) => isAnswered(answers[question.id]))
          .map((question) => ({ questionId: question.id, answer: answers[question.id]! })),
      },
      {
        onSuccess: (graded) => {
          setResult(graded);
          window.scrollTo?.(0, 0);
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link to={`/modules/${module.slug}`} className="eyebrow hover:text-ink">
        &larr; {module.title}
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">{quiz.title}</h1>
      <p className="text-muted mt-2 text-sm">
        {quiz.questions.length} questions &middot; {formatPercent(quiz.passThreshold)} to pass.
      </p>

      {result && (
        <Panel
          className={`mt-6 p-5 ${result.passed ? 'border-ink' : ''}`}
          data-testid="quiz-result"
        >
          <Eyebrow>{result.passed ? 'Passed' : 'Not passed'}</Eyebrow>
          <p className="readout mt-1 text-2xl font-semibold">
            {result.scorePoints}/{result.maxPoints}
            <span className="text-muted ml-2 text-base">({formatPercent(result.fraction)})</span>
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setResult(null);
                setAnswers({});
              }}
            >
              Try again
            </Button>
            <Link
              to={`/modules/${module.slug}`}
              className="readout text-muted hover:text-ink px-2 py-1.5 text-xs"
            >
              Back to the module
            </Link>
          </div>
        </Panel>
      )}

      {submit.error && (
        <Panel className="mt-6 p-4" role="alert">
          <p className="text-sm">
            Could not submit the quiz: {submit.error.message}
            {submit.error instanceof ApiError && submit.error.isUnauthenticated && (
              <>
                {' '}
                <Link to="/login" className="underline">
                  Sign in
                </Link>{' '}
                and try again.
              </>
            )}
          </p>
        </Panel>
      )}

      <ol className="mt-6 space-y-4">
        {quiz.questions.map((question, index) => {
          const graded = gradedById.get(question.id);
          const selected = selectedOptionIds(answers[question.id]);

          return (
            <li key={question.id}>
              <Panel
                className={`p-5 ${graded ? (graded.isCorrect ? 'border-ink' : 'border-pos') : ''}`}
              >
                <div className="flex items-baseline gap-3">
                  <span className="readout text-muted text-xs">Q{index + 1}</span>
                  <div className="flex-1">
                    <InlineMarkdown className="leading-7">{question.promptMd}</InlineMarkdown>
                  </div>
                  {graded && (
                    <span className="readout text-xs">
                      {graded.isCorrect ? 'correct' : 'wrong'}
                    </span>
                  )}
                </div>

                {question.options && (
                  <fieldset className="mt-4 space-y-2" disabled={result !== null}>
                    <legend className="sr-only">
                      {question.kind === 'multi_choice' ? 'Select all that apply' : 'Select one'}
                    </legend>
                    {question.options.map((option) => (
                      <label
                        key={option.id}
                        className="hover:bg-sunk flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5"
                      >
                        <input
                          className="accent-ink mt-1.5"
                          type={question.kind === 'multi_choice' ? 'checkbox' : 'radio'}
                          name={`question-${question.id}`}
                          value={option.id}
                          checked={selected.includes(option.id)}
                          onChange={(event) => {
                            const optionIds =
                              question.kind === 'multi_choice'
                                ? event.target.checked
                                  ? [...selected, option.id]
                                  : selected.filter((id) => id !== option.id)
                                : [option.id];
                            setAnswer(question.id, { optionIds });
                          }}
                        />
                        <InlineMarkdown className="text-sm leading-6">
                          {option.textMd}
                        </InlineMarkdown>
                      </label>
                    ))}
                  </fieldset>
                )}

                {question.kind === 'numeric' && (
                  <label className="mt-4 block">
                    <span className="eyebrow">Your answer</span>
                    <input
                      type="number"
                      step="any"
                      disabled={result !== null}
                      className="readout border-rule bg-surface mt-1 w-40 rounded-md border px-2 py-1.5 text-sm"
                      onChange={(event) =>
                        setAnswer(question.id, {
                          value: event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                )}

                {question.kind === 'short_text' && (
                  <label className="mt-4 block">
                    <span className="eyebrow">Your answer</span>
                    <input
                      type="text"
                      disabled={result !== null}
                      className="border-rule bg-surface mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                      onChange={(event) => setAnswer(question.id, { text: event.target.value })}
                    />
                  </label>
                )}

                {graded && (
                  <div className="border-rule mt-4 border-t pt-3" data-testid="explanation">
                    {!graded.isCorrect && (
                      <p className="readout text-muted text-xs">
                        Correct answer:{' '}
                        <span className="text-ink">
                          {describeCorrect(question.kind, graded.correct, question.options)}
                        </span>
                      </p>
                    )}
                    <Eyebrow>Explanation</Eyebrow>
                    <Markdown className="text-sm [&_p]:my-2 [&_p]:leading-6">
                      {graded.explanationMd}
                    </Markdown>
                  </div>
                )}
              </Panel>
            </li>
          );
        })}
      </ol>

      {!result && (
        <div className="border-rule mt-6 flex flex-wrap items-center gap-3 border-t pt-6">
          <Button variant="primary" onClick={onSubmit} disabled={submit.isPending}>
            {submit.isPending ? 'Submitting…' : 'Submit answers'}
          </Button>
          <span className="readout text-muted text-xs">
            {answeredCount}/{quiz.questions.length} answered
          </span>
        </div>
      )}

      {history.length > 0 && (
        <section className="mt-10" data-testid="attempt-history">
          <Eyebrow>Previous attempts</Eyebrow>
          <ol className="border-rule divide-rule mt-2 divide-y overflow-hidden rounded-lg border">
            {history.map((attempt) => (
              <li
                key={attempt.id}
                className="bg-surface flex items-baseline justify-between gap-3 px-4 py-2 text-sm"
              >
                <span className="readout text-muted text-xs">
                  {new Date(attempt.submittedAt).toLocaleString()}
                </span>
                <span className="readout">
                  {attempt.scorePoints}/{attempt.maxPoints}
                  <span className="text-muted ml-2 text-xs">
                    {attempt.passed ? 'passed' : 'not passed'}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
