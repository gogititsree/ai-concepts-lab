import { useCallback, useEffect, useRef, type RefObject } from 'react';

export interface CanvasSurface {
  ctx: CanvasRenderingContext2D;
  /** Size in **CSS pixels** -- the space the draw callback works in. */
  width: number;
  height: number;
  dpr: number;
}

export interface CanvasHandle {
  ref: RefObject<HTMLCanvasElement | null>;
  /** Force a repaint outside React's render cycle (the animation loop calls this). */
  redraw: () => void;
}

/**
 * DPR-correct Canvas sizing.
 *
 * A canvas has two sizes: the CSS box it occupies and the bitmap it owns. Set only the first
 * and the browser upscales a low-resolution bitmap -- the reason hand-rolled canvases look
 * soft on a laptop and terrible on a phone. This hook sets the bitmap to
 * `cssSize * devicePixelRatio`, then applies a matching `setTransform` so the draw callback
 * can keep working in CSS pixels and never think about it again.
 *
 * It re-measures on resize (`ResizeObserver`, when the environment has one -- jsdom does not)
 * and repaints after every render, which for these playgrounds is exactly when state changed.
 */
export function useCanvas(draw: (surface: CanvasSurface) => void): CanvasHandle {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const redraw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // jsdom reports 0x0; fall back to the attribute size so tests still exercise the paint.
    const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || canvas.width || 1));
    const height = Math.max(
      1,
      Math.round(rect.height || canvas.clientHeight || canvas.height || 1),
    );
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;

    const bitmapWidth = Math.round(width * dpr);
    const bitmapHeight = Math.round(height * dpr);
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawRef.current({ ctx, width, height, dpr });
  }, []);

  useEffect(() => {
    redraw();
  });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  return { ref, redraw };
}
