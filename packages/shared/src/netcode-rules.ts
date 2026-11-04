import { FRAME_MS, HASH_INTERVAL_FRAMES } from './constants.ts';

export const MIN_INPUT_DELAY = 3;
export const MAX_INPUT_DELAY = 6;
export const LOW_PING_MS = 80;

/**
 * Rollback netcode (MP-6): 2 frames of input delay, and up to 8 frames played on a guess of the
 * opponent's input and corrected once the real input arrives.
 */
export const ROLLBACK_INPUT_DELAY = 2;
export const MAX_ROLLBACK_FRAMES = 8;

/**
 * Frames of input delay for a match, set once at start by the relay.
 *
 * `pingMs` is the round trip between the two phones through the relay, which is the sum of
 * each phone's round trip to the relay. Under 80 ms the delay is 3 frames (50 ms). Above that
 * it covers the one-way trip plus one frame for jitter, up to 6 frames.
 */
export function inputDelayForPing(pingMs: number): number {
  if (!(pingMs >= 0)) return MAX_INPUT_DELAY;
  if (pingMs < LOW_PING_MS) return MIN_INPUT_DELAY;
  const frames = Math.ceil(pingMs / 2 / FRAME_MS) + 1;
  return Math.min(MAX_INPUT_DELAY, Math.max(MIN_INPUT_DELAY, frames));
}

/**
 * Frames of input delay for a rollback match, set once at start by the relay. It stays at 2
 * while the opponent's inputs arrive within 8 frames: the one-way trip plus 2 frames for jitter
 * and for the phones starting a little apart. That holds up to about 260 ms between the phones.
 * Past that the delay grows, up to 6 frames, so a phone never has to correct more than 8 frames.
 */
export function rollbackInputDelayForPing(pingMs: number): number {
  if (!(pingMs >= 0)) return MAX_INPUT_DELAY;
  const late = Math.ceil(pingMs / 2 / FRAME_MS) + 2;
  return Math.min(MAX_INPUT_DELAY, Math.max(ROLLBACK_INPUT_DELAY, late - MAX_ROLLBACK_FRAMES));
}

/** Phones hash their state after simulating frames 0, 60, 120, ... and send it to the relay. */
export function isHashFrame(frame: number): boolean {
  return frame % HASH_INTERVAL_FRAMES === 0;
}
