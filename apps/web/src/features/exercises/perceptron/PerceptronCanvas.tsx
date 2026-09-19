import { decisionLine, perceptronNetInput, type Perceptron, type Point2D } from '@lab/nn-core';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

import { useCanvas, type CanvasSurface } from '../../../hooks/useCanvas';
import { CLASS_COLORS } from '../../../lib/colorScale';

/**
 * The Module 1 picture: two classes of points, the line the neuron draws, the mistakes it is
 * still making, and the weight vector that owns the line's orientation.
 *
 * Canvas rather than SVG because a learner can add a hundred points in a minute and each one
 * is a filled circle with no hover semantics of its own. The only geometry computed here is
 * for *drawing* -- the line itself comes from `decisionLine` in nn-core, so the picture cannot
 * disagree with the maths.
 */

const VIEW = 1.8; // world coordinates span [-VIEW, VIEW] on both axes

export interface PerceptronCanvasProps {
  points: Point2D[];
  perceptron: Perceptron;
  /** Index of the example the last single step looked at, ringed in ink. */
  highlighted: number | null;
  onAddPoint: (x1: number, x2: number) => void;
  onMovePoint: (index: number, x1: number, x2: number) => void;
}

interface Projection {
  toScreenX: (x: number) => number;
  toScreenY: (y: number) => number;
  toWorldX: (px: number) => number;
  toWorldY: (py: number) => number;
  scale: number;
}

function projection({ width, height }: { width: number; height: number }): Projection {
  const size = Math.min(width, height);
  const scale = size / (2 * VIEW);
  const cx = width / 2;
  const cy = height / 2;
  return {
    scale,
    toScreenX: (x) => cx + x * scale,
    toScreenY: (y) => cy - y * scale,
    toWorldX: (px) => (px - cx) / scale,
    toWorldY: (py) => (cy - py) / scale,
  };
}

/**
 * Sutherland-Hodgman against one half-plane: the viewport rectangle clipped to
 * `w . x + b >= 0`, so the side the neuron answers 1 on can be tinted. Four corners in, at
 * most five out.
 */
function positiveHalfPlane(p: Perceptron): [number, number][] {
  const corners: [number, number][] = [
    [-VIEW, -VIEW],
    [VIEW, -VIEW],
    [VIEW, VIEW],
    [-VIEW, VIEW],
  ];
  const z = (point: [number, number]): number => perceptronNetInput(p, point);
  const output: [number, number][] = [];

  for (let i = 0; i < corners.length; i += 1) {
    const current = corners[i]!;
    const previous = corners[(i + corners.length - 1) % corners.length]!;
    const zCurrent = z(current);
    const zPrevious = z(previous);
    const inCurrent = zCurrent >= 0;
    const inPrevious = zPrevious >= 0;

    if (inCurrent !== inPrevious) {
      const t = zPrevious / (zPrevious - zCurrent);
      output.push([
        previous[0] + t * (current[0] - previous[0]),
        previous[1] + t * (current[1] - previous[1]),
      ]);
    }
    if (inCurrent) output.push(current);
  }
  return output;
}

