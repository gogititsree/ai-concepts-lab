import corpusTxt from '../../../../../../content/modules/03-how-llms-work/corpus.txt?raw';

/**
 * The BPE training corpus, bundled into the app.
 *
 * M7 deleted the `import.meta.glob('content/**')` that used to pull the whole curriculum
 * into the bundle, and this is a deliberate, narrow re-entry rather than a regression.
 * The difference is what the two were for: lessons and quiz answers are *data* and belong
 * behind the API, where they can change without a redeploy and where the answers can be
 * withheld. This 5 KB paragraph is a *fixture* the tokenizer trains on in the browser —
 * it has to be in the browser, it is referenced by name from the exercise config
 * (`tokenizer.corpusFile`), and shipping it through the API would mean a second round
 * trip before the first token chip could render.
 *
 * The same argument covers `embeddings-precomputed.json` next door in
 * `../embeddings/precomputed.ts`.
 *
 * Adding a corpus means adding it here as well as in the content file; the lookup throws
 * with both names if they ever disagree, which is the failure mode this map exists to
 * make loud.
 */
const CORPORA: Record<string, string> = {
  'corpus.txt': corpusTxt,
};

export function bundledCorpus(fileName: string): string {
  const corpus = CORPORA[fileName];
  if (corpus === undefined) {
    throw new Error(
      `No bundled corpus "${fileName}". Known: ${Object.keys(CORPORA).join(', ')}. ` +
        'Add the import in features/exercises/tokenizer/bundledCorpus.ts.',
    );
  }
  return corpus;
}

/** `corpusText` in the config wins; otherwise resolve `corpusFile` from the bundle. */
export function resolveCorpus(config: { corpusText?: string; corpusFile?: string }): string {
  if (config.corpusText !== undefined) return config.corpusText;
  return bundledCorpus(config.corpusFile ?? '');
}
