import {
  cleanButtons,
  isHashFrame,
  type ClientMessage,
  type EndReason,
  type MatchEndMessage,
  type ServerMessage,
  type StartMessage,
} from '@sticxcape/shared';

export interface MatchSessionOptions {
  /** This phone's player number. */
  localPlayer: number;
  start: StartMessage;
  send: (message: ClientMessage) => void;
  now?: () => number;
}

type Listener<T> = (value: T) => void;

/** Rollback matches send a sync message once a second, half a second after each hash. */
const SYNC_INTERVAL_FRAMES = 60;
const SYNC_OFFSET_FRAMES = 30;
/** Lateness is averaged over the opponent's latest 30 inputs: half a second. */
const LATENESS_SAMPLES = 30;
/** A phone at least this many frames ahead of its opponent slows down. */
const MIN_AHEAD_FRAMES = 1;
/** While slowing down, a phone runs this much slower: 10%, too little to see. */
export const SLOWDOWN = 0.1;
/** After slowing down, sync reports are ignored this long, so both phones measure afresh. */
const SETTLE_FRAMES = 90;

/**
 * One match's netcode on one phone: both fighters' inputs, the state hashes and the result.
 * Each frame the local buttons are sent for `frame + inputDelay`.
 *
 * In an input-delay match (`rollback` 0, the MVP) LockstepDriver runs it: a frame is simulated
 * only once both fighters' inputs for it are here. In a rollback match RollbackDriver runs it:
 * a frame whose opponent input hasn't arrived is played on a guess (they're still holding their
 * last buttons), up to `rollback` frames ahead, and played again when the real input differs.
 * Either way, every 60 frames both phones send a state hash; a mismatch is a desync.
 */
export class MatchSession {
  readonly localPlayer: number;
  readonly fighters: [number, number];
  /** 0 when this phone is the left fighter, 1 when the right. */
  readonly localSide: 0 | 1;
  readonly inputDelay: number;
  /** Frames this phone may play ahead of the opponent's inputs; 0 in an input-delay match. */
  readonly rollback: number;
  readonly startFrame: number;
  readonly seed: number;
  readonly arenaId: string | null;
  /** The next frame to simulate. */
  frame: number;
  ended = false;
  endReason: EndReason | null = null;
  winner: number | null = null;
  /** The first frame whose state hashes differed, if any. */
  desyncFrame: number | null = null;

  private readonly send: (message: ClientMessage) => void;
  private readonly now: () => number;
  private readonly local = new Map<number, number>();
  private readonly remote = new Map<number, number>();
  private nextLocal: number;
  private nextRemote: number;
  private readonly localHashes = new Map<number, number>();
  private readonly remoteHashes = new Map<number, number>();
  private lastStepAt: number;
  private readonly desyncListeners: Listener<number>[] = [];
  private readonly endListeners: Listener<MatchEndMessage>[] = [];

  // Rollback only.
  /** The opponent's buttons guessed for each frame played before their input arrived. */
  private readonly guesses = new Map<number, number>();
  private lastRemote = 0;
  /** The earliest frame whose guess was wrong, until the driver replays from it. */
  private replayFrom: number | null = null;
  /** How many frames late each of the opponent's latest inputs arrived. */
  private readonly lateness: number[] = [];
  /** Frames this phone should give back so its opponent catches up. */
  private slowdown = 0;
  private settleUntil = 0;

  constructor({ localPlayer, start, send, now = () => performance.now() }: MatchSessionOptions) {
    const side = start.fighters.indexOf(localPlayer);
    if (side !== 0 && side !== 1) throw new Error(`Player ${localPlayer} is not fighting in this match`);
    this.localPlayer = localPlayer;
    this.fighters = [start.fighters[0], start.fighters[1]];
    this.localSide = side;
    this.inputDelay = start.inputDelay;
    this.rollback = start.rollback ?? 0;
    this.startFrame = start.startFrame;
    this.seed = start.seed;
    this.arenaId = start.arenaId;
    this.frame = start.startFrame;
    this.nextLocal = this.nextRemote = start.startFrame + start.inputDelay;
    this.send = send;
    this.now = now;
    this.lastStepAt = now();
  }

