/**
 * The app's two colour scales, and nothing else is allowed to be colourful.
 *
 * - **Diverging** for anything signed — weights, gradients, tanh activations. Blue for
 *   negative, red for positive, and a near-neutral in the middle so a weight of zero looks
 *   like an absence rather than a value.
 * - **Sequential** for anything in [0, 1] — sigmoid activations, probabilities. One hue
 *   (amber), monotonic in lightness, so it survives greyscale and colour-blind viewers: the
 *   *darker* end is always the larger number.
 *
 * The hex values mirror the data tokens in `index.css`. They are duplicated here rather than
 * read from `getComputedStyle` because Canvas needs raw RGB per pixel and a `var()` lookup per
 * pixel would cost more than the whole heatmap.
 */

export type Rgb = readonly [number, number, number];

const NEGATIVE: Rgb = [45, 95, 224]; // #2d5fe0
const POSITIVE: Rgb = [216, 68, 60]; // #d8443c
const NEUTRAL: Rgb = [238, 241, 246]; // #eef1f6
const SEQ_LOW: Rgb = [253, 243, 226]; // #fdf3e2
const SEQ_HIGH: Rgb = [122, 74, 8]; // #7a4a08

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(from[0], to[0], t)),
    Math.round(lerp(from[1], to[1], t)),
    Math.round(lerp(from[2], to[2], t)),
  ];
}

export function rgbToCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * Signed value -> colour. `magnitude` is the value that saturates the scale; pass the largest
 * absolute weight in the network so the picture rescales as training changes the range,
 * instead of going uniformly red the first time a weight passes 1.
 */
export function divergingRgb(value: number, magnitude = 1, neutral: Rgb = NEUTRAL): Rgb {
  if (!Number.isFinite(value) || magnitude <= 0) return neutral;
  const t = clamp(Math.abs(value) / magnitude, 0, 1);
  return mix(neutral, value < 0 ? NEGATIVE : POSITIVE, t);
}

export function divergingColor(value: number, magnitude = 1, neutral?: Rgb): string {
  return rgbToCss(divergingRgb(value, magnitude, neutral));
}

/** Unsigned value in [min, max] -> colour on the amber ramp. */
export function sequentialRgb(value: number, min = 0, max = 1): Rgb {
  if (!Number.isFinite(value) || max <= min) return SEQ_LOW;
  return mix(SEQ_LOW, SEQ_HIGH, clamp((value - min) / (max - min), 0, 1));
}

export function sequentialColor(value: number, min = 0, max = 1): string {
  return rgbToCss(sequentialRgb(value, min, max));
}

/**
 * The scale to use for an activation, given what produced it. `tanh` and `relu`-with-negative
 * inputs are signed and belong on the diverging scale; a sigmoid never is.
 */
export function activationRgb(value: number, signed: boolean): Rgb {
  return signed ? divergingRgb(value, 1) : sequentialRgb(value, 0, 1);
}

/** The two class colours, used for dataset points everywhere in modules 1 and 2. */
export const CLASS_COLORS = {
  0: rgbToCss(NEGATIVE),
  1: rgbToCss(POSITIVE),
} as const;

export const CLASS_RGB = { 0: NEGATIVE, 1: POSITIVE } as const;
