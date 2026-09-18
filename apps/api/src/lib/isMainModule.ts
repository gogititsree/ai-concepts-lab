import { pathToFileURL } from 'node:url';

/**
 * True when this module is the file Node (or tsx) was asked to run, rather than one that
 * something else imported. The ESM equivalent of `require.main === module`.
 *
 * Used by the db CLIs so that `tsx src/db/seed.ts` runs the seed while
 * `import { seed } from './seed.js'` in a test does not.
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // Compare as URLs so Windows drive letters and backslashes normalise the same way.
  return pathToFileURL(entry).href === new URL(metaUrl).href;
}
