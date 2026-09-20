import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vite.config';

/**
 * The web workspace's coverage gate.
 *
 * ## Why there is one at all
 *
 * `docs/05-quality-and-ops.md` says "90 % lines on `nn-core` and
 * `apps/api/src/{auth,model,progress}`; no global gate elsewhere", and for fifteen
 * milestones there was none here. `apps/api` and `packages/nn-core` pass their gates
 * comfortably (auth 92.97, model 95.21, progress 97.24, nn-core 100). This workspace was
 * measured for the first time at **83.14 % statements / 83.92 % branches / 78.8 %
 * functions** — which is respectable, and entirely unprotected: nothing at all stopped
 * the next commit from taking it to 60.
 *
 * ## Why these numbers and not 90
 *
 * **They are the measured figures, rounded down.** A gate is a ratchet, not an
 * aspiration. Setting 90 here would mean either failing the build on the day it was
 * added, or writing filler tests against components nobody is going to change — and a
 * gate that fails on the next honest commit gets deleted, which leaves the workspace
 * worse off than the no-gate state it was in.
 *
 * Measured on the full suite with `src/**` instrumented and the worker excluded (see
 * below), immediately before these thresholds were written:
 *
 * | | measured | gate | headroom |
 * | --- | --- | --- | --- |
 * | statements | 85.57 % (7128/8330) | 85 | ~48 statements |
 * | lines | 85.57 % | 85 | ~48 lines |
 * | branches | 84.97 % (1590/1872) | 84 | ~18 branches |
 * | functions | 82.10 % (413/503) | 81 | ~6 functions |
 *
 * The headroom is about one point, deliberately: v8's percentages move by a fraction when
 * a file is reformatted or a helper is inlined, and a gate that trips on noise teaches
 * people to `--no-verify`. One point is enough to absorb that and far too little to
 * absorb an untested feature.
 *
 * **Raise these numbers; do not treat them as met.** They record where the workspace was
 * on 2026-09-20, not where it should be. The honest way to move them is to raise the
 * floor after a milestone that genuinely improved coverage, the way this file's first
 * version already did: adding the model-health banner tests and direct tests for
 * `src/hooks`, `useMlpStore` and the security page's password/backup-code panels took the
 * measured statements from 83.14 to 85.57 before the numbers below were fixed.
 *
 * ## Global, not per-directory
 *
 * `apps/api`'s gate is per-directory because `docs/05` names three directories. Here a
 * single global number is the honest shape: roughly a third of `src` is React components
 * whose reasonable coverage varies by an order of magnitude — `src/features/ops` is at
 * 99 % because it is a table of numbers, `src/features/exercises/attention` is at 6 %
 * because it is a canvas that draws arcs, and neither figure is a defect. A per-directory
 * gate would need thirty numbers, twenty-five of which nobody would ever revisit.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        // The app, not the tests and not the config. Matches what `apps/api` and
        // `packages/nn-core` measure.
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          /**
           * **jsdom cannot run a real `Worker`.**
           *
           * This file is 201 lines of `postMessage` plumbing: it receives a `start`
           * message, calls into `harnessCore`, and posts the steps back. There is no
           * `Worker` constructor in jsdom and no `self.onmessage` to drive, so the only
           * way to "cover" it would be to import it into the main thread and hand-fake
           * the worker globals — which would execute the lines while testing nothing
           * that could ever break in a browser.
           *
           * The 450-line core it delegates to **is** tested directly, and well:
           * `harnessCore.ts` 97.36 % statements (185/190) and `scriptedRunner.ts` 100 %
           * (45/45) — 230 of 235 statements between them — via
           * `test/harnessCore.test.ts` (25 tests). The message *protocol* between the two
           * is pinned separately by `test/harnessWorkerProtocol.test.ts` (11 tests)
           * against the Zod schemas in `protocol.ts`, and `test/harnessExercise.test.tsx`
           * drives the whole page through an injected `WorkerFactory`. So what is
           * excluded here is the thin seam between three things that are all covered.
           *
           * Excluding it by name is the honest option. Left in, an unavoidable 0 % over
           * 88 statements pulls the global figure down by ~1.05 points, and the only way
           * to keep the gate passing would be to set every threshold a point lower — one
           * untestable file quietly buying slack for every testable one.
           *
           * If this file ever grows logic of its own, the fix is to move that logic into
           * `harnessCore.ts` where it can be tested, not to delete this line.
           */
          'src/workers/harnessRunner.worker.ts',
        ],
        // Count files no test imports at all. Without this, deleting the last test for a
        // module *raises* the percentage — the one way a coverage gate can reward the
        // wrong thing.
        all: true,
        // `coverage/`, not a separate `coverage-gate/`: unlike `apps/api`, this workspace
        // has exactly one coverage run, and CI's unit job uploads `apps/*/coverage`.
        reporter: ['text', 'html', 'lcov'],
        thresholds: {
          statements: 85,
          lines: 85,
          branches: 84,
          functions: 81,
        },
      },
    },
  }),
);
