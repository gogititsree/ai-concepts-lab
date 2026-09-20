import type { SliIterationBucket, SliStatusCounts, SliToolStat } from '@lab/shared';
import type { ReactNode } from 'react';

import { Panel } from '../../components/ui';
import { OPS_THEME_CSS, severityVar, type Severity } from './palette';

/**
 * The marks the `/ops` page is drawn from. Hand-built SVG and CSS, no charting library:
 * the stack list in `docs/01-architecture.md` does not have one, three small charts do
 * not justify adding one, and everything here is fifty lines of geometry.
 *
 * Every component follows the same rules (the data-viz method, with this app's tokens
 * substituted for its reference palette):
 *
 *  - **Marks are thin and the data is the only loud thing.** Bars cap at 24 px, ends are
 *    rounded 4 px away from the baseline and square on it, gridlines are hairlines one
 *    step off the surface.
 *  - **A 2 px surface gap separates touching marks** rather than a stroke. A stroke is
 *    ink that is not data.
 *  - **Text never wears the data colour.** The swatch beside a label carries identity;
 *    the label itself stays in ink/muted, which is also the only way the light amber and
 *    emerald steps stay legible.
 *  - **Nothing is knowable by hue alone.** Every chart here has a legend or a table with
 *    the same numbers in it, and a `<title>` for hover.
 */

/** Scoped custom properties for the ops slots. See `palette.ts` for the validation. */
export function OpsTheme({ children }: { children: ReactNode }) {
  return (
    <div data-ops-theme="">
      <style>{OPS_THEME_CSS}</style>
      {children}
    </div>
  );
}

// -------------------------------------------------------------------- numbers ----

export const pct = (value: number | null, digits = 1): string =>
  value === null ? '—' : `${(value * 100).toFixed(digits)} %`;

/**
 * Milliseconds, rendered at the scale a human reads them at. A model call is tens of
 * seconds and a tool call is single-digit milliseconds, and showing "23548 ms" for the
 * first makes the reader do the division every time.
 */
export const ms = (value: number | null): string => {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
};

export const count = (value: number): string => value.toLocaleString();

// ----------------------------------------------------------------- stat tiles ----

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /**
   * One line: what the number means and what would make it go bad. This page is also
   * teaching material — Module 6 lesson 4 sends learners here — so the explanation is
   * part of the tile rather than a tooltip nobody opens.
   */
  hint: string;
  /** 0..1, drawn as a meter under the value. */
  meter?: { fraction: number; severity: Severity; caption: string } | undefined;
  /**
   * A caption with no meter, for a value that is not a ratio against a limit. Tokens per
   * run has no SLO, and drawing an empty meter track under it would invent a threshold
   * the number is being judged against.
   */
  footnote?: string | undefined;
  status?: { label: string; severity: Severity } | undefined;
  testId?: string;
}

/**
 * Label · value · optional meter · one-line explanation.
 *
 * A stat tile rather than a one-bar chart, because a single current value is a number
 * and drawing one bar for it is decoration.
 */
export function StatTile({ label, value, hint, meter, footnote, status, testId }: StatTileProps) {
  return (
    <Panel className="flex flex-col gap-2 p-4" data-testid={testId}>
      <p className="eyebrow">{label}</p>
      <p
        className="readout text-3xl leading-none font-semibold"
        style={{ fontVariantNumeric: 'normal' }}
      >
        {value}
      </p>
      {status && (
        <p className="flex items-center gap-1.5 text-xs font-medium">
          {/* Icon + label, never colour alone: a status hue must survive being grey. */}
          <span aria-hidden="true" style={{ color: severityVar(status.severity) }}>
            {status.severity === 'ok' ? '●' : status.severity === 'warning' ? '▲' : '■'}
          </span>
          <span>{status.label}</span>
        </p>
      )}
      {meter && <Meter {...meter} />}
      {footnote && <p className="text-muted readout text-[11px]">{footnote}</p>}
      <p className="text-muted mt-auto text-xs leading-5">{hint}</p>
    </Panel>
  );
}

/**
 * A single ratio against a limit. The track is the sunk surface and the fill carries
 * severity, so the state reads across the whole bar rather than only where it stops.
 */
