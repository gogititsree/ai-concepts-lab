import { NavLink, Outlet } from 'react-router';

/**
 * The app shell: a hairline header, one measured column, and a footer that admits what is
 * temporary. Everything sits on the plotting-paper background, which is the same grid the
 * canvases draw -- the page and the plot are one surface.
 */

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  [
    'readout rounded px-2 py-1 text-xs tracking-wide uppercase transition-colors',
    isActive ? 'text-ink bg-sunk' : 'text-muted hover:text-ink',
  ].join(' ');

/** A 2-3-1 network, four strokes. The one decorative mark in the app, and it is the subject. */
function Mark() {
  return (
    <svg viewBox="0 0 28 20" className="h-5 w-7" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1" opacity="0.45">
        <path d="M4 5 L14 4 M4 5 L14 10 M4 5 L14 16 M4 15 L14 4 M4 15 L14 10 M4 15 L14 16" />
        <path d="M14 4 L24 10 M14 10 L24 10 M14 16 L24 10" />
      </g>
      <g fill="currentColor">
        <circle cx="4" cy="5" r="1.8" />
        <circle cx="4" cy="15" r="1.8" />
        <circle cx="14" cy="4" r="1.8" />
        <circle cx="14" cy="10" r="1.8" />
        <circle cx="14" cy="16" r="1.8" />
        <circle cx="24" cy="10" r="1.8" />
      </g>
    </svg>
  );
}

export function AppShell() {
  return (
    <div className="plot-grid text-ink flex min-h-screen flex-col">
      <header className="border-rule bg-surface/85 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
          <NavLink to="/" className="flex items-center gap-2" aria-label="AI Concepts Lab home">
            <Mark />
            <span className="readout text-sm font-semibold tracking-[0.14em] uppercase">
              Concepts Lab
            </span>
          </NavLink>
          <nav className="flex items-center gap-1" aria-label="Main">
            <NavLink to="/" end className={navLinkClass}>
              Dashboard
            </NavLink>
            <NavLink to="/modules" className={navLinkClass}>
              Modules
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">
        <Outlet />
      </main>

      <footer className="border-rule mt-8 border-t">
        <div className="text-muted mx-auto w-full max-w-6xl px-4 py-5 text-xs">
          <p className="readout">
            Milestone M3 &middot; content loaded from <code>content/modules</code> at build time
            &middot; progress kept in this browser only
          </p>
        </div>
      </footer>
    </div>
  );
}