function drawScene(
  surface: CanvasSurface,
  points: Point2D[],
  perceptron: Perceptron,
  highlighted: number | null,
): void {
  const { ctx, width, height } = surface;
  const view = projection(surface);

  // Plotting paper, continuing the page's own grid into the plot.
  ctx.strokeStyle = 'rgb(148 163 184 / 0.22)';
  ctx.lineWidth = 1;
  for (let g = -VIEW; g <= VIEW + 1e-9; g += 0.4) {
    ctx.beginPath();
    ctx.moveTo(view.toScreenX(g), 0);
    ctx.lineTo(view.toScreenX(g), height);
    ctx.moveTo(0, view.toScreenY(g));
    ctx.lineTo(width, view.toScreenY(g));
    ctx.stroke();
  }

  // Axes.
  ctx.strokeStyle = 'rgb(100 116 139 / 0.5)';
  ctx.beginPath();
  ctx.moveTo(view.toScreenX(-VIEW), view.toScreenY(0));
  ctx.lineTo(view.toScreenX(VIEW), view.toScreenY(0));
  ctx.moveTo(view.toScreenX(0), view.toScreenY(-VIEW));
  ctx.lineTo(view.toScreenX(0), view.toScreenY(VIEW));
  ctx.stroke();

  // The half-plane the neuron answers 1 on.
  const polygon = positiveHalfPlane(perceptron);
  if (polygon.length > 2) {
    ctx.fillStyle = 'rgb(216 68 60 / 0.07)';
    ctx.beginPath();
    polygon.forEach(([x, y], index) => {
      const sx = view.toScreenX(x);
      const sy = view.toScreenY(y);
      if (index === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.fill();
  }

  // The decision boundary, straight from nn-core.
  const line = decisionLine(perceptron, -VIEW, VIEW);
  if (line.kind !== 'none') {
    const [[ax, ay], [bx, by]] = line.points;
    ctx.strokeStyle = 'rgb(15 23 42 / 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(view.toScreenX(ax), view.toScreenY(ay));
    ctx.lineTo(view.toScreenX(bx), view.toScreenY(by));
    ctx.stroke();
  }

  // The weight vector from the origin: always perpendicular to the line above.
  const [w1 = 0, w2 = 0] = perceptron.weights;
  const norm = Math.hypot(w1, w2);
  if (norm > 1e-9) {
    const length = Math.min(1.1, 0.35 + norm * 0.5);
    const tipX = (w1 / norm) * length;
    const tipY = (w2 / norm) * length;
    const sx = view.toScreenX(0);
    const sy = view.toScreenY(0);
    const tx = view.toScreenX(tipX);
    const ty = view.toScreenY(tipY);
    ctx.strokeStyle = 'rgb(15 23 42 / 0.75)';
    ctx.fillStyle = 'rgb(15 23 42 / 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    const angle = Math.atan2(ty - sy, tx - sx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 9 * Math.cos(angle - 0.4), ty - 9 * Math.sin(angle - 0.4));
    ctx.lineTo(tx - 9 * Math.cos(angle + 0.4), ty - 9 * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  // Points last, so nothing is drawn over them.
  points.forEach((point, index) => {
    const predicted = perceptronNetInput(perceptron, point.x) >= 0 ? 1 : 0;
    const wrong = predicted !== point.y;
    const sx = view.toScreenX(point.x[0]);
    const sy = view.toScreenY(point.x[1]);

    ctx.beginPath();
    ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = CLASS_COLORS[point.y];
    ctx.fill();

    if (wrong) {
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.strokeStyle = CLASS_COLORS[point.y];
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (index === highlighted) {
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgb(15 23 42 / 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });
}

export function PerceptronCanvas({
  points,
  perceptron,
  highlighted,
  onAddPoint,
  onMovePoint,
}: PerceptronCanvasProps) {
  const dragging = useRef<number | null>(null);
  const movedWhileDown = useRef(false);

  const { ref } = useCanvas((surface) => drawScene(surface, points, perceptron, highlighted));

  const worldAt = (event: ReactPointerEvent<HTMLCanvasElement>): [number, number] | null => {
    const canvas = ref.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const view = projection({ width: rect.width, height: rect.height });
    return [view.toWorldX(event.clientX - rect.left), view.toWorldY(event.clientY - rect.top)];
  };

  const nearestPoint = (x: number, y: number): number | null => {
    let best: number | null = null;
    let bestDistance = 0.12; // world units, roughly the radius of a dot plus a fat finger
    points.forEach((point, index) => {
      const distance = Math.hypot(point.x[0] - x, point.x[1] - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  };

  return (
    <canvas
      ref={ref}
      data-testid="perceptron-canvas"
      className="bg-surface border-rule aspect-square w-full touch-none rounded-lg border"
      role="img"
      aria-label="Decision boundary and labelled points"
      onPointerDown={(event) => {
        const world = worldAt(event);
        if (!world) return;
        movedWhileDown.current = false;
        dragging.current = nearestPoint(world[0], world[1]);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current === null) return;
        const world = worldAt(event);
        if (!world) return;
        movedWhileDown.current = true;
        onMovePoint(dragging.current, world[0], world[1]);
      }}
      onPointerUp={(event) => {
        const world = worldAt(event);
        // A press that grabbed nothing and moved nowhere is a click: add a point there.
        if (world && dragging.current === null && !movedWhileDown.current) {
          onAddPoint(world[0], world[1]);
        }
        dragging.current = null;
        movedWhileDown.current = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
    />
  );
}
