import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAnimationLoop } from '../src/hooks/useAnimationLoop';
import { useCanvas, type CanvasSurface } from '../src/hooks/useCanvas';

/**
 * The two hooks every visualisation in modules 1–3 is built on.
 *
 * They were the thinnest directory in the coverage report (80.7 % statements, 56.25 %
 * branches) for an understandable reason: they are only ever reached *through* a
 * playground, and a test that mounts `MlpExercise` to find out whether `useCanvas`
 * handles a device pixel ratio of 2 is testing the wrong component. Both hooks document
 * a specific decision — re-read the callback from a ref rather than restarting the loop;
 * size the bitmap to `css * dpr` and let the draw callback stay in CSS pixels — and
 * neither decision was checked anywhere. So they are tested here, directly, on the
 * behaviour their own comments claim.
 */

// ------------------------------------------------------------ useAnimationLoop ----

/**
 * A controllable `requestAnimationFrame`. jsdom's own is a `setTimeout` wrapper, which
 * would make every assertion below a race against a 16 ms timer.
 */
function installFrames() {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];

  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, fn);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    cancelled.push(handle);
    pending.delete(handle);
  });

  return {
    cancelled,
    pendingCount: () => pending.size,
    /** Fire every queued frame at `now`, the way the browser would. */
    fire(now: number): void {
      const queued = [...pending.entries()];
      pending.clear();
      act(() => {
        for (const [, fn] of queued) fn(now);
      });
    },
  };
}

function LoopHarness({ running, onTick }: { running: boolean; onTick: (ms: number) => void }) {
  const [renders, setRenders] = useState(0);
  useAnimationLoop((deltaMs) => onTick(deltaMs), running);
  return (
    <button type="button" onClick={() => setRenders(renders + 1)}>
      rerender {renders}
    </button>
  );
}

describe('useAnimationLoop', () => {
  let frames: ReturnType<typeof installFrames>;

  beforeEach(() => {
    frames = installFrames();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hands the callback the milliseconds since the previous frame, not since the start', () => {
    const ticks: number[] = [];
    render(<LoopHarness running onTick={(ms) => ticks.push(ms)} />);

    // `performance.now()` was 1000 when the effect ran, so the first frame at 1016 is a
    // 16 ms delta and the second at 1048 is 32 — *not* 48. Training speed is a function
    // of elapsed time, and getting this wrong makes a slow machine train faster per frame.
    frames.fire(1016);
    frames.fire(1048);

    expect(ticks).toEqual([16, 32]);
  });

  it('does not restart the loop when the callback identity changes', () => {
    const ticks: string[] = [];
    let label = 'first';
    const { getByRole } = render(<LoopHarness running onTick={() => ticks.push(label)} />);

    frames.fire(1016);
    label = 'second';
    // A re-render with a brand-new inline callback. The hook keeps it in a ref, so the
    // next frame must run the *new* closure without the effect having torn anything down
    // — the documented reason this hook exists instead of a `useEffect` with `callback`
    // in its dependency array.
    act(() => {
      getByRole('button').click();
    });
    frames.fire(1032);

    expect(ticks).toEqual(['first', 'second']);
    expect(frames.cancelled).toHaveLength(0);
  });

  it('stops requesting frames when running goes false, and on unmount', () => {
    const { rerender, unmount } = render(<LoopHarness running onTick={() => {}} />);
    frames.fire(1016);
    expect(frames.pendingCount()).toBe(1);

    rerender(<LoopHarness running={false} onTick={() => {}} />);
    // The cleanup cancelled the outstanding frame and the effect did not re-arm: this is
    // what stops a playground training on after the learner navigates away.
    expect(frames.cancelled).toHaveLength(1);
    expect(frames.pendingCount()).toBe(0);

    rerender(<LoopHarness running onTick={() => {}} />);
    expect(frames.pendingCount()).toBe(1);
    unmount();
    expect(frames.pendingCount()).toBe(0);
  });
});

// -------------------------------------------------------------------- useCanvas ----

function CanvasHarness({
  onDraw,
  cssWidth = 300,
  cssHeight = 150,
}: {
  onDraw: (surface: CanvasSurface) => void;
  cssWidth?: number;
  cssHeight?: number;
}) {
  const canvas = useCanvas(onDraw);
  return <canvas ref={canvas.ref} width={cssWidth} height={cssHeight} />;
}

describe('useCanvas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sizes the bitmap to css × dpr and leaves the draw callback in css pixels', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const surfaces: CanvasSurface[] = [];
    const { container } = render(
      <CanvasHarness cssWidth={300} cssHeight={150} onDraw={(s) => surfaces.push(s)} />,
    );

    const element = container.querySelector('canvas');
    // The bitmap is doubled...
    expect(element?.width).toBe(600);
    expect(element?.height).toBe(300);
    // ...and the draw callback is told the CSS size, so nothing it draws has to know.
    const surface = surfaces.at(-1);
    expect(surface?.width).toBe(300);
    expect(surface?.height).toBe(150);
    expect(surface?.dpr).toBe(2);
    // The transform is what makes those two statements consistent.
    expect(surface?.ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('falls back to a dpr of 1 when the environment reports a useless one', () => {
    // Some headless environments report 0. Multiplying a bitmap by 0 produces a canvas
    // that silently draws nothing, which is a much worse bug than a soft one.
    vi.stubGlobal('devicePixelRatio', 0);
    const surfaces: CanvasSurface[] = [];
    render(<CanvasHarness cssWidth={120} cssHeight={80} onDraw={(s) => surfaces.push(s)} />);

    expect(surfaces.at(-1)?.dpr).toBe(1);
    expect(surfaces.at(-1)?.width).toBe(120);
  });

  it('repaints when a ResizeObserver reports a new size', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    let trigger: (() => void) | null = null;
    class StubResizeObserver {
      constructor(callback: () => void) {
        trigger = callback;
      }
      observe(): void {}
      disconnect(): void {
        trigger = null;
      }
    }
    vi.stubGlobal('ResizeObserver', StubResizeObserver);

    let draws = 0;
    const { unmount } = render(<CanvasHarness onDraw={() => (draws += 1)} />);
    const afterMount = draws;
    expect(trigger).not.toBeNull();

    // jsdom has no ResizeObserver, so in every other test in this suite the hook takes
    // its `typeof ResizeObserver === 'undefined'` early return and this whole branch is
    // dead. Give it one and the resize path is real behaviour again.
    act(() => trigger?.());
    expect(draws).toBeGreaterThan(afterMount);

    unmount();
    expect(trigger).toBeNull();
  });
});
