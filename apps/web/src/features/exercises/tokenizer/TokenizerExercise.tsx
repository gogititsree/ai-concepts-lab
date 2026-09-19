import { useEffect, useMemo, useState } from 'react';

import { Panel } from '../../../components/ui';
import { parseExerciseConfig } from '../../content/exerciseConfig';
import { useExercisePersistence } from '../../content/useExercisePersistence';
import { AttentionTab } from '../attention/AttentionTab';
import type { AttentionAnswer } from '../attention/checks';
import { EmbeddingsTab } from '../embeddings/EmbeddingsTab';
import type { NeighbourAnswer } from '../embeddings/checks';
import type { ExerciseComponentProps } from '../registry';
import { TaskList, type TaskView } from '../TaskList';
import { evaluateTokenizerTasks, type TokenizeAnswer } from './checks';
import { TokenizerTab } from './TokenizerTab';

/**
 * Module 3's exercise: one record of kind `tokenizer`, three tabs.
 *
 * Why one record rather than three (docs/04-curriculum.md decided this, and it is worth
 * knowing why): the three tabs are one pipeline — text becomes tokens becomes vectors
 * becomes a weighted mix — and the completion rule is "2 of 3 tasks", which needs a
 * single `tasks_completed` array to count against. Three exercise rows would give three
 * progress rings for one idea.
 *
 * **No Zustand store here**, unlike the perceptron and MLP playgrounds. Those keep state
 * outside React because a `requestAnimationFrame` loop mutates it at 60 fps and
 * re-rendering the tree that often would drop frames. Nothing here animates: the
 * expensive computations (BPE training, PCA) are `useMemo`s keyed on their inputs, and
 * everything else is a value a human typed. Adding a store would be ceremony.
 *
 * The three answers are held here rather than in the tabs so that switching tab does not
 * lose one, and mirrored into the saved exercise state so a reload does not either.
 */

type TabId = 'tokenizer' | 'embeddings' | 'attention';

const TAB_LABELS: Record<TabId, string> = {
  tokenizer: 'Tokenizer',
  embeddings: 'Embeddings',
  attention: 'Attention',
};

interface SavedAnswers {
  tokenize: TokenizeAnswer;
  neighbour: NeighbourAnswer;
  attention: AttentionAnswer;
}

const EMPTY_ANSWERS: SavedAnswers = {
  tokenize: { tokenized: [], answerSentenceId: null },
  neighbour: { word: null },
  attention: { keyIndex: null },
};

/**
 * `state` is an untyped jsonb blob from the API, so everything read out of it is checked.
 * A shape that no longer matches (a content edit, an older save) degrades to "unanswered"
 * rather than crashing the playground — the task ids the *server* has recorded are the
 * durable record, and they are unaffected.
 */
function readSavedAnswers(state: Record<string, unknown> | null | undefined): SavedAnswers {
  const saved = state?.answers;
  if (!saved || typeof saved !== 'object') return EMPTY_ANSWERS;
  const raw = saved as Record<string, unknown>;

  const tokenize = (raw.tokenize ?? {}) as Record<string, unknown>;
  const neighbour = (raw.neighbour ?? {}) as Record<string, unknown>;
  const attention = (raw.attention ?? {}) as Record<string, unknown>;

  return {
    tokenize: {
      tokenized: Array.isArray(tokenize.tokenized)
        ? tokenize.tokenized.filter((id): id is string => typeof id === 'string')
        : [],
      answerSentenceId:
        typeof tokenize.answerSentenceId === 'string' ? tokenize.answerSentenceId : null,
    },
    neighbour: { word: typeof neighbour.word === 'string' ? neighbour.word : null },
    attention: {
      keyIndex: typeof attention.keyIndex === 'number' ? attention.keyIndex : null,
    },
  };
}

export function TokenizerExercise({ exercise }: ExerciseComponentProps) {
  const config = parseExerciseConfig('tokenizer', exercise.config);
  const saved = useExercisePersistence(exercise);
  const { reportTasks, patchState } = saved;

  const tabs = config.tabs as TabId[];
  const [tab, setTab] = useState<TabId>(() => tabs[0] ?? 'tokenizer');
  const [answers, setAnswers] = useState<SavedAnswers>(() => readSavedAnswers(exercise.state));

  // Which task (if any) each tab is serving, so a tab only renders its answer control
  // when the content file actually asks the question.
  const neighbourTask = config.tasks.find((task) => task.check.kind === 'neighbour');
  const attentionTask = config.tasks.find((task) => task.check.kind === 'attention-row');

  const passing = useMemo(
    () => evaluateTokenizerTasks(config, answers),
    // `config` is re-parsed on every render (a fresh object each time), so keying the
    // memo on it would defeat it; the answers are the only thing that can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answers],
  );
  const passingKey = passing.join(',');

  useEffect(() => {
    if (passingKey === '') return;
    reportTasks(passingKey.split(','));
  }, [passingKey, reportTasks]);

  const answersKey = JSON.stringify(answers);
  useEffect(() => {
    patchState({ answers: JSON.parse(answersKey) as Record<string, unknown> });
  }, [answersKey, patchState]);

  const required = exercise.completionRule.type === 'tasks' ? exercise.completionRule.required : 1;
  const completedIds = new Set(saved.tasksCompleted);
  const taskViews: TaskView[] = config.tasks.map((task) => ({
    id: task.id,
    label: task.label,
    hintMd: task.hintMd,
    passing: passing.includes(task.id),
    completed: completedIds.has(task.id),
  }));

  const [reflection, setReflection] = useState<string>(
    typeof exercise.state?.reflection === 'string' ? exercise.state.reflection : '',
  );

  return (
    <div className="space-y-5">
      <Panel className="p-2">
        <div
          role="tablist"
          aria-label="Tokens, embeddings and attention"
          className="flex flex-wrap gap-1"
        >
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`panel-${id}`}
              onClick={() => setTab(id)}
              className={`readout rounded-md px-3 py-1.5 text-xs font-medium tracking-wide transition-colors ${
                tab === id ? 'bg-ink text-paper' : 'text-muted hover:bg-sunk hover:text-ink'
              }`}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>
      </Panel>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'tokenizer' && (
          <TokenizerTab
            config={config.tokenizer}
            answer={answers.tokenize}
            onAnswerChange={(tokenize) => setAnswers((current) => ({ ...current, tokenize }))}
          />
        )}
        {tab === 'embeddings' && (
          <EmbeddingsTab
            config={config.embeddings}
            answer={answers.neighbour}
            onAnswerChange={(neighbour) => setAnswers((current) => ({ ...current, neighbour }))}
            {...(neighbourTask?.check.kind === 'neighbour'
              ? { targetWord: neighbourTask.check.targetWord }
              : {})}
          />
        )}
        {tab === 'attention' && (
          <AttentionTab
            config={config.attention}
            answer={answers.attention}
            onAnswerChange={(attention) => setAnswers((current) => ({ ...current, attention }))}
            {...(attentionTask?.check.kind === 'attention-row'
              ? { taskQueryIndex: attentionTask.check.queryIndex }
              : {})}
          />
        )}
      </div>

      <TaskList
        tasks={taskViews}
        required={required}
        reflectionMd={config.reflectionMd}
        reflection={reflection}
        onReflectionChange={(value) => {
          setReflection(value);
          patchState({ reflection: value });
        }}
      />
    </div>
  );
}
