import { mlpPredict, type Mlp, type Point2D } from '@lab/nn-core';
import { useRef } from 'react';

import { useCanvas, type CanvasSurface } from '../../../hooks/useCanvas';
import { CLASS_COLORS, sequentialRgb } from '../../../lib/colorScale';

/**
 * The decision surface: what the network answers at every point of the plane, with the
 * training data on top.
 *
 * The grid is evaluated at 80x80 (6400 forward passes, a few milliseconds for a 2-8-1 net),
 * written into an `ImageData` at that resolution, and blown up onto the display canvas by
 * `drawImage`. Evaluating one forward pass per *display* pixel would be ~300k passes a frame
 * and would make auto-training unwatchable; the browser's own bilinear scaling gives the soft
 * gradient for free, and softness is honest here — the surface really is smooth.
 */

const GRID = 80;
const VIEW = 1.8;

export interface BoundaryHeatmapProps {
  mlp: Mlp;
  points: Point2D[];
}

function paint(
  surface: CanvasSurface,
  offscreen: HTMLCanvasElement,
  mlp: Mlp,
  points: Point2D[],
): void {
  const { ctx, width, height } = surface;
  const size = Math.min(width, height);
  const originX = (width - size) / 2;
  const originY = (height - size) / 2;

  const offCtx = offscreen.getContext('2d');
  if (offCtx) {
    offscreen.width = GRID;
    offscreen.height = GRID;
    const image = offCtx.createImageData(GRID, GRID);
    for (let row = 0; row < GRID; row += 1) {
      // Row 0 is the top of the bitmap, which is +VIEW in world coordinates.
      const x2 = VIEW - (2 * VIEW * row) / (GRID - 1);
      for (let col = 0; col < GRID; col += 1) {
        const x1 = -VIEW + (2 * VIEW * col) / (GRID - 1);
        const output = mlpPredict(mlp, [x1, x2])[0] ?? 0;
        const [r, g, b] = sequentialRgb(output, 0, 1);
        const offset = (row * GRID + col) * 4;
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = 235;
      }
    }
    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreen, originX, originY, size, size);
  }

  // Dataset on top, in the class colours used everywhere else in the course.
  const toScreenX = (x: number): number => originX + ((x + VIEW) / (2 * VIEW)) * size;
  const toScreenY = (y: number): number => originY + ((VIEW - y) / (2 * VIEW)) * size;

  for (const point of points) {
    ctx.beginPath();
    ctx.arc(toScreenX(point.x[0]), toScreenY(point.x[1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = CLASS_COLORS[point.y];
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgb(255 255 255 / 0.85)';
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgb(100 116 139 / 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(originX + 0.5, originY + 0.5, size - 1, size - 1);
}

export function BoundaryHeatmap({ mlp, points }: BoundaryHeatmapProps) {
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  offscreen.current ??= document.createElement('canvas');

  const { ref } = useCanvas((surface) => {
    if (offscreen.current) paint(surface, offscreen.current, mlp, points);
  });

  return (
    <canvas
      ref={ref}
      data-testid="boundary-heatmap"
      className="bg-surface border-rule aspect-square w-full rounded-lg border"
      role="img"
      aria-label="Decision surface of the network with the dataset overlaid"
    />
  );
}
