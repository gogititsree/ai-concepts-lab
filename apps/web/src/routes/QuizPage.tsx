import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { InlineMarkdown, Markdown } from '../components/Markdown';
import { Button, Eyebrow, Panel } from '../components/ui';
import { getModule } from '../content/static';
import { recordQuizAttempt } from '../lib/localProgress';
import { gradeQuiz, type GradedQuiz, type QuizAnswer } from '../lib/quizGrading';
import { NotFound } from './NotFound';

/**
 * TODO(M7): the quiz is graded here, in the browser, against answers that ship in the bundle.
 * `POST /quizzes/:id/attempts` takes this over and `GET /quizzes/:id` stops serving `correct`
 * at all. The grading rules live in `lib/quizGrading.ts` precisely so the server can be diffed
 * against them.
 */
export function QuizPage() {
  const { slug = '' } = useParams();
  const module = getModule(slug);
  const [answers, setAnswers] = useState<(QuizAnswer | undefined)[]>([]);
  const [result, setResult] = useState<GradedQuiz | null>(null);

  if (!module) return <NotFound what={`Module "${slug}"`} />;
  const quiz = module.quiz;

  const setAnswer = (index: number, answer: QuizAnswer): void => {
    setAnswers((current) => {
      const next = [...current];
      next[index] = answer;
      return next;
    });
  };

  const submit = (): void => {
    const graded = gradeQuiz(quiz, answers);
    setResult(graded);
    recordQuizAttempt(module.slug, {
      scorePoints: graded.scorePoints,
      maxPoints: graded.maxPoints,
      passed: graded.passed,
      submittedAt: new Date().toISOString(),
    });
    window.scrollTo?.(0, 0);
  };

  const answeredCount = quiz.questions.filter((_, index) => answers[index] !== undefined).length;

  return (
    <div className="mx-auto max-w-2xl">
      <Link to={`/modules/${module.slug}`} className="eyebrow hover:text-ink">
        &larr; {module.title}
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">{quiz.title}</h1>
      <p className="text-muted mt-2 text-sm">
        {quiz.questions.length} questions &middot; {Math.round(quiz.passThreshold * 100)} % to pass.
      </p>

      {result && (
        <Panel
          className={`mt-6 p-5 ${result.passed ? 'border-ink' : ''}`}
          data-testid="quiz-result"
        >
          <Eyebrow>{result.passed ? 'Passed' : 'Not passed'}</Eyebrow>
          <p className="readout mt-1 text-2xl font-semibold">
            {result.scorePoints}/{result.maxPoints}
            <span className="text-muted ml-2 text-base">
              ({Math.round(result.fraction * 100)} %)
            </span>
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setResult(null);
                setAnswers([]);
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

      <ol className="mt-6 space-y-4">
        {quiz.questions.map((question, index) => {
          const graded = result?.perQuestion[index];
          const answer = answers[index];
          const selected = answer?.kind === 'choice' ? answer.optionIds : [];

          return (
            <li key={index}>
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
                          name={`question-${index}`}
                          value={option.id}
                          checked={selected.includes(option.id)}
                          onChange={(event) => {
                            const optionIds =
                              question.kind === 'multi_choice'
                                ? event.target.checked
                                  ? [...selected, option.id]
                                  : selected.filter((id) => id !== option.id)
                                : [option.id];
                            setAnswer(index, { kind: 'choice', optionIds });
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
                        setAnswer(index, {
                          kind: 'numeric',
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
                      onChange={(event) =>
                        setAnswer(index, { kind: 'text', text: event.target.value })
                      }
                    />
                  </label>
                )}

                {graded && (
                  <div className="border-rule mt-4 border-t pt-3">
                    <Eyebrow>Explanation</Eyebrow>
                    <Markdown className="text-sm [&_p]:my-2 [&_p]:leading-6">
                      {question.explanationMd}
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
          <Button variant="primary" onClick={submit}>
            Submit answers
          </Button>
          <span className="readout text-muted text-xs">
            {answeredCount}/{quiz.questions.length} answered
          </span>
        </div>
      )}
    </div>
  );
}
