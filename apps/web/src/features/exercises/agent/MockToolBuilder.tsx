import type { MockToolDefinition } from '@lab/shared';
import { useState } from 'react';

import { Button, Eyebrow, Panel } from '../../../components/ui';
import { validateMockTool, type MockToolDraft } from './checks';

/**
 * The "add mock tool" form: `ToolSchemaBuilder` from docs/01-architecture.md.
 *
 * Four fields, because a tool is four pieces of data (lesson 2). The parameters and the
 * response are raw JSON in a textarea rather than a row-by-row schema designer, and that
 * is deliberate: the thing being taught is *JSON Schema*, and a form that generates it
 * behind a friendly facade teaches the facade. The validation is where the help goes —
 * it names the missing brace, insists on `"type": "object"`, and refuses a description
 * under twenty characters, which is lesson 2's rule made mechanical.
 */

const EMPTY: MockToolDraft = {
  name: '',
  description: '',
  parametersText: '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}',
  responseText: '{}',
};

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {error && (
          <span className="readout text-xs text-rose-600" role="alert">
            {error}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="text-muted mt-1 text-xs leading-5">{hint}</p>}
    </div>
  );
}

export interface MockToolBuilderProps {
  tools: MockToolDefinition[];
  onChange: (tools: MockToolDefinition[]) => void;
  /** Pre-fills the form from the exercise config's `mockToolTemplate`. */
  template?: MockToolDraft;
  disabled?: boolean;
}

export function MockToolBuilder({ tools, onChange, template, disabled }: MockToolBuilderProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MockToolDraft>(template ?? EMPTY);
  const [touched, setTouched] = useState(false);

  const validation = validateMockTool(draft);
  const errors = touched ? validation.errors : {};
  const canAdd =
    Object.keys(validation.errors).length === 0 && !tools.some((tool) => tool.name === draft.name);

  const add = (): void => {
    setTouched(true);
    if (!canAdd || !validation.parameters) return;
    onChange([
      ...tools,
      {
        name: draft.name,
        description: draft.description,
        parameters: validation.parameters,
        response: validation.response,
      },
    ]);
    setOpen(false);
    setTouched(false);
  };

  return (
    <Panel className="p-4" data-testid="mock-tool-builder">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Mock tools</Eyebrow>
        <Button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={disabled}
          data-testid="toggle-mock-tool"
        >
          {open ? 'Close' : 'Add mock tool'}
        </Button>
      </div>

      {tools.length === 0 ? (
        <p className="text-muted mt-2 text-xs leading-5">
          None yet. A mock tool is a name, a description, a JSON Schema and a canned answer — the
          server returns the answer without running anything.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {tools.map((tool) => (
            <li
              key={tool.name}
              className="border-rule flex items-start justify-between gap-2 rounded-md border px-2 py-1.5"
              data-testid={`mock-tool-${tool.name}`}
            >
              <div className="min-w-0">
                <p className="readout text-xs font-medium">{tool.name}</p>
                <p className="text-muted truncate text-xs">{tool.description}</p>
              </div>
              <Button
                variant="ghost"
                onClick={() => onChange(tools.filter((entry) => entry.name !== tool.name))}
                aria-label={`Remove ${tool.name}`}
                disabled={disabled}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="border-rule mt-3 space-y-3 border-t pt-3">
          <Field label="Name" error={errors.name}>
            <input
              aria-label="Mock tool name"
              className="border-rule bg-surface readout mt-1 w-full rounded-md border px-2 py-1 text-xs"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <Field
            label="Description"
            error={errors.description}
            hint="This is prompt text, not documentation. Say what it does, when to call it, and show one example argument."
          >
            <textarea
              aria-label="Mock tool description"
              className="border-rule bg-surface mt-1 min-h-16 w-full rounded-md border p-2 font-mono text-xs leading-5"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>

          <Field label="Parameters (JSON Schema)" error={errors.parameters}>
            <textarea
              aria-label="Mock tool parameters"
              spellCheck={false}
              rows={8}
              className="border-rule bg-surface mt-1 w-full rounded-md border p-2 font-mono text-xs leading-5"
              value={draft.parametersText}
              onChange={(event) => setDraft({ ...draft, parametersText: event.target.value })}
            />
          </Field>

          <Field
            label="Canned response (JSON)"
            error={errors.response}
            hint="Returned verbatim whenever the agent calls this tool. Nothing you write here is ever executed."
          >
            <textarea
              aria-label="Mock tool response"
              spellCheck={false}
              rows={4}
              className="border-rule bg-surface mt-1 w-full rounded-md border p-2 font-mono text-xs leading-5"
              value={draft.responseText}
              onChange={(event) => setDraft({ ...draft, responseText: event.target.value })}
            />
          </Field>

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={add} data-testid="add-mock-tool">
              Add tool
            </Button>
            {touched && Object.keys(validation.errors).length > 0 && (
              <span className="readout text-xs text-rose-600" data-testid="mock-tool-invalid">
                fix the fields above
              </span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
