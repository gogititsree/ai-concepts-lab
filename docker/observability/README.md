# Local observability stack

Prometheus + Grafana + Loki + Promtail, watching the API you are editing.

This is the learning environment from `docs/05-quality-and-ops.md` → "Local observability
stack". It is **not** how the deployed instance is monitored — that is `/health`,
UptimeRobot and `.github/workflows/uptime.yml` (see `docs/slo.md`). What this stack is for
is having the real tools in front of you while you break things on purpose.

None of it is required to answer "is it working": the in-app `/ops` page computes the same
SLIs straight out of Postgres. This stack adds the things a database cannot do — rate
windows, alert rules with pending periods, and logs next to metrics on one screen.

## Start it

```bash
pnpm db:up            # Postgres, if it is not already running
pnpm setup:env        # once: writes METRICS_TOKEN into .env if it is empty
pnpm obs:up           # Prometheus + Grafana + Loki + Promtail
```

Then start the app so there is something to scrape, teeing the log where Promtail can
find it:

```bash
mkdir -p logs
pnpm dev 2>&1 | tee -a logs/api.log
```

| What             | Where                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| Grafana          | <http://localhost:3001> — opens on the provisioned dashboard, no login needed |
| Prometheus       | <http://localhost:9090> — `Status → Targets` should show `api` as **UP**      |
| Loki             | <http://localhost:3100/ready>                                                 |
| The app's `/ops` | <http://localhost:5173/ops>                                                   |

Stop it, keeping the data: `pnpm obs:down`. To throw the history away as well:

```bash
docker compose --env-file .env -f docker/docker-compose.yml --profile observability down -v
```

`pnpm db:down` stops Postgres. Neither command touches the other's containers, because the
observability services sit behind a compose **profile** and `db:up`/`db:down` name none.

## `pnpm obs:up` is doing three things worth knowing about

**The token.** `GET /metrics` needs a bearer `METRICS_TOKEN` and answers **503** when the
API has none configured — closed rather than public, because a metrics page is a free
inventory of every route, error code and traffic volume in the service. Prometheus cannot
expand environment variables inside its own config, so the token travels as a compose
secret sourced from the environment (`secrets.metrics_token.environment`) and Prometheus
reads it from `/run/secrets/metrics_token`. That is why the commands above pass
`--env-file .env`: without it, compose looks for `docker/.env` and the secret is empty.

**The host.** Prometheus scrapes `host.docker.internal:3000`, i.e. the API running on your
machine under `pnpm dev`, not a container. `extra_hosts: host.docker.internal:host-gateway`
is what makes that name work on Linux as well as Docker Desktop.

**The port.** Grafana is on **3001**, because 3000 is the API.

## Check it is actually working

```bash
# 1. The API is exporting metrics (401 without the token is the correct answer).
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/metrics
curl -s -H "Authorization: Bearer $(grep '^METRICS_TOKEN=' .env | cut -d= -f2-)" \
  http://localhost:3000/metrics | grep -E '^(model_provider_up|agent_runs_total)'

# 2. Prometheus is scraping it.
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
  | python -c "import json,sys; print([(t['labels']['job'], t['health']) for t in json.load(sys.stdin)['data']['activeTargets']])"

# 3. Prometheus has the app's own series, not just its own.
curl -s 'http://localhost:9090/api/v1/query?query=model_provider_up' | python -m json.tool

# 4. Loki has log lines.
curl -s -G 'http://localhost:3100/loki/api/v1/query_range' \
  --data-urlencode 'query={job="api"}' --data-urlencode 'limit=5' | python -m json.tool
```

## What is provisioned

