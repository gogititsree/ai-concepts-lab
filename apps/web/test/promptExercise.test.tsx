import type { PromptConfig, StructuredOutputResult } from '@lab/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptExercise } from '../src/features/exercises/prompt/PromptExercise';
import { evaluatePromptTasks } from '../src/features/exercises/prompt/checks';
import { exerciseDetail, fixtureModule } from './fixtures/content';
import { renderWithProviders } from './harness';

/**
 * The Module 4 playground, against the **real** `exercises.json` config and a mocked API.
 *
 * No test here calls a model, or even the real `/model/chat`: the fetch stub answers with
 * shapes the API's own Zod schema produces, which is what keeps these tests about the
 * component. The interesting cases are the three the exercise exists to handle — the
 * model being absent, a long call being cancelled, and a task passing on the server's
 * structured-output verdict rather than on anything the browser computed.
 */

const exercise = exerciseDetail('prompting');
const config = fixtureModule('prompting').exercises[0]?.config as unknown as PromptConfig;

const HEALTH_UP = {
  provider: 'ollama',
  ok: true,
  models: ['gemma4:latest'],
  model: 'gemma4:latest',
};
const HEALTH_DOWN = {
  provider: 'none',
  ok: false,
  models: [],
  model: 'gemma4:latest',
  detail: 'MODEL_PROVIDER=none: this deployment has no model attached.',
};

const chatResponse = (overrides: Record<string, unknown> = {}) => ({
  message: { role: 'assistant', content: 'hello' },
  usage: { promptTokens: 12, completionTokens: 34 },
  latencyMs: 8200,
  runId: '11111111-2222-4333-8444-555555555555',
  provider: 'ollama',
  model: 'gemma4:latest',
  ...overrides,
});

interface StubOptions {
  health?: unknown;
  chat?: unknown;
  /** Never resolves until aborted — the slow-call case. */
  hangChat?: boolean;
}

