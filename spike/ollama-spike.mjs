// spike/ollama-spike.mjs
//
// M0 spike: prove that the locally installed Ollama model does native tool
// calling and JSON-schema structured output, and record raw responses as
// test fixtures for later provider unit tests (see apps/api/src/model/ollama.ts, M9).
//
// Plain Node ESM script, no dependencies, uses global fetch (Node 24).
//
// NOTE ON MODEL SUBSTITUTION: the design docs (01-architecture.md, HANDOFF.md)
// name `gemma4:e4b`. The model actually installed on this machine is
// `gemma4:latest` (8B, capabilities: completion, vision, audio, tools, thinking).
// We do NOT pull e4b. Every call below uses `gemma4:latest`. See docs/spike-notes.md.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../apps/api/test/fixtures/ollama');

const BASE_URL = 'http://localhost:11434';
const CHAT_MODEL = 'gemma4:latest';
const EMBED_MODEL = 'nomic-embed-text';

async function ensureDir() {
  await mkdir(FIXTURES_DIR, { recursive: true });
}

async function saveFixture(name, data) {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${path.relative(process.cwd(), file)}`);
}

async function timedFetch(url, init) {
  const start = performance.now();
  const res = await fetch(url, init);
  const body = await res.json();
  const latencyMs = performance.now() - start;
  return { body, latencyMs, status: res.status };
}

async function chat(messages, extra = {}) {
  return timedFetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: false,
      messages,
      ...extra,
    }),
  });
}

const calculatorTool = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression and return the numeric result.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The arithmetic expression to evaluate, e.g. "12345 * 6789"',
        },
      },
      required: ['expression'],
    },
  },
};

const results = {}; // name -> { latencyMs }

async function taskChatPlain() {
  console.log('\n[a] chat-plain');
  const { body, latencyMs, status } = await chat([
    { role: 'user', content: 'Reply with the single word: pong' },
  ]);
  console.log(`  status=${status} latencyMs=${latencyMs.toFixed(0)}`);
  console.log(`  message.content=${JSON.stringify(body.message?.content)}`);
  await saveFixture('chat-plain', body);
  results['chat-plain'] = { latencyMs, status };
  return body;
}

async function taskToolCall() {
  console.log('\n[b] tool-call');
  const { body, latencyMs, status } = await chat(
    [
      {
        role: 'user',
        content: 'What is 12345 multiplied by 6789? Use the calculator tool.',
      },
    ],
    { tools: [calculatorTool] }
  );
  console.log(`  status=${status} latencyMs=${latencyMs.toFixed(0)}`);
  console.log(`  message.tool_calls=${JSON.stringify(body.message?.tool_calls)}`);
  await saveFixture('tool-call', body);
  results['tool-call'] = { latencyMs, status };
  return body;
}

async function taskToolResultFinal(toolCallResponse) {
  console.log('\n[c] tool-result-final');
  const assistantMessage = toolCallResponse.message;
  const messages = [
    { role: 'user', content: 'What is 12345 multiplied by 6789? Use the calculator tool.' },
    assistantMessage,
    {
      role: 'tool',
      content: '{"result": 83810205}',
      tool_name: 'calculator',
    },
  ];
  const { body, latencyMs, status } = await chat(messages, { tools: [calculatorTool] });
  console.log(`  status=${status} latencyMs=${latencyMs.toFixed(0)}`);
  console.log(`  message.content=${JSON.stringify(body.message?.content)}`);
  await saveFixture('tool-result-final', body);
  results['tool-result-final'] = { latencyMs, status };
  return body;
}

async function taskStructuredOutput() {
  console.log('\n[d] structured-output');
  const schema = {
    type: 'object',
    properties: {
      dates: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['dates'],
  };
  const paragraph =
    'The company was founded on March 3, 1998. It went public on July 14, 2005, ' +
    'and later relocated its headquarters on November 1, 2019. Extract every date mentioned.';
  const { body, latencyMs, status } = await chat(
    [{ role: 'user', content: paragraph }],
    { format: schema }
  );
  console.log(`  status=${status} latencyMs=${latencyMs.toFixed(0)}`);
  console.log(`  message.content=${JSON.stringify(body.message?.content)}`);
  let parsed = null;
  let validJson = false;
  let matchesSchema = false;
  try {
    parsed = JSON.parse(body.message?.content ?? '');
    validJson = true;
    matchesSchema =
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.dates) &&
      parsed.dates.every((d) => typeof d === 'string');
  } catch (err) {
    console.log(`  JSON.parse failed: ${err.message}`);
  }
  console.log(`  validJson=${validJson} matchesSchema=${matchesSchema}`);
  await saveFixture('structured-output', body);
  results['structured-output'] = { latencyMs, status, validJson, matchesSchema };
  return body;
}

async function taskEmbed() {
  console.log('\n[e] embed');
  const start = performance.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: ['king', 'queen', 'apple'],
      }),
    });
  } catch (err) {
    console.log(`  FAILED to call /api/embed: ${err.message}`);
    results['embed'] = { error: err.message };
    return null;
  }
  const latencyMs = performance.now() - start;
  const body = await res.json();
  console.log(`  status=${res.status} latencyMs=${latencyMs.toFixed(0)}`);
  if (!res.ok) {
    console.log(`  embed call returned non-OK status: ${JSON.stringify(body)}`);
    results['embed'] = { latencyMs, status: res.status, error: body };
    await saveFixture('embed', body);
    return body;
  }
  // Truncate each embedding array to first 8 numbers + _truncated flag.
  const truncated = {
    ...body,
    embeddings: Array.isArray(body.embeddings)
      ? body.embeddings.map((vec) => vec.slice(0, 8))
      : body.embeddings,
    _truncated: true,
  };
  await saveFixture('embed', truncated);
  results['embed'] = { latencyMs, status: res.status };
  return body;
}

async function taskTags() {
  console.log('\n[f] tags');
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/api/tags`);
  const latencyMs = performance.now() - start;
  const body = await res.json();
  console.log(`  status=${res.status} latencyMs=${latencyMs.toFixed(0)}`);
  await saveFixture('tags', body);
  results['tags'] = { latencyMs, status: res.status };
  return body;
}