| File                                      | What it is                                                      |
| ----------------------------------------- | --------------------------------------------------------------- |
| `prometheus/prometheus.yml`               | scrape config: the API on the host, every 15 s, bearer token    |
| `grafana/provisioning/datasources/`       | Prometheus + Loki, fixed UIDs, `Loki → runs` derived field      |
| `grafana/provisioning/dashboards/`        | loads every JSON in `grafana/dashboards/` into one folder       |
| `grafana/dashboards/agent.json`           | **the docs/05 metric table**, panel by panel                    |
| `grafana/provisioning/alerting/rules.yml` | the five docs/05 alert thresholds, each naming its runbook      |
| `loki/loki-config.yml`                    | single-binary Loki, filesystem storage, 7-day retention         |
| `promtail/promtail-config.yml`            | tails `logs/api.log`, parses pino JSON, maps level → `severity` |

Nothing is clicked into existence. A dashboard that only exists in someone's browser
profile is not a dashboard, it is a memory — so a `down -v` followed by an `up` gives back
exactly the same stack, which is also what makes the alert thresholds reviewable in a diff.

Edits made in the Grafana UI survive until the next restart (`allowUiUpdates: true`); if
one is worth keeping, export the JSON over `grafana/dashboards/agent.json` and commit it.

## The alert rules

Five, matching the table in `docs/05-quality-and-ops.md` exactly:

| Alert                               | Threshold             | For    | Runbook                  |
| ----------------------------------- | --------------------- | ------ | ------------------------ |
| Model call p95 above 30 s           | p95 > 30 s            | 15 min | `slow-inference.md`      |
| Model call error rate above 20 %    | errors / calls > 0.2  | 10 min | `model-provider-down.md` |
| Tool-call parse-failure rate > 10 % | over a 1 h window     | 5 min  | `parse-failure-spike.md` |
| Failed + `max_iterations` share     | > 25 % of runs        | 15 min | `runaway-loops.md`       |
| Model provider down                 | `model_provider_up` 0 | 5 min  | `model-provider-down.md` |

They fire into Grafana's own alert list (`Alerting → Alert rules`), which is enough to
practise tuning without paying for a pager. The provider-down rule excludes
`provider="none"` on purpose: the deployed instance runs no model by design and would
otherwise alert forever.

To watch one fire, stop Ollama while the stack is up (`ollama stop gemma4:latest`, or kill
the server) and give it five minutes.

## Troubleshooting

**Prometheus target is DOWN with `401 Unauthorized`.** The token in `.env` and the one the
API booted with have diverged. Restart the API after changing `.env` — config is parsed
once at startup, by design.

**Prometheus target is DOWN with `connection refused`.** The API is not running, or it is
not on 3000. Prometheus is reaching for the _host_, so a containerised API would need a
different target.

**Grafana shows "No data" but the target is UP.** Almost always the time range: a metric
with no traffic in it has no samples. Generate some (run a Module 4 prompt) and widen the
range to 6 h.

**Loki has no lines.** The API logs to stdout; nothing writes `logs/api.log` unless you
tee it. Check `docker logs lab-promtail` for a path error.

**Loki has lines but nothing about model calls or runs.** That is correct and it is a
known gap, not a configuration problem. As shipped, the API emits HTTP request/response
lines and boot-time warnings and nothing else: the per-model-call structured fields
`docs/05-quality-and-ops.md` specifies (`runId`, `stepIndex`, `latencyMs`, `toolName`,
`parseOk`, `errorCode`…) are not implemented, and a run that fails with
`MODEL_UNAVAILABLE` produces no log line at all. Everything about a run is in
`agent_runs` / `agent_run_steps` and in Prometheus instead. See action item 6 in
`docs/postmortems/2026-09-20-ollama-down-mid-run.md`.

**This stack competes with the model for memory.** On an 8 GB machine, these four
containers plus Docker's WSL VM are roughly the margin `gemma4:latest` needs to load: in
M15 it left 482 MB free and the model failed with `unable to allocate CPU_REPACK buffer`.
If inference starts failing shortly after `pnpm obs:up`, that is why — `pnpm obs:down`,
kill any orphaned `llama-server`, and `wsl --shutdown` to reclaim the VM. See
`docs/runbooks/model-provider-down.md` → Mitigate D.
