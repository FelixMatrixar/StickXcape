import { FRAME_MS, HASH_INTERVAL_FRAMES } from './constants.ts';

export const MIN_INPUT_DELAY = 3;
export const MAX_INPUT_DELAY = 6;
export const LOW_PING_MS = 80;

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

/** Phones hash their state after simulating frames 0, 60, 120, ... and send it to the relay. */
export function isHashFrame(frame: number): boolean {
  return frame % HASH_INTERVAL_FRAMES === 0;
}
