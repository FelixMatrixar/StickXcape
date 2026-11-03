import {
  cleanButtons,
  isHashFrame,
  type ClientMessage,
  type EndReason,
  type MatchEndMessage,
  type ServerMessage,
  type StartMessage,
} from '@sticxcape/shared';

export interface LockstepOptions {
  /** This phone's player number. */
  localPlayer: number;
  start: StartMessage;
  send: (message: ClientMessage) => void;
  now?: () => number;
}

type Listener<T> = (value: T) => void;

/**
 * Input-delay lockstep for one match, the MVP netcode. Each frame the local buttons are sent for
 * `frame + inputDelay`, and the game may simulate a frame only once both fighters' inputs for it
 * are here. Every 60 frames both phones send a state hash; a mismatch is a desync.
 *
 * At launch, rollback netcode replaces this class; the relay and the fight engine stay as they are.
 */
export class LockstepSession {
  readonly localPlayer: number;
  readonly fighters: [number, number];
  /** 0 when this phone is the left fighter, 1 when the right. */
  readonly localSide: 0 | 1;
  readonly inputDelay: number;
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

  constructor({ localPlayer, start, send, now = () => performance.now() }: LockstepOptions) {
    const side = start.fighters.indexOf(localPlayer);
    if (side !== 0 && side !== 1) throw new Error(`Player ${localPlayer} is not fighting in this match`);
    this.localPlayer = localPlayer;
    this.fighters = [start.fighters[0], start.fighters[1]];
    this.localSide = side;
    this.inputDelay = start.inputDelay;
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

  /** True when both fighters' inputs for `frame` are here. */
  canStep(): boolean {
    return !this.ended && this.has(this.local, this.frame) && this.has(this.remote, this.frame);
  }

  /** Inputs for `frame` in fighter order (left, right), then moves to the next frame. */
  step(): [number, number] {
    if (!this.canStep()) throw new Error(`Inputs for frame ${this.frame} have not arrived`);
    const mine = this.take(this.local, this.frame);
    const theirs = this.take(this.remote, this.frame);
    this.frame += 1;
    this.lastStepAt = this.now();
    return this.localSide === 0 ? [mine, theirs] : [theirs, mine];
  }

  /** Call after simulating `frame`, with the state hash; it goes to the relay on frames 0, 60, 120 and so on. */
  submitHash(frame: number, stateHash: number): void {
    if (this.ended || !isHashFrame(frame) || this.localHashes.has(frame)) return;
    const hash = stateHash >>> 0;
    this.localHashes.set(frame, hash);
    this.send({ type: 'hash', frame, stateHash: hash });
    this.compare(frame);
  }

  /** Reports who won (null for a draw). Both phones send it and the relay checks that they agree. */
  finish(winner: number | null): void {
    if (!this.ended) this.send({ type: 'end', winner });
  }

  /** Feeds a message from the relay; the RelayClient calls this for input, hash and end. */
  receive(message: ServerMessage): void {
    if (message.type === 'input') {
      // The relay keeps inputs in order with no gaps, so anything else is a stray and is ignored.
      if (message.frame === this.nextRemote) {
        this.remote.set(message.frame, message.buttons);
        this.nextRemote += 1;
      }
    } else if (message.type === 'hash') {
      if (!this.remoteHashes.has(message.frame)) {
        this.remoteHashes.set(message.frame, message.stateHash >>> 0);
        this.compare(message.frame);
      }
    } else if (message.type === 'end' && !this.ended) {
      this.ended = true;
      this.endReason = message.reason;
      this.winner = message.winner;
      for (const listener of this.endListeners) listener(message);
    }
  }

  /** How long the game has waited for the opponent's input, in ms; 0 when it isn't waiting. */
  stalledFor(): number {
    return this.ended || this.canStep() ? 0 : this.now() - this.lastStepAt;
  }

  onDesync(listener: Listener<number>): void {
    this.desyncListeners.push(listener);
  }

  onEnd(listener: Listener<MatchEndMessage>): void {
    this.endListeners.push(listener);
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
