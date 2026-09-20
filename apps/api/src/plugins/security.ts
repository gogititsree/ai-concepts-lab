import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Config } from '../config.js';

/**
 * Security response headers (M13).
 *
 * The API and the SPA share one origin in production — Fastify serves `apps/web/dist`
 * itself — so these headers are not "API hardening" in the abstract: they are the
 * policy the *browser* enforces on this application's own pages. Getting a directive
 * wrong therefore breaks a feature, silently, and only in production. Every directive
 * below is here because something in `apps/web` needs it, and says which thing.
 *
 * What is deliberately NOT here: HSTS on localhost, `'unsafe-eval'` on the document, and
 * a nonce-based script policy. The first two are explained inline. A nonce would be
 * strictly better than `'self'` only if the app had inline scripts to authorise, and the
 * Vite build emits none (`apps/web/dist/index.html` is two `<link>`s and one
 * `<script type="module" src>`), so a nonce would add per-request state and a template
 * step for no gain.
 */

// ------------------------------------------------------------------ directives ----

export type CspDirectives = Record<string, string[]>;

export interface CspOptions {
  /**
   * Production means "the bundle in `apps/web/dist`". Development means "Vite's dev
   * server", which is a fundamentally looser thing: it injects the React Fast Refresh
   * preamble as an *inline* module script, rewrites source with `eval`-backed sourcemaps
   * and keeps a WebSocket open for HMR. A policy tight enough for the built bundle stops
   * the dev server dead, so the two are separate and this flag picks between them.
   *
   * In practice the dev policy is nearly unobservable — in development Vite serves the
   * HTML on :5173 and only proxies `/api` here, so these headers land on JSON responses.
   * It is written properly anyway, because "run the production build locally with
   * NODE_ENV=development" is exactly when a wrong answer is expensive.
   */
  development: boolean;
  /**
   * Whether the deployment believes it is behind TLS (`COOKIE_SECURE`). Gates
   * `upgrade-insecure-requests`: on an http origin it would rewrite this app's own
   * same-origin subresource requests to https and break the page. Browsers exempt
   * localhost/127.0.0.1 from the upgrade, but relying on that exemption to keep the
   * Playwright suite (which runs `NODE_ENV=production` over plain http) green would be
   * relying on a footnote.
   */
  tls: boolean;
}

/**
 * Google Fonts is the one third party this app talks to: `apps/web/index.html` links a
 * stylesheet from `fonts.googleapis.com`, which in turn `@font-face`s woff2 files from
 * `fonts.gstatic.com`. Two origins, two directives — a stylesheet host is not a font
 * host, and writing one and not the other produces a page in the fallback font with a
 * violation nobody notices.
 */
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';

