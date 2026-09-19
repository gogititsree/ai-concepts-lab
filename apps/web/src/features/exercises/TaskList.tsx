import { InlineMarkdown, Markdown } from '../../components/Markdown';
import { Eyebrow, Panel } from '../../components/ui';

/**
 * The auto-checked task list, shared by both exercises.
 *
 * Two states per task and they mean different things: **passing** is "true at this instant",
 * **completed** is "has been true at least once". A learner who hits 100 % and then drags a
 * point back over the line has still done the task; the tick stays. M7 moves the same
 * distinction server-side, where `tasks_completed` is a text[] that only grows.
 */

export interface TaskView {
  id: string;
  label: string;
  hintMd?: string;
  passing: boolean;
  completed: boolean;
  /** For tasks whose answer is a measurement, e.g. the smallest hidden size that worked. */
  recorded?: string;
}

export interface TaskListProps {
  tasks: TaskView[];
  required: number;
  reflectionMd?: string;
  reflection: string;
  onReflectionChange: (value: string) => void;
}

function Tick({ completed, passing }: { completed: boolean; passing: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[10px] ${
        completed
          ? 'border-ink bg-ink text-paper'
          : passing
            ? 'border-ink text-ink'
            : 'border-rule text-muted'
      }`}
    >
      {completed ? '✓' : ''}
    </span>
  );
}

export function TaskList({
  tasks,
  required,
  reflectionMd,
  reflection,
  onReflectionChange,
}: TaskListProps) {
  const completed = tasks.filter((task) => task.completed).length;
  const done = completed >= required;

  return (
    <Panel className="p-5" data-testid="task-list">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Tasks</Eyebrow>
        <span className="readout text-muted text-xs">
          {completed}/{required} to complete
        </span>
      </div>

      <ul className="mt-3 space-y-3">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-start gap-2.5" data-testid={`task-${task.id}`}>
            <Tick completed={task.completed} passing={task.passing} />
            <div className="min-w-0 flex-1">
              <p className={`text-sm leading-6 ${task.completed ? 'text-muted' : ''}`}>
                {task.label}
              </p>
              {task.recorded && (
                <p className="readout text-xs">
                  recorded: <span className="font-medium">{task.recorded}</span>
                </p>
              )}
              {task.hintMd && !task.completed && (
                <InlineMarkdown className="text-muted mt-1 text-xs leading-5">
                  {task.hintMd}
                </InlineMarkdown>
              )}
            </div>
          </li>
        ))}
      </ul>

      {done && reflectionMd && (
        <div className="border-rule mt-5 border-t pt-4">
          <Eyebrow>What did you notice?</Eyebrow>
          <Markdown className="text-sm [&_p]:my-2 [&_p]:leading-6">{reflectionMd}</Markdown>
          <label className="mt-2 block">
            <span className="sr-only">Your reflection</span>
            <textarea
              className="border-rule bg-surface min-h-24 w-full rounded-md border p-2 text-sm leading-6"
              placeholder="A sentence is enough."
              value={reflection}
              onChange={(event) => onReflectionChange(event.target.value)}
            />
          </label>
        </div>
      )}
    </Panel>
  );
}
