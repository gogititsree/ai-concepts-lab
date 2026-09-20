import { SLI_WINDOW_HOURS, type SliResponse } from '@lab/shared';
import { useState } from 'react';
import { Link } from 'react-router';

import { Button, Eyebrow, Panel } from '../components/ui';
import { queryFallback } from '../features/content/QueryStates';
import {
  count,
  IterationChart,
  Meter,
  ms,
  OpsTheme,
  OutcomeBar,
  pct,
  StatTile,
  ToolTable,
  PARSE_FAILURE_ALERT,
} from '../features/ops/OpsCharts';
import { useServiceHealth, useSli } from '../features/ops/queries';
import { useModelHealth } from '../features/exercises/prompt/useChatRun';

/**
 * `/ops` — the in-app SLI dashboard (M14).
 *
 * Two things this page is, in order of importance:
 *
 * **1. The answer to "is it working", with nothing else running.** Every number here is
 * computed by `GET /ops/sli`, which aggregates `agent_runs` and `agent_run_steps` in
 * Postgres. No Prometheus, no Grafana, no agent, no retention policy. The local
 * observability stack in `docker/observability/` exists for alerting and for practising
 * with the real tools; this page is what works when none of it is up, which on a free
 * tier is most of the time.
 *
 * **2. Teaching material.** Module 6 lesson 4 ends by pointing the reader here, so every
 * tile says in one line what its number means *and what would make it go bad*. A
 * dashboard whose numbers you cannot interpret is a screensaver.
 *
 * The thresholds quoted in the hints are the ones in `docs/05-quality-and-ops.md` and
 * `docs/slo.md`, and they are the same thresholds the Grafana alert rules fire on. If
 * they ever disagree, the docs are right and this file is a bug.
 */

const WINDOW_LABELS: Record<number, string> = { 1: '1 hour', 24: '24 hours', 168: '7 days' };

/** `docs/slo.md`: model call p95 < 30 s over 7 days. */
const MODEL_P95_SLO_MS = 30_000;
/** `docs/slo.md`: agent run success rate ≥ 90 % when the provider is healthy. */
const SUCCESS_RATE_SLO = 0.9;
/** `docs/05`: `max_iterations` + `failed` share above 25 % is an alert. */
const BAD_OUTCOME_ALERT = 0.25;

function WindowSelector({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Time window">
      {SLI_WINDOW_HOURS.map((option) => (
        <Button
          key={option}
          variant={option === hours ? 'primary' : 'secondary'}
          aria-pressed={option === hours}
          onClick={() => onChange(option)}
        >
          {WINDOW_LABELS[option]}
        </Button>
      ))}
    </div>
  );
}

function Section({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <Panel className="p-5">
      <Eyebrow>{title}</Eyebrow>
      <p className="text-muted mt-1 mb-4 max-w-2xl text-xs leading-5">{lead}</p>
      {children}
    </Panel>
  );
}

function EmptyState({ hours }: { hours: number }) {
  return (
    <Panel className="p-6" data-testid="ops-empty">
      <Eyebrow>No runs yet</Eyebrow>
      <p className="mt-2 max-w-xl text-sm leading-6">
        Nothing has called a model in the last {WINDOW_LABELS[hours] ?? `${hours} hours`}, so there
        is nothing to compute an SLI over. That is the correct reading, not a failure — and it is
        why the rates above say &ldquo;&mdash;&rdquo; rather than 0&nbsp;%.
      </p>
      <p className="text-muted mt-3 max-w-xl text-sm leading-6">
        Run the Module 4 playground, the Module 5 agent exercise or your own Module 6 harness and
        come back. Every call leaves a row in <code className="readout">agent_runs</code>, and this
        page is those rows added up.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          to="/modules/prompting/exercise"
          className="readout border-rule bg-surface hover:bg-sunk inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          Module 4 playground
        </Link>
        <Link
          to="/runs"
          className="readout border-rule bg-surface hover:bg-sunk inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          Run history
        </Link>
      </div>
    </Panel>
  );
}

