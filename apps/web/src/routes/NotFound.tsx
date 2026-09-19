import { Link } from 'react-router';

export function NotFound({ what = 'That page' }: { what?: string }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{what} does not exist</h1>
      <p className="text-muted mt-3 text-sm leading-6">
        The curriculum is loaded from <code>content/modules</code>, so a missing page usually means
        a slug changed.
      </p>
      <Link
        to="/modules"
        className="readout border-ink bg-ink text-paper mt-6 inline-flex rounded-md border px-3 py-1.5 text-xs font-medium"
      >
        Back to the modules
      </Link>
    </div>
  );
}