export function Meter({
  fraction,
  severity,
  caption,
}: {
  fraction: number;
  severity: Severity;
  caption: string;
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: 'var(--ops-track)' }}
        role="img"
        aria-label={caption}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${clamped * 100}%`, backgroundColor: severityVar(severity) }}
        />
      </div>
      <p className="text-muted readout mt-1 text-[11px]">{caption}</p>
    </div>
  );
}

// ------------------------------------------------------------- outcome stack ----

const OUTCOME_SLOTS = [
  { key: 'completed', label: 'completed', token: 'var(--ops-completed)' },
  { key: 'maxIterations', label: 'max iterations', token: 'var(--ops-max-iterations)' },
  { key: 'failed', label: 'failed', token: 'var(--ops-failed)' },
  { key: 'cancelled', label: 'cancelled', token: 'var(--ops-cancelled)' },
] as const;

/**
 * Run outcomes as a part-to-whole stacked bar.
 *
 * The four statuses are kept apart on purpose (`docs/05`, Module 5 lesson 4): collapsing
 * them into "errors" keeps the alarm and throws away the diagnosis. A rising
 * `max_iterations` share is a prompt degrading; a rising `cancelled` share is people
 * giving up on the wait, which is a latency problem wearing a different hat.
 */
export function OutcomeBar({ counts, terminal }: { counts: SliStatusCounts; terminal: number }) {
  const segments = OUTCOME_SLOTS.map((slot) => ({
    ...slot,
    value: counts[slot.key],
    share: terminal === 0 ? 0 : counts[slot.key] / terminal,
  }));

  return (
    <div>
      <div
        className="flex h-6 w-full items-stretch overflow-hidden rounded-md"
        role="img"
        aria-label={segments.map((s) => `${s.value} ${s.label}`).join(', ')}
      >
        {terminal === 0 ? (
          <div className="w-full rounded-md" style={{ backgroundColor: 'var(--ops-track)' }} />
        ) : (
          segments
            .filter((segment) => segment.value > 0)
            .map((segment, index) => (
              <div
                key={segment.key}
                title={`${segment.label}: ${segment.value} (${pct(segment.share, 0)})`}
                style={{
                  width: `${segment.share * 100}%`,
                  backgroundColor: segment.token,
                  // The 2px surface gap, not a stroke: white does the separating.
                  marginLeft: index === 0 ? 0 : 2,
                }}
              />
            ))
        )}
      </div>

      {/* The legend is the identity channel; every entry carries its own count, so the
          chart is readable with no colour perception at all. */}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-baseline gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 translate-y-[-1px] rounded-[2px]"
              style={{ backgroundColor: segment.token }}
            />
            <span className="text-xs">{segment.label}</span>
            <span className="readout text-xs font-medium">{count(segment.value)}</span>
            <span className="text-muted readout text-[11px]">{pct(segment.share, 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------ iteration distribution ----

const bucketLabel = (le: number | null, previous: number | null): string => {
  if (le === null) return '> 15';
  if (previous === null || le === previous + 1) return String(le);
  return `${previous + 1}–${le}`;
};

/**
 * Iterations per run, as a column chart over the same buckets as the
 * `agent_run_iterations` Prometheus histogram.
 *
 * "Read the distribution, never the mean" is the whole instruction in Module 5 lesson 4,
 * which is why this is a chart and the mean is one small number beside it. Mass piling up
 * in the last bucket is runaway loops, and it never shows up as an error because hitting
 * the cap is a bounded outcome rather than a crash.
 */
export function IterationChart({ buckets }: { buckets: SliIterationBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const height = 120;
  const labels = buckets.map((bucket, index) =>
    bucketLabel(bucket.le, index === 0 ? null : (buckets[index - 1]?.le ?? null)),
  );

  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }} data-testid="iteration-chart">
        {buckets.map((bucket, index) => {
          const fraction = bucket.count / max;
          const barHeight = Math.max(
            bucket.count > 0 ? 3 : 1,
            Math.round(fraction * (height - 22)),
          );
          return (
            <div
              key={String(bucket.le)}
              className="flex min-w-0 flex-1 flex-col items-center gap-1"
            >
              {/* Direct label on the cap: the values the axis would otherwise carry. */}
              <span className="readout text-[11px] leading-none">
                {bucket.count === 0 ? '' : bucket.count}
              </span>
              <div
                className="w-full max-w-6"
                style={{
                  height: barHeight,
                  // 4px rounded data-end, square on the baseline.
                  borderRadius: '4px 4px 0 0',
                  backgroundColor: bucket.count > 0 ? 'var(--ops-accent)' : 'var(--ops-track)',
                }}
                title={`${labels[index]} iterations: ${bucket.count} run${bucket.count === 1 ? '' : 's'}`}
              />
            </div>
          );
        })}
      </div>
      {/* Hairline baseline, one step off the surface, solid. */}
      <div className="border-rule border-t" />
      <div className="mt-1 flex gap-2">
        {labels.map((label) => (
          <span key={label} className="text-muted readout min-w-0 flex-1 text-center text-[11px]">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tool table ----

/** Above this, `docs/05` says to open `docs/runbooks/parse-failure-spike.md`. */
export const PARSE_FAILURE_ALERT = 0.1;

/**
 * Per-tool call volume, parse failures and errors.
 *
 * A table rather than a chart: there are up to six tools and three numbers each, the
 * numbers are the point, and a grouped bar chart of eighteen values would be harder to
 * read than eighteen right-aligned figures. The meter in the last column is the one
 * thing worth seeing at a glance.
 */
export function ToolTable({ tools }: { tools: SliToolStat[] }) {
  if (tools.length === 0) {
    return <p className="text-muted text-sm leading-6">No tool calls in this window.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-rule border-b">
          <th className="eyebrow py-1.5 text-left">Tool</th>
          <th className="eyebrow py-1.5 text-right">Calls</th>
          <th className="eyebrow py-1.5 text-right">Not JSON</th>
          <th className="eyebrow py-1.5 text-right">Tool errors</th>
          <th className="eyebrow w-28 py-1.5 text-right">Parse-fail rate</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => {
          const rate = tool.parseFailureRate ?? 0;
          const severity: Severity =
            rate > PARSE_FAILURE_ALERT ? 'critical' : rate > 0 ? 'warning' : 'ok';
          return (
            <tr key={tool.tool} className="border-rule/60 border-b last:border-0">
              <td className="readout py-1.5">{tool.tool}</td>
              <td className="readout py-1.5 text-right tabular-nums">{count(tool.calls)}</td>
              <td className="readout py-1.5 text-right tabular-nums">
                {count(tool.parseFailures)}
              </td>
              <td className="readout py-1.5 text-right tabular-nums">{count(tool.errors)}</td>
              <td className="py-1.5 pl-3">
                <div className="flex items-center justify-end gap-2">
                  <span className="readout text-xs tabular-nums">
                    {pct(tool.parseFailureRate, 0)}
                  </span>
                  <span
                    className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full"
                    style={{ backgroundColor: 'var(--ops-track)' }}
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.min(1, rate) * 100}%`,
                        backgroundColor: severityVar(severity),
                      }}
                    />
                  </span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