function Dashboard({ sli }: { sli: SliResponse }) {
  const { runs, modelCalls, iterations, tools, errorCodes, tokens } = sli;
  const empty = runs.total === 0;

  const successSeverity =
    runs.successRate === null ? 'ok' : runs.successRate >= SUCCESS_RATE_SLO ? 'ok' : 'critical';
  const p95Severity =
    modelCalls.p95Ms === null
      ? 'ok'
      : modelCalls.p95Ms > MODEL_P95_SLO_MS
        ? 'critical'
        : modelCalls.p95Ms > MODEL_P95_SLO_MS * 0.8
          ? 'warning'
          : 'ok';
  const badSeverity =
    runs.badOutcomeShare === null
      ? 'ok'
      : runs.badOutcomeShare > BAD_OUTCOME_ALERT
        ? 'critical'
        : 'ok';
  const worstTool = tools.reduce<number>(
    (worst, tool) => Math.max(worst, tool.parseFailureRate ?? 0),
    0,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          testId="tile-success-rate"
          label="Run success rate"
          value={pct(runs.successRate)}
          meter={{
            fraction: runs.successRate ?? 0,
            severity: successSeverity,
            caption: `SLO ≥ ${pct(SUCCESS_RATE_SLO, 0)} · ${count(runs.byStatus.completed)}/${count(runs.terminal)} finished runs`,
          }}
          hint="Completed runs over all finished runs. It falls when the model is unreachable, when a prompt stops converging, or when people cancel because the wait got too long — three different causes, which is why the outcome bar below keeps them apart."
        />
        <StatTile
          testId="tile-model-p95"
          label="Model call p95"
          value={ms(modelCalls.p95Ms)}
          meter={{
            fraction: (modelCalls.p95Ms ?? 0) / MODEL_P95_SLO_MS,
            severity: p95Severity,
            caption: `SLO < ${ms(MODEL_P95_SLO_MS)} · p50 ${ms(modelCalls.p50Ms)} · ${count(modelCalls.count)} calls`,
          }}
          hint="Per call, not per run, or the iteration count hides inside it. It goes bad when the model is cold-loading (20–40 s on this hardware), when something else is using the GPU, or when a prompt grew — usually because more tools were attached."
        />
        <StatTile
          testId="tile-bad-outcomes"
          label="Failed + capped"
          value={pct(runs.badOutcomeShare, 0)}
          meter={{
            fraction: runs.badOutcomeShare ?? 0,
            severity: badSeverity,
            caption: `alert above ${pct(BAD_OUTCOME_ALERT, 0)} · ${count(runs.byStatus.failed)} failed, ${count(runs.byStatus.maxIterations)} capped`,
          }}
          hint="Runs that failed outright plus runs that hit the iteration cap. The second kind never throws and never shows up in an error rate, which is exactly why it is counted here — a rising share is a prompt or a tool description degrading."
        />
        <StatTile
          testId="tile-tokens"
          label="Tokens per run"
          value={tokens.perRunAvg === null ? '—' : Math.round(tokens.perRunAvg).toLocaleString()}
          hint="Prompt plus completion, averaged over finished runs. Prompt tokens are the real driver because they are re-sent every iteration: attaching all six tools instead of one took a measured first call from 227 to 1052 prompt tokens and 23 s to 71 s."
          footnote={`${count(tokens.promptTotal)} prompt · ${count(tokens.completionTotal)} completion`}
        />
      </div>

      {empty ? (
        <EmptyState hours={sli.window.hours} />
      ) : (
        <>
          <Section
            title="Run outcomes"
            lead="Four terminal statuses, kept distinct on purpose. Collapsing them into “errors” keeps the alarm and throws away the diagnosis: a rising max-iterations share is a prompt degrading, and a rising cancelled share is people giving up on the wait."
          >
            <OutcomeBar counts={runs.byStatus} terminal={runs.terminal} />
            {runs.byStatus.running > 0 && (
              <p className="text-muted mt-3 text-xs leading-5">
                {count(runs.byStatus.running)} run{runs.byStatus.running === 1 ? ' is' : 's are'}{' '}
                still in flight and not counted in any rate above.
              </p>
            )}
          </Section>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section
              title="Iterations per run"
              lead="The distribution, never the mean: a bimodal shape means two populations of question, and the tail is where the cost is. Mass in the last bucket is a runaway loop, which is a bounded outcome rather than a crash and so never appears as an error."
            >
              <IterationChart buckets={iterations.buckets} />
              <p className="text-muted mt-3 text-xs leading-5">
                {count(iterations.total)} runs · mean{' '}
                <span className="readout">
                  {iterations.meanPerRun === null ? '—' : iterations.meanPerRun.toFixed(2)}
                </span>{' '}
                iterations. Cap is 15.
              </p>
            </Section>

            <Section
              title="Model latency"
              lead="Inference is over 99.9 % of an agent run’s wall clock on this machine — tool execution measures 2–9 ms — so this is the latency SLI and everything else is rounding."
            >
              <dl className="grid grid-cols-3 gap-3">
                {[
                  ['p50', ms(modelCalls.p50Ms)],
                  ['p95', ms(modelCalls.p95Ms)],
                  ['max', ms(modelCalls.maxMs)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="eyebrow">{label}</dt>
                    <dd className="readout text-xl leading-tight font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4">
                <Meter
                  fraction={(modelCalls.p95Ms ?? 0) / MODEL_P95_SLO_MS}
                  severity={p95Severity}
                  caption={`p95 against the 30 s SLO · ${count(modelCalls.count)} calls in window`}
                />
              </div>
              <p className="text-muted mt-3 text-xs leading-5">
                A p95 above 30 s for fifteen minutes is the alert in{' '}
                <code className="readout">docs/runbooks/slow-inference.md</code>. The usual causes
                are a cold model load, another model resident at the same time, or a prompt that
                grew.
              </p>
            </Section>
          </div>

          <Section
            title="Tool calls and parse failures"
            lead="“Not JSON” counts arguments the provider could not hand back as JSON at all — a model, prompt or schema problem. “Tool errors” counts calls that parsed but failed the schema or threw. They have different fixes, so they are different columns."
          >
            <ToolTable tools={tools} />
            <p className="text-muted mt-3 text-xs leading-5">
              A parse-failure rate above {pct(PARSE_FAILURE_ALERT, 0)} over an hour is the alert in{' '}
              <code className="readout">docs/runbooks/parse-failure-spike.md</code>.{' '}
              {worstTool > PARSE_FAILURE_ALERT
                ? 'One tool is over it right now.'
                : 'Nothing is over it right now.'}
            </p>
          </Section>

          <Section
            title="Error codes"
            lead="The terminal error code on runs that did not complete, worst first. This is the fastest route from “something is wrong” to “which runbook”."
          >
            {errorCodes.length === 0 ? (
              <p className="text-muted text-sm leading-6">
                No run in this window ended with an error code.
              </p>
            ) : (
              <ul className="space-y-1.5" data-testid="ops-error-codes">
                {errorCodes.map((entry) => (
                  <li key={entry.code} className="flex items-baseline justify-between gap-4">
                    <span className="readout text-sm">{entry.code}</span>
                    <span className="readout text-sm font-medium tabular-nums">
                      {count(entry.count)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

export function OpsPage() {
  const [hours, setHours] = useState<number>(24);
  const sli = useSli(hours);
  const health = useServiceHealth();
  const model = useModelHealth();

  const fallback = queryFallback(sli, {
    label: 'Computing the SLIs…',
    signInFor: 'see service health',
  });

  const serviceStatus = health.data?.status ?? (health.error ? 'down' : 'unknown');
  const modelOk = model.data?.ok ?? false;
  const modelProvider = model.data?.provider ?? '—';

  return (
    <OpsTheme>
      <section className="space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight">Service health</h1>
            <p className="text-muted mt-2 text-sm leading-6">
              Computed from <code className="readout">agent_runs</code> and{' '}
              <code className="readout">agent_run_steps</code> in Postgres, so this page works with
              no monitoring stack attached. Every number is service-wide, not just yours. The
              thresholds are the SLOs in <code className="readout">docs/slo.md</code>.
            </p>
          </div>
          <WindowSelector hours={hours} onChange={setHours} />
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile
            testId="tile-availability"
            label="Service"
            value={serviceStatus}
            status={{
              label:
                serviceStatus === 'ok'
                  ? 'database reachable, API answering'
                  : serviceStatus === 'degraded'
                    ? 'answering, but a dependency is missing'
                    : 'not answering',
              severity:
                serviceStatus === 'ok'
                  ? 'ok'
                  : serviceStatus === 'degraded'
                    ? 'warning'
                    : 'critical',
            }}
            hint="GET /health, the same probe the uptime check hits every 30 minutes. It goes down when Postgres is unreachable; a missing model is degraded and deliberately does not page."
          />
          <StatTile
            testId="tile-model-provider"
            label="Model provider"
            value={modelProvider}
            status={{
              label: modelOk
                ? 'up, chat model pulled'
                : modelProvider === 'none'
                  ? 'not configured on this deployment (expected)'
                  : 'unreachable or model not pulled',
              severity: modelOk ? 'ok' : modelProvider === 'none' ? 'warning' : 'critical',
            }}
            hint="The gauge behind model_provider_up. Zero for five minutes with a provider that is supposed to exist is an alert; on the deployed instance the provider is none by design, so it is expected to sit at zero there."
          />
        </div>

        {fallback}

        {sli.data && <Dashboard sli={sli.data} />}

        {sli.data && (
          <p className="text-muted text-xs leading-5">
            Window {new Date(sli.data.window.from).toLocaleString()} →{' '}
            {new Date(sli.data.window.to).toLocaleString()}. The same rows are readable one at a
            time under{' '}
            <Link to="/runs" className="underline">
              Runs
            </Link>
            , and the same signals are exported to Prometheus at{' '}
            <code className="readout">/metrics</code> for the local Grafana stack.
          </p>
        )}
      </section>
    </OpsTheme>
  );
}