function installStub(options: StubOptions = {}) {
  const chatCalls: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/v1/model/health') return json(options.health ?? HEALTH_UP);
    if (url.pathname === '/api/v1/model/chat') {
      chatCalls.push(JSON.parse(String(init?.body)));
      if (options.hangChat) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return json(options.chat ?? chatResponse());
    }
    if (url.pathname.startsWith('/api/v1/progress/exercises/')) return json({});
    return json({ error: { code: 'NOT_FOUND', message: url.pathname } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, chatCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rendering', () => {
  it('mounts with both prompt boxes, the sampling controls and all four tasks', async () => {
    installStub();
    renderWithProviders(<PromptExercise exercise={exercise} />);

    expect(screen.getByLabelText('System prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('User prompt')).toBeInTheDocument();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByText('Top-p')).toBeInTheDocument();
    expect(screen.getByLabelText('Seed')).toBeInTheDocument();
    for (const id of ['three-bullets', 'extract-dates', 'refuse-offtopic', 'injection-resist']) {
      expect(screen.getByTestId(`task-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/3 to complete');

    // The banner must not appear when the model is up.
    await waitFor(() => expect(screen.queryByTestId('model-unavailable-banner')).toBeNull());
  });

  it('shows the run-it-locally banner when /model/health reports unavailable', async () => {
    installStub({ health: HEALTH_DOWN });
    renderWithProviders(<PromptExercise exercise={exercise} />);

    const banner = await screen.findByTestId('model-unavailable-banner');
    expect(banner).toHaveTextContent(/run it locally|run-it-locally|locally/i);
    expect(banner).toHaveTextContent('MODEL_PROVIDER=none');
  });
});

describe('running a prompt', () => {
  it('posts the prompts, sampling options and exercise id, then shows the numbers', async () => {
    const { chatCalls } = installStub();
    renderWithProviders(<PromptExercise exercise={exercise} />);

    fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'ping' } });
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await screen.findByTestId('run-link');
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]).toMatchObject({
      exerciseId: exercise.id,
      messages: [
        { role: 'system', content: config.defaults.systemPrompt },
        { role: 'user', content: 'ping' },
      ],
      options: { temperature: config.defaults.temperature, topP: config.defaults.topP, seed: 7 },
    });

    expect(screen.getByTestId('output-panel')).toHaveTextContent('hello');
    expect(screen.getByText('Prompt tokens').nextElementSibling).toHaveTextContent('12');
    expect(screen.getByText('Completion').nextElementSibling).toHaveTextContent('34');
    expect(screen.getByText('Latency').nextElementSibling).toHaveTextContent('8.2 s');
    expect(screen.getByTestId('run-link')).toHaveAttribute(
      'href',
      '/api/v1/model/runs/11111111-2222-4333-8444-555555555555',
    );
  });

  it('renders the error message when the call fails', async () => {
    installStub({ chat: undefined });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/v1/model/health')
          return new Response(JSON.stringify(HEALTH_UP), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return new Response(
          JSON.stringify({
            error: { code: 'MODEL_TIMEOUT', message: 'The model did not respond' },
          }),
          { status: 504, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    renderWithProviders(<PromptExercise exercise={exercise} />);
    fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByTestId('run-error')).toHaveTextContent('The model did not respond');
  });

  it('shows an elapsed counter while pending and aborts on cancel', async () => {
    const { fetchMock } = installStub({ hangChat: true });
    renderWithProviders(<PromptExercise exercise={exercise} />);

    fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'slow one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByTestId('elapsed')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();

    fireEvent.click(cancel);

    // The signal handed to fetch is genuinely aborted -- that is what stops the
    // inference server-side, not just the page.
    const chatCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/model/chat'),
    ) as [RequestInfo, RequestInit] | undefined;
    expect(chatCall?.[1]?.signal?.aborted).toBe(true);

    await waitFor(() => expect(screen.getByText('cancelled')).toBeInTheDocument());
    // A cancel is not an error.
    expect(screen.queryByTestId('run-error')).toBeNull();
  });
});

describe('the task checks', () => {
  it('passes three-bullets on exactly three hyphen lines and reports it to the API', async () => {
    const { fetchMock } = installStub({
      chat: chatResponse({
        message: { role: 'assistant', content: '- one\n- two\n- three' },
      }),
    });
    renderWithProviders(<PromptExercise exercise={exercise} />);

    // The task's own prompt: a task is only credited to a run that attempted it.
    fireEvent.change(screen.getByLabelText('User prompt'), {
      target: { value: config.tasks.find((task) => task.id === 'three-bullets')!.userPrompt },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('task-list')).toHaveTextContent('1/3'));

    const save = fetchMock.mock.calls.find(([input, init]) => {
      void input;
      return (init as RequestInit | undefined)?.method === 'PUT';
    });
    expect(JSON.parse(String((save?.[1] as RequestInit).body))).toMatchObject({
      tasksCompleted: ['three-bullets'],
    });
  });

  it('passes extract-dates from the server structured verdict, not from the text', async () => {
    installStub({
      chat: chatResponse({
        message: {
          role: 'assistant',
          content: '{"dates":["1998-03-03","2005-07-14","2019-11-01"]}',
        },
        structuredOutput: {
          valid: true,
          value: { dates: ['1998-03-03', '2005-07-14', '2019-11-01'] },
          retried: false,
        },
      }),
    });
    renderWithProviders(<PromptExercise exercise={exercise} />);

    fireEvent.click(screen.getByRole('button', { name: 'extract-dates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('task-list')).toHaveTextContent('1/3'));
    expect(screen.getByTestId('structured-panel')).toHaveTextContent('valid');
    expect(screen.getByTestId('structured-panel')).toHaveTextContent('first attempt');
  });

  it('shows the validation error verbatim and whether a retry happened', async () => {
    installStub({
      chat: chatResponse({
        message: { role: 'assistant', content: 'March 3, 1998' },
        structuredOutput: {
          valid: false,
          error:
            'The response is not valid JSON (Unexpected token M). First 200 characters: March 3, 1998',
          retried: true,
        },
      }),
    });
    renderWithProviders(<PromptExercise exercise={exercise} />);

    fireEvent.click(screen.getByRole('button', { name: 'extract-dates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    const panel = await screen.findByTestId('structured-error');
    expect(panel).toHaveTextContent('The response is not valid JSON (Unexpected token M)');
    expect(screen.getByTestId('structured-panel')).toHaveTextContent('after one retry');
    // Still 0 of 3: an invalid structured answer does not complete the task.
    expect(screen.getByTestId('task-list')).toHaveTextContent('0/3');
  });

  it('refuses to run with an unparseable schema', () => {
    installStub();
    renderWithProviders(<PromptExercise exercise={exercise} />);

    fireEvent.click(screen.getByRole('button', { name: 'Structured output' }));
    fireEvent.change(screen.getByLabelText('JSON schema'), { target: { value: '{ nope' } });
    expect(screen.getByTestId('schema-error')).toHaveTextContent('Not a JSON object');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});

describe('the check rules themselves', () => {
  const tasks = config.tasks;

  const promptFor = (id: string) => tasks.find((task) => task.id === id)?.userPrompt ?? '';

  /**
   * A task is only credited on a run that used its own prompt, so every check below is
   * asked against the prompt that task ships. `as` names the task being attempted.
   */
  const runFor = (as: string, content: string, structured?: StructuredOutputResult) =>
    evaluatePromptTasks(tasks, {
      content,
      userPrompt: promptFor(as),
      ...(structured ? { structured } : {}),
    });

  it('is exactly the four tasks docs/04-curriculum.md specifies', () => {
    expect(tasks.map((task) => task.id)).toEqual([
      'three-bullets',
      'extract-dates',
      'refuse-offtopic',
      'injection-resist',
    ]);
  });

  it('three-bullets needs exactly three hyphen lines', () => {
    const pass = (content: string) => runFor('three-bullets', content);
    expect(pass('- a\n- b\n- c')).toContain('three-bullets');
    // Trailing whitespace is trimmed, so a newline at the end is not a failure.
    expect(pass('- a\n- b\n- c\n')).toContain('three-bullets');
    expect(pass('Certainly!\n- a\n- b\n- c')).not.toContain('three-bullets');
    expect(pass('- a\n- b')).not.toContain('three-bullets');
    expect(pass('- a\n- b\n- c\n- d')).not.toContain('three-bullets');
  });

  it('refuse-offtopic matches the refusal sentence, case-insensitively', () => {
    expect(runFor('refuse-offtopic', 'I can only help with AI concepts.')).toContain(
      'refuse-offtopic',
    );
    expect(runFor('refuse-offtopic', 'i CAN ONLY help with ai concepts')).toContain(
      'refuse-offtopic',
    );
    expect(runFor('refuse-offtopic', 'Here is a sourdough recipe')).not.toContain(
      'refuse-offtopic',
    );
  });

  it('injection-resist fails on PWNED in any case, and on an empty answer', () => {
    expect(runFor('injection-resist', 'Revenue rose 4% and headcount was flat.')).toContain(
      'injection-resist',
    );
    expect(runFor('injection-resist', 'pwned')).not.toContain('injection-resist');
    expect(runFor('injection-resist', 'Summary: PWNED')).not.toContain('injection-resist');
    // Saying nothing is not surviving the injection.
    expect(runFor('injection-resist', '   ')).not.toContain('injection-resist');
  });

  it('extract-dates needs the server verdict *and* three items', () => {
    const withStructured = (structured: {
      valid: boolean;
      value?: unknown;
      retried: boolean;
      error?: string;
    }) => runFor('extract-dates', '{}', structured as StructuredOutputResult);

    expect(
      withStructured({ valid: true, value: { dates: ['a', 'b', 'c'] }, retried: false }),
    ).toContain('extract-dates');
    expect(withStructured({ valid: true, value: { dates: ['a'] }, retried: false })).not.toContain(
      'extract-dates',
    );
    expect(withStructured({ valid: false, error: 'nope', retried: true })).not.toContain(
      'extract-dates',
    );
    // No structured run at all: the text alone can never pass this one.
    expect(runFor('injection-resist', '{"dates":["a","b","c"]}')).not.toContain('extract-dates');
  });
});

describe('a task is credited only to the run that attempted it', () => {
  const tasks = config.tasks;
  const promptFor = (id: string) => tasks.find((task) => task.id === id)?.userPrompt ?? '';

  it('does not tick injection-resist just because an unrelated answer lacks PWNED', () => {
    // The regression this guards: `not_contains` is satisfied by almost any text, so
    // answering the three-bullets question used to silently complete the injection task.
    const passing = evaluatePromptTasks(tasks, {
      content: '- one\n- two\n- three',
      userPrompt: promptFor('three-bullets'),
    });
    expect(passing).toContain('three-bullets');
    expect(passing).not.toContain('injection-resist');
  });

  it('ticks injection-resist when that task’s own prompt was the one run', () => {
    expect(
      evaluatePromptTasks(tasks, {
        content: 'Revenue rose 4% and headcount was flat.',
        userPrompt: promptFor('injection-resist'),
      }),
    ).toContain('injection-resist');
  });

  it('ignores incidental whitespace differences in the prompt', () => {
    expect(
      evaluatePromptTasks(tasks, {
        content: 'I can only help with AI concepts.',
        userPrompt: `  ${promptFor('refuse-offtopic').replace(/ /g, '  ')}\n`,
      }),
    ).toContain('refuse-offtopic');
  });

  it('does not tick the refusal task when a different question was asked', () => {
    expect(
      evaluatePromptTasks(tasks, {
        content: 'I can only help with AI concepts.',
        userPrompt: 'What is attention?',
      }),
    ).not.toContain('refuse-offtopic');
  });
});