  /** The opponent's player number. */
  get opponent(): number {
    return this.fighters[this.localSide === 0 ? 1 : 0];
  }

  /** The last frame both fighters' inputs are known for. Everything up to it is final. */
  get confirmedFrame(): number {
    return Math.min(this.nextLocal, this.nextRemote) - 1;
  }

  /** True when the game should sample the local buttons and call pushLocalInput. */
  needsLocalInput(): boolean {
    return !this.ended && this.nextLocal <= this.frame + this.inputDelay;
  }

  /** Schedules the local buttons for `frame + inputDelay` and sends them to the relay. */
  pushLocalInput(buttons: number): void {
    if (!this.needsLocalInput()) return;
    const frame = this.nextLocal++;
    const clean = cleanButtons(buttons);
    this.local.set(frame, clean);
    this.send({ type: 'input', frame, buttons: clean });
  }

  /** Input delay: true when both fighters' inputs for `frame` are here. */
  canStep(): boolean {
    return !this.ended && this.has(this.local, this.frame) && this.has(this.remote, this.frame);
  }

  /** Input delay: inputs for `frame` in fighter order (left, right), then moves to the next frame. */
  step(): [number, number] {
    if (!this.canStep()) throw new Error(`Inputs for frame ${this.frame} have not arrived`);
    const mine = this.take(this.local, this.frame);
    const theirs = this.take(this.remote, this.frame);
    this.frame += 1;
    this.lastStepAt = this.now();
    return this.localSide === 0 ? [mine, theirs] : [theirs, mine];
  }

  /** Rollback: true when `frame` may be played, on a guess if need be, without going past the rollback window. */
  canPredict(): boolean {
    return !this.ended && this.has(this.local, this.frame) && this.frame < this.nextRemote + this.rollback;
  }

  /**
   * Rollback: both fighters' inputs for `frame`, in fighter order. When the opponent's input
   * hasn't arrived, it guesses they're still holding their last buttons, and remembers the
   * guess so that a different real input sends the game back to this frame.
   */
  inputsAt(frame: number): [number, number] {
    let mine = 0;
    let theirs = 0;
    if (frame >= this.startFrame + this.inputDelay) {
      mine = this.local.get(frame) ?? 0;
      const known = this.remote.get(frame);
      if (known !== undefined) {
        theirs = known;
      } else {
        theirs = this.lastRemote;
        this.guesses.set(frame, theirs);
      }
    }
    return this.localSide === 0 ? [mine, theirs] : [theirs, mine];
  }

  /** Rollback: call after playing `frame` for the first time. */
  advance(): void {
    this.frame += 1;
    this.lastStepAt = this.now();
    if (this.rollback > 0 && this.frame % SYNC_INTERVAL_FRAMES === SYNC_OFFSET_FRAMES && this.lateness.length > 0 && !this.ended) {
      this.send({ type: 'sync', lateness: Math.round(average(this.lateness) * 100) / 100 });
    }
  }

  /** Rollback: the earliest frame whose guess was wrong since the last call, or null. */
  takeReplay(): number | null {
    const from = this.replayFrom;
    this.replayFrom = null;
    return from;
  }

  /** Rollback: frames to give back because this phone runs ahead of its opponent; 0 most of the time. */
  takeSlowdown(): number {
    const frames = this.slowdown;
    if (frames > 0) {
      this.slowdown = 0;
      // Paying them back takes frames / SLOWDOWN frames; after that both sides need fresh measurements.
      this.settleUntil = this.frame + Math.ceil(frames / SLOWDOWN) + SETTLE_FRAMES;
    }
    return frames;
  }

  /** Rollback: drops inputs and guesses that no replay will need again. */
  forget(): void {
    const before = Math.min(this.confirmedFrame + 1, this.frame);
    for (const inputs of [this.local, this.remote, this.guesses]) {
      for (const frame of inputs.keys()) if (frame < before) inputs.delete(frame);
    }
  }