/** The policy for the served SPA, and the reason for every entry. */
export function buildCspDirectives({ development, tls }: CspOptions): CspDirectives {
  const directives: CspDirectives = {
    // Everything not named below comes from this origin only.
    'default-src': ["'self'"],

    // No injected `<base href>` can repoint every relative URL in the SPA at an
    // attacker's host. Cheap, and it closes a real bypass of `script-src 'self'`.
    'base-uri': ["'self'"],

    // The built bundle has no inline script and no `eval` on the document (the one
    // `new Function` in this codebase runs inside the harness worker, which gets its own
    // policy — see `WORKER_CSP` below). So the document keeps the strict form.
    'script-src': development
      ? // Vite's dev HTML carries an inline `<script type="module">` preamble, and its
        // transform pipeline uses eval-backed sourcemaps.
        ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
      : ["'self'"],
    // Inline event handlers (`onclick="…"`) are never legitimate here; React attaches
    // listeners in JavaScript. This is the half of `unsafe-inline` that actually matters.
    'script-src-attr': ["'none'"],

    // `'unsafe-inline'` for styles is unavoidable and, unlike its script twin, cheap:
    //   - KaTeX renders every formula with inline `style="height:…"` attributes;
    //   - CodeMirror 6 (Module 6's editor) injects `<style>` elements at runtime via
    //     style-mod;
    //   - React `style={{…}}` props throughout the visualisations.
    // A hash or nonce cannot cover style *attributes* generated at render time, and
    // `style-src-attr` has no hash form that helps. The exposure is CSS-injection
    // (exfiltration via attribute selectors and `background-image`), not script
    // execution, and the app renders no attacker-controlled markup: `react-markdown`
    // renders curriculum Markdown that comes from the repo, through the seed.
    'style-src': ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS],

    // KaTeX's fonts are bundled into `dist/assets`; IBM Plex comes from Google.
    //
    // `data:` is here because of a violation the browser check actually caught, not on
    // principle: Vite inlines any asset under `build.assetsInlineLimit` (4 KB), and
    // exactly one KaTeX face — `KaTeX_Size3-Regular.woff2`, the large math delimiters —
    // is small enough to come out of the build as `src: url(data:font/woff2;base64,…)`.
    // Without `data:` the stylesheet loads, the page looks fine, and oversized brackets
    // and radicals silently fall back to a system font. A textbook production-only
    // regression: invisible locally (same bundle, no CSP in dev) and invisible in a
    // screenshot unless you know what the glyphs should look like.
    'font-src': ["'self'", GOOGLE_FONTS_FILES, 'data:'],

    // `data:` is for exactly one image: the MFA enrollment QR code, which
    // `SecuritySettingsPage` renders as `<img src="data:image/svg+xml;base64,…">` from
    // the SVG the API returns. Without it, enrolling a second factor shows a broken
    // image and the user has to type the secret by hand.
    'img-src': ["'self'", 'data:'],

    // The SPA talks to its own API only — REST plus the `EventSource` on
    // `/model/runs/:id/events`, both same-origin. In development it also holds Vite's
    // HMR socket open.
    'connect-src': development ? ["'self'", 'ws:', 'wss:'] : ["'self'"],

    // Module 6 runs the learner's `runAgent` in a dedicated Web Worker, which Vite emits
    // as a same-origin chunk (`/assets/harnessRunner.worker-<hash>.js`). `child-src` is
    // the fallback for browsers that predate `worker-src`; without one of the two, the
    // worker fails to start and Module 6 is dead in production only.
    'worker-src': ["'self'"],
    'child-src': ["'self'"],

    // Nothing here embeds or is embedded.
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],

    // The app posts with `fetch`, never with a form. Stops an injected `<form>` from
    // exfiltrating whatever the user types next.
    'form-action': ["'self'"],

    'manifest-src': ["'self'"],
    // No <audio>/<video>/<track> anywhere in the SPA.
    'media-src': ["'none'"],
  };

  if (tls) {
    // Only meaningful on an https origin. `[]` is how a valueless directive is spelled.
    directives['upgrade-insecure-requests'] = [];
  }

  return directives;
}

