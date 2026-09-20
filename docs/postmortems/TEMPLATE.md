# Postmortem — &lt;short, factual title: what broke, not who broke it&gt;

- **Date:** YYYY-MM-DD (the incident, not the write-up)
- **Authors:**
- **Status:** draft | in review | **final** | superseded

> Copy this file to `docs/postmortems/YYYY-MM-DD-<slug>.md` and fill it in. Keep every
> heading, including the ones you have nothing for — "What went well: nothing, and that is
> the finding" is a sentence worth writing. The section list is fixed by
> `docs/05-quality-and-ops.md` so that two postmortems written months apart can be read
> side by side.
>
> **Blameless means one specific thing here**, and it is not politeness: the question is
> never "who wrote the migration", it is "what made the bad version look fine in review".
> A postmortem that names a person has stopped looking for the answer. Write about
> systems, defaults, checks that did not exist and signals nobody was watching.
>
> Delete these quoted instructions when you fill the template in.

## Summary

> Two sentences. What broke, and what the consequence was. Someone who reads only this
> should be able to decide whether to read the rest.

## Impact

> Who was affected, what they could not do, and for how long. Give the duration as a
> number even when it is approximate, and say which end of it is uncertain. If the impact
> was zero because nobody was using the system, say that — "no user impact because there
> are no users" is honest and changes how seriously the action items should be taken.

## Detection

> How the incident was found, and **how long after it started**. Those are two different
> numbers and the gap between them is usually the most useful thing in the document.
>
> Then, explicitly: what *should* have caught it and did not. Go through the monitors by
> name — `/health`, `.github/workflows/uptime.yml`, the Grafana rules in
> `docker/observability/grafana/provisioning/alerting/rules.yml`, `deploy.yml`'s smoke
> checks, CI — and say for each one whether it fired, and why not if it did not. A monitor
> that was silent for a good reason and a monitor that was silent by accident look the
> same on the day and are completely different problems.

## Timeline

> UTC, one row per event, from the first change that mattered to the moment the incident
> was closed. Include the boring rows: the deploy that went green, the check that passed,
> the minutes where nothing happened because nobody knew yet. Mark the start of impact and
> the start of detection so the two durations above can be read off the table.

| Time (UTC) | Event |
| ---------- | ----- |
|            |       |

## Root causes

> **Technical first**, in one or two sentences with the actual error text. Then **process**:
> what allowed the technical cause to reach a running system. There is almost always more
> than one, and the process cause is the one that generalises.

**Technical.**

**Process.**

## Contributing factors

> Things that were not the cause but made the incident more likely, longer, or harder to
> diagnose. Configuration that was surprising, a document that was out of date, a signal
> that existed but was buried, a machine that was already short of memory.

## What went well

> Genuinely. Something that worked is a control worth keeping, and naming it stops the
> action items from quietly dismantling it.

## What went poorly

## Where we got lucky

> The most important section and the easiest to skip. What would have made this materially
> worse, and did not happen for a reason you did not choose? Luck is an un-costed
> dependency; writing it down is how it becomes an action item instead of a repeat.

## Action items

> Each one has an owner, a due date and a type. **Do not invent action items you would not
> actually do** — a backlog of aspirational tickets makes the real ones invisible. If the
> honest answer is "accepted risk, here is why", write that instead and give it no owner.
>
> - **prevent** — makes the failure impossible or much harder
> - **detect** — does not stop it, but shortens the time to knowing
> - **mitigate** — does not stop it, but shortens or shrinks the impact

| # | Action | Type | Owner | Due | Status |
| - | ------ | ---- | ----- | --- | ------ |
| 1 |        |      |       |     |        |

## Lessons for the curriculum

> This project exists to teach. What should change in a lesson, an exercise, a runbook or
> an ADR because of what happened? An incident that does not feed back into
> `content/` or `docs/runbooks/` was just an outage.