  /** Call after simulating `frame`, with the state hash; it goes to the relay on frames 0, 60, 120 and so on. */
  submitHash(frame: number, stateHash: number): void {
    if (this.ended || !isHashFrame(frame) || this.localHashes.has(frame)) return;
    const hash = stateHash >>> 0;
    this.localHashes.set(frame, hash);
    this.send({ type: 'hash', frame, stateHash: hash });
    this.compare(frame);
  }

  /**
   * Reports who won (null for a draw). Both phones send it and the relay checks that they agree,
   * so in a rollback match call it only once the deciding frame is final (see confirmedFrame).
   */
  finish(winner: number | null): void {
    if (!this.ended) this.send({ type: 'end', winner });
  }

  /** Feeds a message from the relay; the RelayClient calls this for input, hash, sync and end. */
  receive(message: ServerMessage): void {
    if (message.type === 'input') {
      // The relay keeps inputs in order with no gaps, so anything else is a stray and is ignored.
      if (message.frame === this.nextRemote) this.addRemote(message.frame, message.buttons);
    } else if (message.type === 'hash') {
      if (!this.remoteHashes.has(message.frame)) {
        this.remoteHashes.set(message.frame, message.stateHash >>> 0);
        this.compare(message.frame);
      }
    } else if (message.type === 'sync') {
      this.syncWith(message.lateness);
    } else if (message.type === 'end' && !this.ended) {
      this.ended = true;
      this.endReason = message.reason;
      this.winner = message.winner;
      for (const listener of this.endListeners) listener(message);
    }
  }

  /** How long the game has waited for the opponent's input, in ms; 0 when it isn't waiting. */
  stalledFor(): number {
    const moving = this.rollback > 0 ? this.canPredict() : this.canStep();
    return this.ended || moving ? 0 : this.now() - this.lastStepAt;
  }

  onDesync(listener: Listener<number>): void {
    this.desyncListeners.push(listener);
  }

  onEnd(listener: Listener<MatchEndMessage>): void {
    this.endListeners.push(listener);
  }

  private addRemote(frame: number, buttons: number): void {
    this.remote.set(frame, buttons);
    this.nextRemote += 1;
    this.lastRemote = buttons;
    if (this.rollback === 0) return;
    const guess = this.guesses.get(frame);
    if (guess !== undefined) {
      this.guesses.delete(frame);
      if (guess !== buttons && (this.replayFrom === null || frame < this.replayFrom)) this.replayFrom = frame;
    }
    // Positive: the frame was already played on a guess. Zero or less: it came in time.
    this.lateness.push(this.frame - frame);
    if (this.lateness.length > LATENESS_SAMPLES) this.lateness.shift();
  }

  /**
   * Both phones measure how late the other's inputs arrive. If this phone started earlier or
   * ran faster, it sees the opponent's inputs later than they see its own, by twice the frames it
   * is ahead; it then slows down by that much. The phone behind does nothing.
   */
  private syncWith(theirLateness: number): void {
    if (this.rollback === 0 || this.ended || this.frame < this.settleUntil || this.lateness.length < LATENESS_SAMPLES / 2) return;
    const ahead = (average(this.lateness) - theirLateness) / 2;
    if (ahead >= MIN_AHEAD_FRAMES) this.slowdown = ahead;
  }

  private compare(frame: number): void {
    const mine = this.localHashes.get(frame);
    const theirs = this.remoteHashes.get(frame);
    if (mine === undefined || theirs === undefined) return;
    this.localHashes.delete(frame);
    this.remoteHashes.delete(frame);
    if (mine !== theirs && this.desyncFrame === null) {
      this.desyncFrame = frame;
      for (const listener of this.desyncListeners) listener(frame);
    }
  }

  /** Frames before startFrame + inputDelay have no input from anyone: both are neutral. */
  private has(inputs: Map<number, number>, frame: number): boolean {
    return frame < this.startFrame + this.inputDelay || inputs.has(frame);
  }

  private take(inputs: Map<number, number>, frame: number): number {
    const buttons = inputs.get(frame) ?? 0;
    inputs.delete(frame);
    return buttons;
  }
}

function average(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length > 0 ? sum / values.length : 0;
}
