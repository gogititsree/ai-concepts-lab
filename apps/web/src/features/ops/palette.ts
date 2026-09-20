/**
 * The `/ops` colour slots, and the record of how they were chosen.
 *
 * The app's rule (see `src/index.css`) is **colour means data**: the chrome is graphite
 * and paper, and the only saturated colour on a page is a measurement. This dashboard is
 * all measurement, so it needs more slots than the two the rest of the app uses
 * (`--neg` / `--pos`, the diverging weight scale) — one per run outcome, plus a severity
 * ramp for the meters.
 *
 * ## The slots, and why these exact hexes
 *
 * Run outcomes are a **status palette**, not a categorical one: `completed`, `failed`,
 * `max_iterations` and `cancelled` are states, not interchangeable series, and the four
 * of them always appear together in the same stacked bar. They were validated with the
 * data-viz skill's checker against **this app's own surfaces** (`#ffffff` light,
 * `#111a2b` dark), not against the checker's defaults, because a contrast number is only
 * meaningful against the surface the mark is actually drawn on:
 *
 * ```
 * light  #059669,#d97706,#e11d48,#64748b  on #ffffff
 *   PASS lightness band · PASS normal-vision ΔE 16.6 · PASS contrast ≥ 3:1
 *   WARN adjacent CVD ΔE 7.9 (amber↔emerald, protan)
 *   FAIL chroma floor on #64748b
 * dark   #12a978,#c8830b,#ef4f66,#7e8ba1  on #111a2b
 *   PASS lightness band · PASS normal-vision ΔE 16.4 · PASS contrast ≥ 3:1
 *   WARN adjacent CVD ΔE 6.7 (rose↔amber, deutan)
 *   FAIL chroma floor on #7e8ba1
 * ```
 *
 * Both residuals are deliberate and both are relieved:
 *
 *  - **The chroma "failure" is the de-emphasis slot.** `cancelled` is not a competing
 *    identity, it is the outcome that means "nobody was watching"; reading as grey is
 *    the intent, and the checker flags it only because it is scoring every slot as a
 *    categorical series.
 *  - **The CVD warning is in the 6–8 band, which the method permits only with secondary
 *    encoding.** The stacked bar ships all three: a 2 px surface gap between segments, a
 *    legend where every segment is named *and* carries its own count, and the same four
 *    numbers again in the status table below it. Nothing on this page is knowable by hue
 *    alone. Making the pair pass outright would mean either a lighter amber (which then
 *    fails contrast against the light surface) or an amber that no longer reads as
 *    "warning", and a warning colour that is not amber costs more comprehension than the
 *    ΔE buys.
 *
 * Magnitude charts (the iteration distribution) use **one hue, the app's existing
 * `--neg` blue**, because their job is magnitude rather than identity — a sequential
 * encoding, per the method, and reusing a token the app already flips for dark mode.
 *
 * The values are emitted as CSS custom properties by `<OpsTheme />` rather than as
 * Tailwind classes, because the dark steps are *selected* for the dark surface (see the
 * table above) rather than being the light ones dimmed, and that is a thing only a
 * media-query-scoped token can express.
 */

export interface OpsPalette {
  /** Run outcome fills, in the order the stacked bar draws them. */
  completed: string;
  maxIterations: string;
  failed: string;
  cancelled: string;
}

export const OPS_PALETTE_LIGHT: OpsPalette = {
  completed: '#059669',
  maxIterations: '#d97706',
  failed: '#e11d48',
  cancelled: '#64748b',
};

export const OPS_PALETTE_DARK: OpsPalette = {
  completed: '#12a978',
  maxIterations: '#c8830b',
  failed: '#ef4f66',
  cancelled: '#7e8ba1',
};

/** Severity of a meter fill. `ok` borrows the app's sequential blue. */
export type Severity = 'ok' | 'warning' | 'critical';

export const severityVar = (severity: Severity): string =>
  severity === 'critical'
    ? 'var(--ops-failed)'
    : severity === 'warning'
      ? 'var(--ops-max-iterations)'
      : 'var(--ops-accent)';

/** The CSS a page needs for the tokens above, in both schemes. */
export const OPS_THEME_CSS = `
[data-ops-theme] {
  --ops-completed: ${OPS_PALETTE_LIGHT.completed};
  --ops-max-iterations: ${OPS_PALETTE_LIGHT.maxIterations};
  --ops-failed: ${OPS_PALETTE_LIGHT.failed};
  --ops-cancelled: ${OPS_PALETTE_LIGHT.cancelled};
  /* Magnitude: one hue, the app's own. */
  --ops-accent: var(--neg);
  --ops-track: var(--surface-sunk);
}
@media (prefers-color-scheme: dark) {
  [data-ops-theme] {
    --ops-completed: ${OPS_PALETTE_DARK.completed};
    --ops-max-iterations: ${OPS_PALETTE_DARK.maxIterations};
    --ops-failed: ${OPS_PALETTE_DARK.failed};
    --ops-cancelled: ${OPS_PALETTE_DARK.cancelled};
  }
}
`;
