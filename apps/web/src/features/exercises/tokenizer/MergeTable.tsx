import { renderToken, type BpeModel } from '@lab/nn-core';

/**
 * The learned merge table, in the order it was learned — which is the order it must be
 * replayed in, so the row number is not decoration.
 *
 * `trainBpe` returns the merges but not their counts (it recounts every round and keeps
 * only the winner), so the frequency column is recovered here: after merge `i`, how many
 * times does the merged symbol occur in the corpus? That is not identical to the pair
 * count at the moment the merge was chosen — a later merge can absorb some of those
 * occurrences — but it is the number a learner actually wants, because it answers "was
 * this merge worth it?" against the finished vocabulary. The header says so.
 */

export interface MergeTableProps {
  model: BpeModel;
  /** Token counts in the encoded corpus, keyed by merged symbol. */
  frequencies: Record<string, number>;
  /** Rows to render before the scroll area takes over. */
  limit?: number;
}

export function MergeTable({ model, frequencies, limit = 500 }: MergeTableProps) {
  const rows = model.merges.slice(0, limit);

  return (
    <div data-testid="merge-table">
      <div className="border-rule max-h-72 overflow-y-auto rounded-md border">
        <table className="readout w-full border-collapse text-left text-xs">
          <caption className="sr-only">
            The {model.merges.length} merges learned from the corpus, in the order they were
            learned, with how often each merged symbol survives in the encoded corpus.
          </caption>
          <thead className="bg-sunk sticky top-0">
            <tr>
              <th scope="col" className="border-rule border-b px-2 py-1.5 font-semibold">
                #
              </th>
              <th scope="col" className="border-rule border-b px-2 py-1.5 font-semibold">
                pair
              </th>
              <th scope="col" className="border-rule border-b px-2 py-1.5 font-semibold">
                becomes
              </th>
              <th scope="col" className="border-rule border-b px-2 py-1.5 text-right font-semibold">
                in corpus
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([a, b], index) => {
              const merged = a + b;
              return (
                <tr key={`${index}-${merged}`} data-testid="merge-row">
                  <td className="border-rule text-muted border-b px-2 py-1">{index + 1}</td>
                  <td className="border-rule border-b px-2 py-1 whitespace-pre">
                    {renderToken(a)}
                    <span className="text-muted"> + </span>
                    {renderToken(b)}
                  </td>
                  <td className="border-rule border-b px-2 py-1 font-medium whitespace-pre">
                    {renderToken(merged)}
                  </td>
                  <td className="border-rule border-b px-2 py-1 text-right">
                    {frequencies[merged] ?? 0}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {model.merges.length > rows.length && (
        <p className="text-muted mt-1 text-xs">
          Showing the first {rows.length} of {model.merges.length}.
        </p>
      )}
    </div>
  );
}
