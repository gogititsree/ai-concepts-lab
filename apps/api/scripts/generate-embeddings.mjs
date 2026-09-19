#!/usr/bin/env node
/**
 * `pnpm content:embeddings` — regenerate the shipped embedding vectors for Module 3.
 *
 * The embeddings tab prefers live vectors from `POST /api/v1/model/embed`, but the
 * deployed instance runs `MODEL_PROVIDER=none` and most learners will not have Ollama
 * running either. So the vectors are also generated once, here, and committed:
 * `content/modules/03-how-llms-work/embeddings-precomputed.json` ships with the app and
 * the tab works offline, labelled honestly as "precomputed".
 *
 * This is a build-time script, not application code, which is why it is allowed to talk
 * to Ollama directly (CLAUDE.md's "nothing outside apps/api/src/model may reference
 * Ollama" is about the running server). It reads the word list out of the module's
 * `exercises.json` so the file and the content can never disagree about which words are
 * plotted, and it validates what it wrote with the same Zod schema the browser uses.
 *
 *   pnpm content:embeddings
 *   pnpm content:embeddings --model mxbai-embed-large
 *
 * Run it whenever the word list changes. It is deliberately *not* wired into CI: CI has
 * no Ollama, and a committed artefact that regenerates itself is a diff nobody reviews.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExercisesFileSchema, PrecomputedEmbeddingsSchema } from '@lab/shared';

const here = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(here, '../../../content/modules/03-how-llms-work');
const EXERCISE_SLUG = 'tokens-embeddings-attention';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const baseUrl = arg('base-url', process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(
  /\/$/,
  '',
);
const model = arg('model', process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text');

/** The word list, straight out of the content file the exercise is seeded from. */
async function readWordList() {
  const file = join(MODULE_DIR, 'exercises.json');
  const parsed = ExercisesFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const exercise = parsed.find((entry) => entry.slug === EXERCISE_SLUG);
  if (!exercise) throw new Error(`${file}: no exercise with slug "${EXERCISE_SLUG}"`);
  const words = exercise.config?.embeddings?.words;
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error(`${file}: config.embeddings.words is missing or empty`);
  }
  return words.map((entry) => entry.word);
}

/**
 * One request for the whole list. Ollama's `/api/embed` takes `input` as a string or an
 * array and returns `embeddings` in the same order, so batching keeps the vectors
 * consistent (the same model load, the same numerics) and the script down to one call.
 */
async function embed(words) {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: words }),
  });
  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== words.length) {
    throw new Error(
      `Expected ${words.length} embeddings, got ${body.embeddings?.length ?? 'none'}`,
    );
  }
  return body.embeddings;
}

/**
 * Six significant decimals. The vectors are L2-normalised downstream and every consumer
 * is a cosine, so the eighth decimal changes nothing a learner can see — and it is 40 %
 * of the file size, in a file that ships in the browser bundle.
 */
const round = (value) => Number(value.toFixed(6));

async function main() {
  const words = await readWordList();
  process.stdout.write(`Embedding ${words.length} words with ${model} at ${baseUrl}…\n`);

  const started = Date.now();
  const vectors = await embed(words);
  const dimensions = vectors[0].length;

  const file = {
    model,
    dimensions,
    generatedAt: new Date().toISOString(),
    vectors: Object.fromEntries(words.map((word, i) => [word, vectors[i].map(round)])),
  };

  // Validate before writing, not after: a bad file should never reach the disk where the
  // next `pnpm build` would happily bundle it.
  PrecomputedEmbeddingsSchema.parse(file);

  // One line per word rather than `JSON.stringify(_, null, 2)`: a 768-component array
  // pretty-printed is 768 lines, and 42 of those is a 30 000-line file no diff survives.
  const body = Object.entries(file.vectors)
    .map(([word, vector]) => `    ${JSON.stringify(word)}: ${JSON.stringify(vector)}`)
    .join(',\n');
  const json = [
    '{',
    `  "model": ${JSON.stringify(file.model)},`,
    `  "dimensions": ${file.dimensions},`,
    `  "generatedAt": ${JSON.stringify(file.generatedAt)},`,
    '  "vectors": {',
    body,
    '  }',
    '}',
    '',
  ].join('\n');

  const out = join(MODULE_DIR, 'embeddings-precomputed.json');
  await writeFile(out, json, 'utf8');
  process.stdout.write(
    `Wrote ${out}\n  ${words.length} words x ${dimensions} dims, ` +
      `${(Buffer.byteLength(json) / 1024).toFixed(1)} KB, ${Date.now() - started} ms\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`\ngenerate-embeddings failed: ${error.message}\n`);
  process.stderr.write(
    `Is Ollama running at ${baseUrl} with "${model}" pulled? ` + `(ollama pull ${model})\n`,
  );
  process.exit(1);
});
