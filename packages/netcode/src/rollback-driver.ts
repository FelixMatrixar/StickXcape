import { FRAME_MS, isHashFrame } from '@sticxcape/shared';
import { SLOWDOWN, type MatchSession } from './session.ts';

/** What the fight engine plugs into the rollback driver. */
export interface RollbackHooks<S> {
  /** The local buttons right now, as the 9-bit field. */
  sampleInput(): number;
  /**
   * Simulates one frame with both fighters' inputs, in fighter order (left, right). `replay` is
   * true when the frame is played again after a wrong guess: sounds and effects the first run
   * started have already played, but the replay can also bring new ones, such as a hit that the
   * guess missed.
   */
  simulate(inputs: [number, number], frame: number, replay: boolean): void;
  /** Saves everything that decides the rest of the fight, including any result the game keeps. */
  save(): S;
  /** Rewinds to a save from `save`. */
  load(snapshot: S): void;
  /** Unsigned 32-bit hash of the state after the frame just simulated. */
  stateHash(): number;
}

export interface RollbackStats {
  /** Frames simulated for the first time. */
  frames: number;
  /** Times the game rewound because a guess was wrong. */
  rollbacks: number;
  /** Frames played again after those rewinds. */
  replayedFrames: number;
  /** The most frames rewound at once. */
  deepest: number;
  /** Frames held back so a slower opponent could catch up. */
  slowedFrames: number;
}

/** After a long pause (a backgrounded tab), only this much time is caught up. */
const MAX_CATCH_UP_MS = 250;
const MAX_STEPS_PER_UPDATE = 4;

/**
 * Runs a rollback match at a fixed 60 Hz from requestAnimationFrame (MP-6). When the
 * opponent's input for a frame is late, the frame is played on a guess and the state before it
 * is saved. If the real input differs, the game rewinds to that save and plays the frames again,
 * all within one update, so the screen only ever shows the corrected fight. It never plays more
 * than the session's rollback window ahead of the opponent's inputs; past that it waits, like
 * input delay. State hashes go to the relay only for frames whose inputs are final.
 */
export class RollbackDriver<S> {
  /** True while the last update was waiting for the opponent's input. */
  stalled = false;
  readonly stats: RollbackStats = { frames: 0, rollbacks: 0, replayedFrames: 0, deepest: 0, slowedFrames: 0 };
  private readonly session: MatchSession;
  private readonly hooks: RollbackHooks<S>;
  /** The state before each frame played on a guess, keyed by that frame. */
  private readonly saves = new Map<number, S>();
  /** Hashes of hash frames, sent once the frame is final. */
  private readonly hashes = new Map<number, number>();
  private last: number | null = null;
  private accumulator = 0;
  private slowdownMs = 0;

  constructor(session: MatchSession, hooks: RollbackHooks<S>) {
    this.session = session;
    this.hooks = hooks;
  }

  /** Call once per animation frame with its timestamp in ms. Returns how many new frames were simulated. */
  update(nowMs: number): number {
    // The first update simulates one frame. (nowMs - (nowMs - FRAME_MS) can round to just under it.)
    let elapsed = this.last === null ? FRAME_MS : nowMs - this.last;
    this.last = nowMs;
    // While this phone runs ahead of its opponent, it runs 10% slow until it has given the difference back.
    if (this.slowdownMs <= 0) this.slowdownMs = this.session.takeSlowdown() * FRAME_MS;
    if (this.slowdownMs > 0 && elapsed > 0) {
      const held = Math.min(this.slowdownMs, elapsed * SLOWDOWN);
      elapsed -= held;
      this.slowdownMs -= held;
      this.stats.slowedFrames += held / FRAME_MS;
    }
    this.accumulator = Math.min(this.accumulator + elapsed, MAX_CATCH_UP_MS);

    const from = this.session.takeReplay();
    if (from !== null && !this.session.ended) this.replay(from);

    let steps = 0;
    while (this.accumulator >= FRAME_MS && steps < MAX_STEPS_PER_UPDATE) {
      if (this.session.needsLocalInput()) this.session.pushLocalInput(this.hooks.sampleInput());
      if (!this.session.canPredict()) {
        this.stalled = !this.session.ended;
        this.accumulator = Math.min(this.accumulator, FRAME_MS);
        break;
      }
      this.play(this.session.frame, false);
      this.session.advance();
      this.stats.frames += 1;
      this.accumulator -= FRAME_MS;
      this.stalled = false;
      steps += 1;
    }
    this.settle();
    return steps;
  }

  private play(frame: number, replay: boolean): void {
    if (frame > this.session.confirmedFrame) this.saves.set(frame, this.hooks.save());
    this.hooks.simulate(this.session.inputsAt(frame), frame, replay);
    if (isHashFrame(frame)) this.hashes.set(frame, this.hooks.stateHash());
  }

  /** Rewinds to the state before `from` and plays every frame since then again. */
  private replay(from: number): void {
    const save = this.saves.get(from);
    // Every guessed frame was saved and is kept until it is final, so this is always there. If it
    // somehow isn't, carrying on is safer than stopping: a wrong state shows up as a desync.
    if (save === undefined) return;
    const to = this.session.frame;
    this.hooks.load(save);
    this.stats.rollbacks += 1;
    this.stats.deepest = Math.max(this.stats.deepest, to - from);
    for (let frame = from; frame < to; frame++) {
      this.play(frame, true);
      this.stats.replayedFrames += 1;
    }
  }

  /** Sends the hashes of frames that are now final, and drops saves no rewind can reach. */
  private settle(): void {
    const confirmed = this.session.confirmedFrame;
    for (const [frame, hash] of this.hashes) {
      if (frame > confirmed) continue;
      this.session.submitHash(frame, hash);
      this.hashes.delete(frame);
    }
    for (const frame of this.saves.keys()) if (frame <= confirmed) this.saves.delete(frame);
    this.session.forget();
  }
}