/** `{'default-src': ["'self'"]}` → `default-src 'self'`. */
export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(' ')}`))
    .join('; ');
}

// -------------------------------------------------------- the harness worker ----

/**
 * The policy served **with the harness worker script itself**.
 *
 * Module 6's whole point is that the learner writes `runAgent` and it runs. The worker
 * compiles that source with `new Function`, which CSP treats as `eval` and
 * `script-src 'self'` forbids. Three ways out:
 *
 *  1. Add `'unsafe-eval'` to the document's `script-src`. This is the easy one and the
 *     wrong one: it re-enables `eval` for the entire application — every page, every
 *     dependency — to serve one exercise.
 *  2. Load the worker from a `blob:` URL. A worker created from a local scheme
 *     *inherits* its creator's policy, so this does not help; it only makes the
 *     inheritance harder to see.
 *  3. Give the worker its own policy. A dedicated worker fetched over the network builds
 *     its policy container from **its own response's** headers, not from the document's
 *     (HTML's "run a worker" → "create a policy container from a fetch response"). So
 *     the exact response that carries the worker script can carry a different CSP.
 *
 * Option 3 is what this is. The relaxation is scoped to one script in one realm, and it
 * is still a policy: the worker may load code from this origin and evaluate strings, and
 * it may not do anything else — `default-src 'none'` means the learner's code cannot
 * even `fetch`. (It never needed to: `protocol.ts` has the *page* perform model calls
 * precisely so the untrusted realm holds no credentials.)
 *
 * This is a defence-in-depth measure, not a sandbox. The learner is attacking only
 * themselves, and the security boundary that matters is the server's.
 */
export const WORKER_CSP = serializeCsp({
  'default-src': ["'none'"],
  'script-src': ["'self'", "'unsafe-eval'"],
});

/**
 * Vite names worker chunks `<name>.worker-<hash>.js` under `/assets/`. Used only as a
 * fallback for clients that do not send Fetch Metadata.
 */
export const WORKER_ASSET_PATTERN = /^\/assets\/[^/]*worker[^/]*\.js(\?.*)?$/;

/**
 * Is this request the browser fetching a worker script?
 *
 * The primary signal is `Sec-Fetch-Dest: worker`, which the browser sets and page script
 * cannot forge — it says what the response will be *used as*, which is exactly the
 * question. The filename pattern is a fallback, so that a client without Fetch Metadata
 * (or a Vite output-naming change) degrades to "Module 6 still works" rather than to
 * "Module 6 is broken in production only".
 */
export function isWorkerScriptRequest(request: Pick<FastifyRequest, 'headers' | 'url'>): boolean {
  const dest = request.headers['sec-fetch-dest'];
  if (typeof dest === 'string' && ['worker', 'sharedworker', 'serviceworker'].includes(dest)) {
    return true;
  }
  return WORKER_ASSET_PATTERN.test(request.url);
}

// ----------------------------------------------------------------- the plugin ----

/**
 * `Permissions-Policy` is not part of helmet (it was dropped when the spec churned), so
 * it is set by hand. An empty allowlist `()` denies the feature to this document and to
 * everything it embeds — and since `frame-src` is `'none'`, that is just this document.
 *
 * These three are the ones a user would be alarmed to be asked for. The app has no
 * camera, microphone or geolocation feature, so the policy is a promise the code already
 * keeps; its value is that a future dependency cannot quietly start asking.
 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=()';

/** 180 days, helmet's default. Long enough to matter, short enough to back out of. */
export const HSTS_MAX_AGE_SECONDS = 15_552_000;

export interface SecurityHeadersOptions {
  /** Defaults to `app.config`. */
  config?: Config;
}

export async function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions = {},
): Promise<void> {
  const cfg = options.config ?? app.config;
  const development = cfg.NODE_ENV !== 'production';
  // `COOKIE_SECURE` is the app's existing "am I behind TLS?" answer; reusing it means
  // HSTS and the https upgrade cannot disagree with the session cookie about which
  // scheme this instance is served over.
  const tls = cfg.NODE_ENV === 'production' && cfg.COOKIE_SECURE;

  await app.register(helmet, {
    // `useDefaults: false`: the policy above is written out in full, so reading this file
    // tells you the whole policy. Merging with helmet's defaults would mean the effective
    // header depended on a minor version bump of a dependency.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildCspDirectives({ development, tls }),
    },

    // HSTS on `http://localhost` is worse than useless: the browser pins the host to
    // https for months, and the next `pnpm dev` is an unreachable site with no obvious
    // cause. Only sent when this instance is actually served over TLS.
    hsts: tls ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false } : false,

    // Stops content sniffing: a JSON error body must never be executed because a browser
    // guessed it looked like script.
    noSniff: true,

    // Send the origin (not the path) cross-origin, and nothing at all when leaving https
    // for http. `no-referrer` would also break nothing here, but this keeps outbound
    // links to documentation attributable without leaking which lesson a user is on.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    // Belt and braces with `frame-ancestors 'none'`, for the clickjacking case in a
    // browser too old to enforce CSP level 2.
    frameguard: { action: 'deny' },

    // Cross-origin isolation is not needed (no SharedArrayBuffer) and COEP would break
    // the Google Fonts requests, which are not CORS-enabled for this purpose.
    crossOriginEmbedderPolicy: false,
    // `same-site`, not `same-origin`: the app is one origin, but a stricter value buys
    // nothing and this leaves room for a future assets subdomain.
    crossOriginResourcePolicy: { policy: 'same-site' },

    // Nothing here is worth an `X-Powered-By`-style advert.
    hidePoweredBy: true,
  });

  // Registered *after* helmet so it runs after helmet's onRequest hook and can override
  // what that hook set.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    if (isWorkerScriptRequest(request)) {
      reply.header('content-security-policy', WORKER_CSP);
    }
  });
}
