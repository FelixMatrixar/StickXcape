/**
 * Seeded random numbers for the simulation (mulberry32), started from the seed in the `start`
 * message. Integer-only, so both phones draw the same sequence. `state` can be saved and
 * restored, which rollback netcode needs at launch.
 */
export class Rng {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** The next unsigned 32-bit integer. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** An integer in [0, max), exact for max up to 2^21. */
  nextInt(max: number): number {
    return Math.floor((this.next() * max) / 0x100000000);
  }
}

/**
 * FNV-1a over 32-bit integers (4 bytes each, little-endian), as an unsigned 32-bit number.
 * Phones use it for the state hash they send every 60 frames.
 */
export function hashInts(values: ArrayLike<number>, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]! | 0;
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
  }
  return h >>> 0;
}
