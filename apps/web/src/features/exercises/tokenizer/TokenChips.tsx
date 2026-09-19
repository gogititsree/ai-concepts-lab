import { renderToken, UNKNOWN_TOKEN, utf8Length } from '@lab/nn-core';

/**
 * The tokenized text, one chip per token, colour-cycled by token id.
 *
 * Colour carries one piece of information and it is not "importance": two chips of the
 * same colour are the *same token*. That is the thing worth seeing — `the_` recurring in
 * one hue across a paragraph while a rare word fragments into six different ones.
 *
 * The palette is generated from the token id rather than drawn from `lib/colorScale.ts`,
 * which is the app's only deliberate exception to "two scales and nothing else is
 * colourful". Both scales there are *ordered* — they encode magnitude — and a token id is
 * a label with no magnitude at all. A ramp would imply that token 240 is somehow more
 * than token 12. So: a fixed-hue cycle, low saturation, dark text over it at every step.
 */

/** Twelve hues around the wheel, offset so consecutive ids are far apart. */
const HUES = 12;
const HUE_STEP = 360 / HUES;

function chipStyle(id: number): { backgroundColor: string; borderColor: string } {
  // `* 5` so ids 1, 2, 3 land on hues 150°, 300°, 90° instead of adjacent pastels.
  const hue = ((id * 5) % HUES) * HUE_STEP;
  return {
    backgroundColor: `oklch(0.92 0.06 ${hue})`,
    borderColor: `oklch(0.78 0.09 ${hue})`,
  };
}

export interface TokenChipsProps {
  tokens: readonly string[];
  ids: readonly number[];
}

export function TokenChips({ tokens, ids }: TokenChipsProps) {
  if (tokens.length === 0) {
    return (
      <p className="text-muted text-sm leading-6" data-testid="token-chips-empty">
        Type something above and it will be tokenized as you go.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-1" data-testid="token-chips">
      {tokens.map((token, index) => {
        const id = ids[index] ?? 0;
        const unknown = token === UNKNOWN_TOKEN;
        const bytes = utf8Length(token);
        return (
          <span
            key={`${index}-${token}`}
            data-testid="token-chip"
            data-token-id={id}
            // Both `title` and `aria-label`: the hover affordance and the screen-reader
            // one are different APIs and a chip needs both.
            title={`id ${id} · ${bytes} byte${bytes === 1 ? '' : 's'}`}
            aria-label={`token ${index + 1}: ${renderToken(token)}, id ${id}, ${bytes} bytes`}
            className={`readout inline-flex items-center rounded border px-1.5 py-0.5 text-xs whitespace-pre ${
              unknown ? 'border-dashed font-semibold' : ''
            }`}
            style={unknown ? undefined : chipStyle(id)}
          >
            {renderToken(token)}
          </span>
        );
      })}
    </div>
  );
}