async function taskToolCallReliability() {
  console.log('\n[reliability] running tool-call 5x');
  const runs = [];
  for (let i = 1; i <= 5; i++) {
    const { body, latencyMs, status } = await chat(
      [
        {
          role: 'user',
          content: 'What is 12345 multiplied by 6789? Use the calculator tool.',
        },
      ],
      { tools: [calculatorTool] }
    );
    const toolCalls = body.message?.tool_calls;
    const hasProperToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    const contentLooksLikeToolCall =
      !hasProperToolCalls &&
      typeof body.message?.content === 'string' &&
      /calculator|"name"|"arguments"/i.test(body.message.content);
    const outcome = hasProperToolCalls
      ? 'proper_tool_calls'
      : contentLooksLikeToolCall
      ? 'tool_call_as_text'
      : 'nothing';
    console.log(
      `  run ${i}: status=${status} latencyMs=${latencyMs.toFixed(0)} outcome=${outcome}`
    );
    runs.push({ run: i, status, latencyMs, outcome, toolCalls: toolCalls ?? null, content: body.message?.content ?? null });
  }
  const properCount = runs.filter((r) => r.outcome === 'proper_tool_calls').length;
  console.log(`  reliability: ${properCount}/5 runs returned a proper tool_calls array`);
  results['reliability'] = { runs, properCount };
  return runs;
}

async function main() {
  await ensureDir();
  console.log(`Ollama spike starting against ${BASE_URL}, model=${CHAT_MODEL}`);

  await taskChatPlain();
  const toolCallBody = await taskToolCall();
  await taskToolResultFinal(toolCallBody);
  await taskStructuredOutput();
  await taskEmbed();
  await taskTags();
  await taskToolCallReliability();

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));

  // Also persist the summary for reference while writing spike-notes.md
  await writeFile(
    path.join(FIXTURES_DIR, '_run-summary.json'),
    JSON.stringify(results, null, 2) + '\n',
    'utf8'
  );
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Spike failed:', err);
  process.exitCode = 1;
});
