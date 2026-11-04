import { Button, hashInts, Rng, toFixed } from '@sticxcape/shared';

const WALK = toFixed(0.05);
const JUMP = toFixed(0.18);
const GRAVITY = toFixed(0.01);
const ARENA_WIDTH = toFixed(8);
const REACH = toFixed(1);
const JAB_COOLDOWN = 20;
const START_HEALTH = 100;

/**
 * A tiny deterministic fight for exercising the netcode without the real engine: two fighters
 * that walk, jump and jab. Integer and fixed-point maths only, the same rule the fight engine
 * follows, so two phones given the same inputs always agree. Used by tests, the lab and e2e bots.
 */
export class ToySim {
  frame = 0;
  readonly x: [number, number] = [toFixed(2), toFixed(6)];
  readonly y: [number, number] = [0, 0];
  readonly vy: [number, number] = [0, 0];
  readonly health: [number, number] = [START_HEALTH, START_HEALTH];
  readonly cooldown: [number, number] = [0, 0];
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  /** One frame; inputs are in fighter order (left, right). */
  step(inputs: [number, number]): void {
    for (const side of [0, 1] as const) {
      const buttons = inputs[side];
      const other = side === 0 ? 1 : 0;
      if ((buttons & Button.Left) !== 0) this.x[side] = Math.max(0, this.x[side] - WALK);
      if ((buttons & Button.Right) !== 0) this.x[side] = Math.min(ARENA_WIDTH, this.x[side] + WALK);
      if ((buttons & Button.Up) !== 0 && this.y[side] === 0) this.vy[side] = JUMP;
      if (this.cooldown[side] > 0) {
        this.cooldown[side] -= 1;
      } else if ((buttons & Button.Light) !== 0 && Math.abs(this.x[side] - this.x[other]) < REACH && this.health[other] > 0) {
        this.health[other] = Math.max(0, this.health[other] - (5 + this.rng.nextInt(3)));
        this.cooldown[side] = JAB_COOLDOWN;
      }
    }
    for (const side of [0, 1] as const) {
      this.y[side] = Math.max(0, this.y[side] + this.vy[side]);
      this.vy[side] = this.y[side] === 0 ? 0 : this.vy[side] - GRAVITY;
    }
    this.frame += 1;
  }

  /** True once a fighter is out of health. */
  get over(): boolean {
    return this.health[0] === 0 || this.health[1] === 0;
  }

  /** The side with more health, or null when level. */
  leader(): 0 | 1 | null {
    if (this.health[0] === this.health[1]) return null;
    return this.health[0] > this.health[1] ? 0 : 1;
  }

  hash(): number {
    return hashInts([this.frame, ...this.x, ...this.y, ...this.vy, ...this.health, ...this.cooldown, this.rng.state]);
  }

  /** Everything that decides the rest of the fight, for rollback netcode. */
  save(): ToySnapshot {
    return {
      frame: this.frame,
      x: [...this.x],
      y: [...this.y],
      vy: [...this.vy],
      health: [...this.health],
      cooldown: [...this.cooldown],
      rng: this.rng.state,
    };
  }

  load(snapshot: ToySnapshot): void {
    this.frame = snapshot.frame;
    for (const side of [0, 1] as const) {
      this.x[side] = snapshot.x[side];
      this.y[side] = snapshot.y[side];
      this.vy[side] = snapshot.vy[side];
      this.health[side] = snapshot.health[side];
      this.cooldown[side] = snapshot.cooldown[side];
    }
    this.rng.state = snapshot.rng;
  }
}

/** A saved moment of a ToySim. */
export interface ToySnapshot {
  readonly frame: number;
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly vy: readonly [number, number];
  readonly health: readonly [number, number];
  readonly cooldown: readonly [number, number];
  readonly rng: number;
}
