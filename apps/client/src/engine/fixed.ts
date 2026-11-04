/**
 * Fixed-point helpers for the fight engine, on top of the shared Q16.16 maths.
 *
 * Rules for every file in src/engine: integers and Q16.16 only, the shared sine table, and no
 * browser maths (Math.sin, Math.sqrt, Math.random, Math.atan2 ...). Math.trunc, Math.floor,
 * Math.abs, Math.min and Math.max are exact on integers and allowed. Plain + - * / on integers
 * under 2^53 is exact or IEEE-defined, so it gives the same bits on every phone.
 * A test scans this folder for forbidden calls.
 */
import { fixedCos, fixedDiv, fixedLength, fixedMul, fixedSin, ONE, toFixed } from '@sticxcape/shared';

export { fixedCos, fixedDiv, fixedLength, fixedMul, fixedSin, ONE, toFixed };

export const TURN = 65536;
export const HALF_TURN = 32768;
export const QUARTER_TURN = 16384;

/** Degrees to binary angle units; only for constant tables built at load time. */
export function deg(degrees: number): number {
  return Math.round((degrees * TURN) / 360);
}

/** Wraps a binary angle to [-32768, 32767]. */
export function wrapAngle(angle: number): number {
  return ((angle + HALF_TURN) & 0xffff) - HALF_TURN;
}

/** Shortest-arc blend from angle a to b; t is 0..ONE. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = wrapAngle(b - a);
  return wrapAngle(a + Math.floor((d * t) / ONE));
}

/** Linear blend of two Q16.16 values; t is 0..ONE. */
export function lerpFixed(a: number, b: number, t: number): number {
  return a + Math.floor(((b - a) * t) / ONE);
}

/** Integer division truncated toward zero. Exact for the small integers the engine uses. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/** Millimetres (move files) to Q16.16 metres. */
export function mmToFixed(mm: number): number {
  return Math.trunc((mm * ONE) / 1000);
}

/** Q16.16 metres to whole millimetres. */
export function fixedToMm(value: number): number {
  return Math.trunc((value * 1000) / ONE);
}

/** t in 0..ONE for step `i` of `n` (i = 0..n), as an integer ratio. */
export function ratio(i: number, n: number): number {
  return n <= 0 ? ONE : Math.trunc((i * ONE) / n);
}

/** Smoothstep easing on 0..ONE. */
export function smooth(t: number): number {
  const t2 = fixedMul(t, t);
  return fixedMul(t2, 3 * ONE - 2 * t);
}

/** sin of a binary angle scaled to an integer amplitude. */
export function wave(angle: number, amplitude: number): number {
  return Math.floor((fixedSin(angle) * amplitude) / ONE);
}
