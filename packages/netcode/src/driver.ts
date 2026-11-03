import { FRAME_MS, isHashFrame } from '@sticxcape/shared';
import type { LockstepSession } from './lockstep.ts';

/** What the fight engine plugs into the driver. */
export interface DriverHooks {
  /** The local buttons right now, as the 9-bit field. */
  sampleInput(): number;
  /** Simulates one frame with both fighters' inputs, in fighter order (left, right). */
  simulate(inputs: [number, number], frame: number): void;
  /** Unsigned 32-bit hash of the state after the frame just simulated. */
  stateHash(): number;
}

/** After a long pause (a backgrounded tab), only this much time is caught up. */
const MAX_CATCH_UP_MS = 250;
const MAX_STEPS_PER_UPDATE = 4;

/**
 * Runs a LockstepSession at a fixed 60 Hz from requestAnimationFrame. It catches up after a
 * slow frame, but never banks time while waiting for the opponent, so it never bursts a
 * backlog of inputs at the relay.
 */
export class LockstepDriver {
  /** True while the last update was waiting for the opponent's input. */
  stalled = false;
  private readonly session: LockstepSession;
  private readonly hooks: DriverHooks;
  private last: number | null = null;
  private accumulator = 0;

  constructor(session: LockstepSession, hooks: DriverHooks) {
    this.session = session;
    this.hooks = hooks;
  }

  /** Call once per animation frame with its timestamp in ms. Returns how many frames were simulated. */
  update(nowMs: number): number {
    if (this.last === null) this.last = nowMs - FRAME_MS;
    this.accumulator = Math.min(this.accumulator + (nowMs - this.last), MAX_CATCH_UP_MS);
    this.last = nowMs;

    let steps = 0;
    while (this.accumulator >= FRAME_MS && steps < MAX_STEPS_PER_UPDATE) {
      if (this.session.needsLocalInput()) this.session.pushLocalInput(this.hooks.sampleInput());
      if (!this.session.canStep()) {
        this.stalled = !this.session.ended;
        this.accumulator = Math.min(this.accumulator, FRAME_MS);
        break;
      }
      const frame = this.session.frame;
      this.hooks.simulate(this.session.step(), frame);
      if (isHashFrame(frame)) this.session.submitHash(frame, this.hooks.stateHash());
      this.accumulator -= FRAME_MS;
      this.stalled = false;
      steps += 1;
    }
    return steps;
  }
}
