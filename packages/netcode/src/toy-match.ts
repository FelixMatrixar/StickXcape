import { Button, encodeFrames, FRAME_VALUES, MOVE_FORMAT_VERSION, Rng, toFixed, type MoveFile } from '@sticxcape/shared';
import { LockstepDriver } from './driver.ts';
import type { LockstepSession } from './lockstep.ts';
import { ToySim } from './toy-sim.ts';

const TOY_JAB_FRAMES = 12;

function toyJabFrames(): string {
  const values = new Int16Array(TOY_JAB_FRAMES * FRAME_VALUES);
  for (let f = 0; f < TOY_JAB_FRAMES; f++) {
    const at = f * FRAME_VALUES;
    const reach = Math.min(f, TOY_JAB_FRAMES - 1 - f) * 2400;
    values[at + 1] = 950; // pelvis height in millimetres
    values[at + 2 + 6] = -4096 + reach; // right shoulder swings forward
    values[at + 2 + 7] = 12288 - reach; // right elbow straightens
    values[at + 2 + 3] = -2048; // left shoulder in guard
    values[at + 2 + 4] = 14336;
  }
  return encodeFrames(values);
}

/**
 * A one-move loadout for toy matches, since the relay wants a loadout before anyone gets ready.
 * The hash is precomputed (a test checks it) so the lab also runs over plain http, where
 * browsers hide crypto.subtle.
 */
export function toyLoadout(): MoveFile[] {
  return [
    {
      id: '7a1c0de0-0000-4000-8000-000000000001',
      version: MOVE_FORMAT_VERSION,
      slot: 'light',
      name: 'Toy Jab',
      frames: toyJabFrames(),
      active: [4, 7],
      limb: 'rightWrist',
      height: 'mid',
      hash: TOY_JAB_HASH,
    },
  ];
}

const TOY_JAB_HASH = 'b81e61497628173f9c61583d33fd99b22f7d77ee47d6c1a9aad8fc2522efd279';

const BOT_REACH = toFixed(0.8);

/** A simple opponent for toy matches: walks into reach, jabs, and now and then jumps. */
export function toyBotInput(seed: number): (sim: ToySim, side: 0 | 1) => number {
  const rng = new Rng(seed);
  return (sim, side) => {
    const gap = sim.x[side === 0 ? 1 : 0] - sim.x[side];
    let buttons = 0;
    if (Math.abs(gap) > BOT_REACH) buttons |= gap > 0 ? Button.Right : Button.Left;
    else if (rng.nextInt(4) === 0) buttons |= Button.Light;
    if (rng.nextInt(90) === 0) buttons |= Button.Up;
    return buttons;
  };
}

export interface ToyMatchOptions {
  /** The local buttons for each frame; defaults to toyBotInput. */
  input?: (sim: ToySim, side: 0 | 1) => number;
  /** Frames before the match goes to whoever has more health. Default 3600 (60 s). */
  maxFrames?: number;
  /** Overrides the state hash, so tests can force a desync. */
  stateHash?: (sim: ToySim) => number;
}

/**
 * One phone's side of a toy match: a ToySim run by a LockstepDriver, which reports the winner
 * once a fighter is out of health or time runs out. The lab, the bot script and the tests use it.
 */
export class ToyMatch {
  readonly session: LockstepSession;
  readonly sim: ToySim;
  /** The winner this phone worked out (null for a draw), or undefined while the fight goes on. */
  result: number | null | undefined = undefined;
  private readonly driver: LockstepDriver;
  private readonly maxFrames: number;
  private reported = false;

  constructor(session: LockstepSession, options: ToyMatchOptions = {}) {
    this.session = session;
    this.sim = new ToySim(session.seed);
    this.maxFrames = options.maxFrames ?? 3600;
    const input = options.input ?? toyBotInput(session.seed ^ session.localPlayer);
    const stateHash = options.stateHash ?? ((sim: ToySim) => sim.hash());
    this.driver = new LockstepDriver(session, {
      sampleInput: () => input(this.sim, session.localSide),
      simulate: (inputs) => this.simulate(inputs),
      stateHash: () => stateHash(this.sim),
    });
  }

  /** True while the last update was waiting for the opponent's input. */
  get stalled(): boolean {
    return this.driver.stalled;
  }

  /** Call once per animation frame (or timer tick) with a timestamp in ms. Returns frames simulated. */
  update(nowMs: number): number {
    const steps = this.driver.update(nowMs);
    if (this.result !== undefined && !this.reported) {
      this.reported = true;
      this.session.finish(this.result);
    }
    return steps;
  }

  /**
   * The fight freezes on the frame it is decided, so both phones work out the result on the same
   * frame however their updates batch the steps, and their hashes keep matching until the relay ends it.
   */
  private simulate(inputs: [number, number]): void {
    if (this.result !== undefined) return;
    this.sim.step(inputs);
    if (this.sim.over || this.sim.frame >= this.maxFrames) {
      const leader = this.sim.leader();
      this.result = leader === null ? null : this.session.fighters[leader];
    }
  }
}
