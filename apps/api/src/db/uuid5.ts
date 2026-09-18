import { createHash } from 'node:crypto';

/**
 * Namespace for every deterministically generated content id in this project. It is an
 * arbitrary but *frozen* uuid: changing it changes every content id in every database,
 * which would orphan progress rows. Treat it as a constant of the universe.
 */
export const CONTENT_NAMESPACE = '582d78c7-e4c3-40b3-9548-db3c21a84a5d';

/**
 * RFC 4122 §4.3 name-based uuid (version 5, SHA-1).
 *
 * Written out rather than pulling in the `uuid` package: it is twelve lines, it is
 * specified precisely, and the seed is the only caller. The point of using v5 at all is
 * that `content/modules/01-neurons/module.json` produces the same primary key on every
 * machine and on every run, which is what makes the seed idempotent and lets progress
 * rows survive a re-seed.
 */
export function uuidV5(name: string, namespace: string = CONTENT_NAMESPACE): string {
  const nsBytes = parseUuid(namespace);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBytes, nameBytes]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  // Version 5 in the high nibble of byte 6, RFC 4122 variant in the top bits of byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

/** Id helpers, so the "what is this id derived from" rule lives in exactly one place. */
export const contentId = {
  module: (moduleSlug: string) => uuidV5(`module:${moduleSlug}`),
  lesson: (moduleSlug: string, lessonSlug: string) => uuidV5(`lesson:${moduleSlug}/${lessonSlug}`),
  exercise: (moduleSlug: string, exerciseSlug: string) =>
    uuidV5(`exercise:${moduleSlug}/${exerciseSlug}`),
  quiz: (moduleSlug: string) => uuidV5(`quiz:${moduleSlug}`),
  /** Questions have no authored slug, so their position in quiz.json is their identity. */
  quizQuestion: (moduleSlug: string, orderIndex: number) =>
    uuidV5(`quiz_question:${moduleSlug}#${orderIndex}`),
};
