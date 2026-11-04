/**
 * The ink restyle for photo arenas (LS-11): a photo redrawn as a muted ink wash, so photos from
 * any phone look like one game and never compete with the fighters. The services will do this
 * with Muse Image at launch; until then the phone does it with plain pixel maths, which also
 * runs in tests.
 */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8ClampedArray;
}

export type Rgb = [number, number, number];

const PAPER: Rgb = [239, 230, 214];
const INK: Rgb = [43, 37, 34];
/** Tones from ink to paper. */
const LEVELS = 5;
/** How much of the photo's own colour survives, 0..1. */
const TINT = 0.24;

/** Redraws the photo as an ink wash: five soft tones, ink lines on its edges, and paper grain. */
export function inkWash(src: Pixels): Pixels {
  const { width: w, height: h, data } = src;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2];
  const soft = boxBlur(lum, w, h, 2);

  // Edges on the softened picture; only the strongest tenth become ink lines.
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = soft[i - w + 1] + 2 * soft[i + 1] + soft[i + w + 1] - soft[i - w - 1] - 2 * soft[i - 1] - soft[i + w - 1];
      const gy = soft[i + w - 1] + 2 * soft[i + w] + soft[i + w + 1] - soft[i - w - 1] - 2 * soft[i - w] - soft[i - w + 1];
      edge[i] = Math.hypot(gx, gy);
    }
  }
  const threshold = Math.max(24, percentile(edge, 0.9));

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const tone = Math.min(LEVELS - 1, Math.floor((soft[i] / 256) * LEVELS)) / (LEVELS - 1);
    let r = INK[0] + (PAPER[0] - INK[0]) * tone;
    let g = INK[1] + (PAPER[1] - INK[1]) * tone;
    let b = INK[2] + (PAPER[2] - INK[2]) * tone;
    // A little of the photo's own colour, washed out.
    const grey = lum[i];
    r += (grey + (data[4 * i] - grey) * 0.5 - r) * TINT;
    g += (grey + (data[4 * i + 1] - grey) * 0.5 - g) * TINT;
    b += (grey + (data[4 * i + 2] - grey) * 0.5 - b) * TINT;
    // Ink lines.
    if (edge[i] > threshold) {
      const k = Math.min(1, (edge[i] - threshold) / threshold) * 0.85;
      r += (INK[0] - r) * k;
      g += (INK[1] - g) * k;
      b += (INK[2] - b) * k;
    }
    // Paper grain, the same every time.
    const grain = (hash(i) - 0.5) * 9;
    out[4 * i] = r + grain;
    out[4 * i + 1] = g + grain;
    out[4 * i + 2] = b + grain;
    out[4 * i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** The average colour of a region (0..1 coordinates). */
export function average(src: Pixels, x0: number, y0: number, x1: number, y1: number): Rgb {
  const ax = Math.max(0, Math.floor(x0 * src.width));
  const bx = Math.min(src.width, Math.ceil(x1 * src.width));
  const ay = Math.max(0, Math.floor(y0 * src.height));
  const by = Math.min(src.height, Math.ceil(y1 * src.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((bx - ax) * (by - ay)) / 4000)));
  for (let y = ay; y < by; y += step) {
    for (let x = ax; x < bx; x += step) {
      const i = 4 * (y * src.width + x);
      r += src.data[i];
      g += src.data[i + 1];
      b += src.data[i + 2];
      count += 1;
    }
  }
  return count ? [r / count, g / count, b / count] : [128, 128, 128];
}

/** Pulls a colour toward the game's muted paper and ink, keeping a hint of its hue. */
export function muted(rgb: Rgb, dark = 0): string {
  const grey = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  const c = rgb.map((v) => {
    const washed = grey + (v - grey) * 0.4;
    return Math.round(Math.max(0, Math.min(255, washed * (1 - dark))));
  });
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function brightness(rgb: Rgb): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / span;
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += 7) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * p))] ?? 0;
}

function hash(i: number): number {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
