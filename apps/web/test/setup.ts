import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it; a guard costs nothing and matches the app's own caution.
  }
});

/**
 * jsdom has no 2-D canvas implementation, and installing one (`node-canvas`) means a native
 * build in CI for the sake of pixels nobody asserts on. The visualisations are tested for the
 * things a DOM can actually answer -- did the component mount, did it call the context, how
 * many nodes did the SVG graph produce -- so a recording stub is the right depth of fake.
 *
 * The proxy answers any method the drawing code reaches for, which keeps this from becoming a
 * list that has to be extended every time a component draws something new.
 */
function createContextStub(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(1, width * height * 4)),
      width,
      height,
      colorSpace: 'srgb' as const,
    }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(Math.max(1, width * height * 4)),
      width,
      height,
      colorSpace: 'srgb' as const,
    }),
    measureText: () => ({ width: 0 }),
  };

  return new Proxy(target, {
    get(store, property) {
      if (property in store) return store[property];
      const noop = vi.fn();
      store[property] = noop;
      return noop;
    },
    set(store, property, value) {
      store[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(this: HTMLCanvasElement) {
  return createContextStub();
}) as unknown as HTMLCanvasElement['getContext'];

// Used by PerceptronCanvas' drag handling; jsdom implements neither.
HTMLElement.prototype.setPointerCapture ??= vi.fn();
HTMLElement.prototype.releasePointerCapture ??= vi.fn();
