import { useEffect, useRef } from 'react';

/**
 * Runs `callback` once per animation frame while `running` is true.
 *
 * Two details that matter:
 *
 * 1. The callback is kept in a ref and re-read every frame, so a closure over fresh state does
 *    not restart the loop. Putting it in the dependency array instead would cancel and
 *    re-request a frame on every render — the classic version of this hook that drops frames
 *    under load.
 * 2. It hands the callback the delta in milliseconds since the previous frame. Training speed
 *    should be a function of time, not of how fast the display happens to be.
 *
 * The loop cleans itself up on unmount and whenever `running` goes false, which is what stops
 * a playground from training on in the background after the learner navigates away.
 */
export function useAnimationLoop(callback: (deltaMs: number) => void, running: boolean): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let previous = performance.now();

    const tick = (now: number): void => {
      const delta = now - previous;
      previous = now;
      callbackRef.current(delta);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running]);
}
