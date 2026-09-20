/**
 * TODO(M14): the in-app SLI dashboard, computed from `agent_runs`/`agent_run_steps` so it
 * works with no external monitoring stack attached. Registered now so the route exists
 * before the panel does.
 */
export function OpsPage() {
  return (
    <section className="py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Service health</h1>
      <p className="mt-3 text-sm text-slate-500">This dashboard arrives in milestone M14.</p>
    </section>
  );
}
