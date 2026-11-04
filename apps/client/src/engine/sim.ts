/**
 * The fight engine: a deterministic 60 Hz simulation of two stick men.
 *
 * Both phones run this from the same seed, loadouts and inputs and must reach the same state
 * bit for bit, so it uses integers and Q16.16 only (see fixed.ts). It never reads the screen,
 * the clock or the network: the renderer reads `fighters` and `events` after each step.
 */
import { Button, cleanButtons, hashInts, Rng, type MoveFile, type MoveSlot } from '@sticxcape/shared';
import { clamp, fixedDiv, fixedLength, fixedMul, idiv, ONE, ratio, toFixed } from './fixed.ts';
import { compileMove, HIGH, isActiveFrame, LOW, recordedFrame, sampleMove, type CompiledMove } from './moves.ts';
import { builtinPose, P, stancePose } from './poses.ts';
import { blendPose, createPose, forwardKinematics, J, JOINT_COUNT, lowestFoot, lowestPoint, POSE_SIZE, ROOT_X, ROOT_Y } from './skeleton.ts';

export const S = {
  idle: 0,
  jumpsquat: 1,
  air: 2,
  land: 3,
  attack: 4,
  block: 5,
  blockstun: 6,
  parry: 7,
  parryWhiff: 8,
  hitstun: 9,
  launched: 10,
  knockdown: 11,
  getup: 12,
  stagger: 13,
  dash: 14,
  ko: 15,
  victory: 16,
} as const;

export const PHASE = { intro: 0, fight: 1, ko: 2, timeup: 3, matchEnd: 4, over: 5 } as const;

export const FPS = 60;
export const MAX_HEALTH = 1000;
export const ROUND_FRAMES = 60 * FPS;
export const ROUNDS_TO_WIN = 2;
export const MAX_ROUNDS = 5;
export const INTRO_FRAMES = 96;
export const FIGHT_CALL_FRAME = 58;
export const KO_FRAMES = 210;
/** Frames of the KO in which the winner freezes while the loser flies in slow motion. */
export const KO_HOLD_FRAMES = 75;
export const TIMEUP_FRAMES = 130;
export const MATCH_END_FRAMES = 280;
export const PARRY_WINDOW = 6;
export const PARRY_WHIFF = 20;
export const INPUT_BUFFER = 6;

const WALK_FWD = toFixed(0.046);
const WALK_BACK = toFixed(0.034);
const WALK_PHASE_FWD = 1900;
const WALK_PHASE_BACK = 1500;
const JUMP_V = toFixed(0.104);
const JUMP_VX = toFixed(0.048);
const GRAVITY = toFixed(0.0048);
const JUMPSQUAT_FRAMES = 4;
const LAND_FRAMES = 4;
const LAND_HARD_FRAMES = 7;
const FRICTION = toFixed(0.85);
const AIR_DRAG = toFixed(0.985);
const DASH_SPEED = toFixed(0.13);
const BACKDASH_SPEED = toFixed(0.1);
const DASH_DECAY = toFixed(0.84);
const DASH_FRAMES = 14;
const BACKDASH_FRAMES = 16;
const DOUBLE_TAP = 10;
const BODY_HALF = toFixed(0.23);
const WALL = toFixed(0.32);
const PUSH_HEIGHT = toFixed(0.95);
const PARRY_PUSH = toFixed(0.075);
const STAGGER_FRAMES = 20;
const STAGGER_HEAVY = 30;
const KNOCKDOWN_FRAMES = 38;
const GETUP_FRAMES = 26;
const GETUP_INVULN = 32;
const LAUNCH_MIN_UP = toFixed(0.35);
const LAUNCH_LIFT = toFixed(0.62);
const AIRBORNE = toFixed(0.14);
const GLANCE_DEPTH = toFixed(0.035);
const MIN_SWING = toFixed(0.008);
/** cos 70° and sin 70°: launches are capped at 70° above horizontal. */
const COS70 = toFixed(0.342);
const SIN70 = toFixed(0.9397);
const KO_SPEED = toFixed(0.24);
const KO_LIFT = toFixed(0.085);

export interface MoveStat {
  uses: number;
  hits: number;
  blocks: number;
  parries: number;
  misses: number;
}

export type SimEvent =
  | { type: 'round'; round: number }
  | { type: 'fight' }
  | { type: 'move'; side: number; move: number; slot: MoveSlot }
  | { type: 'swing'; side: number; move: number; strength: number; limb: number }
  | {
      type: 'hit';
      side: number;
      target: number;
      x: number;
      y: number;
      dirX: number;
      dirY: number;
      damage: number;
      strength: number;
      slot: MoveSlot;
      counter: boolean;
      glancing: boolean;
      combo: number;
      launch: boolean;
      ko: boolean;
      limb: number;
      hurtJoint: number;
    }
  | { type: 'block'; side: number; target: number; x: number; y: number; strength: number; chip: number }
  | { type: 'parry'; side: number; target: number; x: number; y: number; heavy: boolean }
  | { type: 'armor'; side: number; x: number; y: number }
  | { type: 'whiff'; side: number; move: number; near: boolean }
  | { type: 'parryWhiff'; side: number }
  | { type: 'jump'; side: number; x: number }
  | { type: 'land'; side: number; x: number; hard: boolean }
  | { type: 'dash'; side: number; dir: number; x: number }
  | { type: 'knockdown'; side: number; x: number }
  | { type: 'ko'; side: number; x: number; y: number; vx: number; vy: number }
  | { type: 'tick'; seconds: number }
  | { type: 'timeup' }
  | { type: 'roundEnd'; winner: number | null; reason: 'ko' | 'time' }
  | { type: 'matchEnd'; winner: number | null };

/** The moves a fighter can use, by input. Indices into `Fighter.moves`; -1 when missing. */
export interface SlotTable {
  light: [number, number];
  heavy: [number, number];
  low: number;
  special: number;
  defense: number;
  taunt: number;
  victory: number;
}

export class Fighter {
  readonly side: 0 | 1;
  readonly moves: CompiledMove[];
  readonly slots: SlotTable;
  readonly stats: MoveStat[];
  damageDealt = 0;
  damageTaken = 0;
  roundsWon = 0;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  state: number = S.idle;
  stateT = 0;
  stun = 0;
  stunTotal = 0;
  move = -1;
  moveT = 0;
  moveHit = 0;
  moveRootX = 0;
  armor = 0;
  cancel = 0;
  health = MAX_HEALTH;
  parryT = 0;
  combo = 0;
  hitKind: number = P.hitLight;
  invuln = 0;
  buffer = -1;
  bufferT = 0;
  buttons = 0;
  prevButtons = 0;
  tapDir = 0;
  tapFrame = -100;
  crouch = 0;
  walk = 0;
  walkPhase = 0;
  jumpDir = 0;
  hardLanding = 0;
  /** The pose shown this frame, the pose a blend started from, and the blend's progress. */
  readonly pose = createPose();
  readonly from = createPose();
  blendT = 0;
  blendLen = 0;
  /** Joint positions in the world, Q16.16 m: x, y per joint. */
  readonly world = new Int32Array(JOINT_COUNT * 2);
  /** The striking limb's position last frame, for swing direction. */
  tipX = 0;
  tipY = 0;
  tipValid = 0;

  constructor(side: 0 | 1, files: readonly MoveFile[]) {
    this.side = side;
    this.moves = files.map((file, i) => compileMove(file, i));
    this.stats = this.moves.map(() => ({ uses: 0, hits: 0, blocks: 0, parries: 0, misses: 0 }));
    const of = (slot: MoveSlot) => this.moves.filter((m) => m.slot === slot).map((m) => m.index);
    const light = of('light');
    const heavy = of('heavy');
    this.slots = {
      light: [light[0] ?? -1, light[1] ?? light[0] ?? -1],
      heavy: [heavy[0] ?? -1, heavy[1] ?? heavy[0] ?? -1],
      low: of('low')[0] ?? -1,
      special: of('special')[0] ?? heavy[0] ?? -1,
      defense: of('defense')[0] ?? -1,
      taunt: of('taunt')[0] ?? -1,
      victory: of('victory')[0] ?? -1,
    };
  }

  get currentMove(): CompiledMove | null {
    return this.state === S.attack || this.state === S.victory ? (this.moves[this.move] ?? null) : null;
  }

  /** True when the fighter is crouching in a way that ducks high strikes. */
  get ducking(): boolean {
    return this.crouch === 1 && (this.state === S.idle || this.state === S.block || this.state === S.blockstun || this.state === S.parry);
  }
}

export interface SimArena {
  /** Playable width, metres. */
  width: number;
  /** Start x of the left and right fighter, metres. */
  spawns: [number, number];
}

export interface SimOptions {
  seed: number;
  arena: SimArena;
  /** Full loadouts, left fighter then right; see resolveLoadout. */
  loadouts: [readonly MoveFile[], readonly MoveFile[]];
}

interface PendingHit {
  attacker: Fighter;
  target: Fighter;
  move: CompiledMove;
  px: number;
  py: number;
  glancing: boolean;
  hurtJoint: number;
  /** How the striking limb moved this frame, Q16.16 m: the knockback direction. */
  swingX: number;
  swingY: number;
}

/** Hurtboxes: [from joint, to joint, radius]. */
const HURT: readonly (readonly [number, number, number])[] = [
  [J.head, J.head, toFixed(0.125)],
  [J.pelvis, J.neck, toFixed(0.13)],
  [J.lShoulder, J.lElbow, toFixed(0.055)],
  [J.rShoulder, J.rElbow, toFixed(0.055)],
  [J.lElbow, J.lWrist, toFixed(0.05)],
  [J.rElbow, J.rWrist, toFixed(0.05)],
  [J.lHip, J.lKnee, toFixed(0.075)],
  [J.rHip, J.rKnee, toFixed(0.075)],
  [J.lKnee, J.lAnkle, toFixed(0.06)],
  [J.rKnee, J.rAnkle, toFixed(0.06)],
];

export class FightSim {
  readonly fighters: [Fighter, Fighter];
  readonly arenaWidth: number;
  readonly spawns: [number, number];
  readonly rng: Rng;
  /** Events from the last step, for the renderer, sound and stats. */
  readonly events: SimEvent[] = [];
  frame = 0;
  phase: number = PHASE.intro;
  phaseT = 0;
  timer = ROUND_FRAMES;
  hitstop = 0;
  round = 1;
  /** Winning side once the match is decided, null for a draw, undefined while it runs. */
  winner: number | null | undefined = undefined;
  lastRoundWinner: number | null = null;

  private readonly target = createPose();
  private readonly joints = new Int32Array(JOINT_COUNT * 2);
  private readonly pending: PendingHit[] = [];

  constructor(options: SimOptions) {
    this.rng = new Rng(options.seed);
    this.arenaWidth = toFixed(options.arena.width);
    this.spawns = [toFixed(options.arena.spawns[0]), toFixed(options.arena.spawns[1])];
    this.fighters = [new Fighter(0, options.loadouts[0]), new Fighter(1, options.loadouts[1])];
    this.resetRound();
  }

  get over(): boolean {
    return this.phase === PHASE.over;
  }

  /** Seconds left on the round clock, rounded up. */
  get seconds(): number {
    return idiv(this.timer + FPS - 1, FPS);
  }

  /** Simulates one frame. Inputs are the 9-bit button fields, left fighter then right. */
  step(inputs: readonly [number, number]): void {
    this.events.length = 0;
    const [a, b] = this.fighters;
    const live = this.phase === PHASE.fight;
    for (const f of this.fighters) {
      f.prevButtons = f.buttons;
      f.buttons = live ? cleanButtons(inputs[f.side]) : 0;
      if (live) this.bufferInput(f);
    }

    if (this.phase === PHASE.over) {
      this.frame += 1;
      return;
    }
    if (this.hitstop > 0) {
      this.hitstop -= 1;
      this.frame += 1;
      return;
    }

    this.phaseT += 1;
    // During the KO's slow motion the winner holds the finishing pose.
    const holdA = this.held(a);
    const holdB = this.held(b);
    if (!holdA) this.think(a, b, live);
    if (!holdB) this.think(b, a, live);
    if (!holdA) this.physics(a);
    if (!holdB) this.physics(b);
    this.separate();
    if (!holdA) this.animate(a);
    if (!holdB) this.animate(b);
    if (live) this.detectHits();
    if (!holdA) this.post(a, live);
    if (!holdB) this.post(b, live);
    this.advancePhase();
    this.frame += 1;
  }

  private held(f: Fighter): boolean {
    return this.phase === PHASE.ko && this.phaseT < KO_HOLD_FRAMES && f.state !== S.ko;
  }

  /** Unsigned 32-bit hash of everything that decides the fight, sent to the relay every 60 frames. */
  hash(): number {
    const values: number[] = [this.frame, this.phase, this.phaseT, this.timer, this.hitstop, this.round, this.rng.state | 0];
    for (const f of this.fighters) {
      values.push(
        f.x, f.y, f.vx, f.vy, f.facing, f.state, f.stateT, f.stun, f.move, f.moveT, f.moveHit, f.moveRootX, f.armor, f.cancel,
        f.health, f.parryT, f.combo, f.invuln, f.buffer, f.bufferT, f.crouch, f.walk, f.walkPhase, f.roundsWon, f.blendT, f.blendLen,
      );
      for (let i = 0; i < POSE_SIZE; i++) values.push(f.pose[i]);
    }
    return hashInts(values);
  }

  // Round flow.

  private resetRound(): void {
    this.phase = PHASE.intro;
    this.phaseT = 0;
    this.timer = ROUND_FRAMES;
    this.hitstop = 0;
    for (const f of this.fighters) {
      f.x = this.spawns[f.side];
      f.y = 0;
      f.vx = 0;
      f.vy = 0;
      f.facing = f.side === 0 ? 1 : -1;
      f.health = MAX_HEALTH;
      f.state = S.idle;
      f.stateT = 0;
      f.stun = 0;
      f.move = -1;
      f.moveT = 0;
      f.moveHit = 0;
      f.armor = 0;
      f.cancel = 0;
      f.parryT = 0;
      f.combo = 0;
      f.invuln = 0;
      f.buffer = -1;
      f.bufferT = 0;
      f.crouch = 0;
      f.walk = 0;
      f.tipValid = 0;
      f.hardLanding = 0;
      stancePose(f.pose, 0);
      f.from.set(f.pose);
      f.blendT = 0;
      f.blendLen = 0;
      this.place(f);
    }
  }

  private advancePhase(): void {
    switch (this.phase) {
      case PHASE.intro:
        if (this.phaseT === 1) this.events.push({ type: 'round', round: this.round });
        if (this.phaseT === FIGHT_CALL_FRAME) this.events.push({ type: 'fight' });
        if (this.phaseT >= INTRO_FRAMES) {
          this.phase = PHASE.fight;
          this.phaseT = 0;
        }
        return;
      case PHASE.fight: {
        const [a, b] = this.fighters;
        if (a.health === 0 || b.health === 0) {
          this.phase = PHASE.ko;
          this.phaseT = 0;
          return;
        }
        this.timer -= 1;
        if (this.timer > 0 && this.timer <= 10 * FPS && this.timer % FPS === 0) this.events.push({ type: 'tick', seconds: idiv(this.timer, FPS) });
        if (this.timer === 0) {
          this.phase = PHASE.timeup;
          this.phaseT = 0;
          this.events.push({ type: 'timeup' });
        }
        return;
      }
      case PHASE.ko:
      case PHASE.timeup:
        if (this.phaseT >= (this.phase === PHASE.ko ? KO_FRAMES : TIMEUP_FRAMES)) this.endRound(this.phase === PHASE.ko ? 'ko' : 'time');
        return;
      case PHASE.matchEnd:
        if (this.phaseT >= MATCH_END_FRAMES) {
          this.phase = PHASE.over;
          this.phaseT = 0;
        }
        return;
    }
  }

  private endRound(reason: 'ko' | 'time'): void {
    const [a, b] = this.fighters;
    let winner: number | null = null;
    if (reason === 'ko') {
      if (a.health === 0 && b.health > 0) winner = 1;
      else if (b.health === 0 && a.health > 0) winner = 0;
    } else if (a.health !== b.health) {
      winner = a.health > b.health ? 0 : 1;
    }
    if (winner !== null) this.fighters[winner].roundsWon += 1;
    this.lastRoundWinner = winner;
    this.events.push({ type: 'roundEnd', winner, reason });

    const decided = a.roundsWon >= ROUNDS_TO_WIN || b.roundsWon >= ROUNDS_TO_WIN || this.round >= MAX_ROUNDS;
    if (decided) {
      this.winner = a.roundsWon === b.roundsWon ? null : a.roundsWon > b.roundsWon ? 0 : 1;
      this.phase = PHASE.matchEnd;
      this.phaseT = 0;
      this.events.push({ type: 'matchEnd', winner: this.winner });
      if (this.winner !== null) {
        const champ = this.fighters[this.winner];
        champ.state = S.victory;
        champ.stateT = 0;
        champ.move = champ.slots.victory;
        champ.moveT = 0;
        champ.vx = 0;
        this.snapshot(champ, 6);
      }
      return;
    }
    this.round += 1;
    this.resetRound();
  }

  // Input.

  /** Presses are remembered for INPUT_BUFFER frames (not counting hit stop), so early presses still count. */
  private bufferInput(f: Fighter): void {
    const pressed = f.buttons & ~f.prevButtons;
    if ((f.buttons & Button.Right) && !(f.prevButtons & Button.Right)) this.tap(f, Button.Right);
    if ((f.buttons & Button.Left) && !(f.prevButtons & Button.Left)) this.tap(f, Button.Left);
    let action = -1;
    const horizontal = (f.buttons & (Button.Left | Button.Right)) !== 0;
    const down = (f.buttons & Button.Down) !== 0;
    if (pressed & Button.Defense) action = down && f.slots.taunt >= 0 ? f.slots.taunt : f.slots.defense;
    if (pressed & Button.Light) action = f.slots.light[horizontal ? 1 : 0];
    if (pressed & Button.Heavy) action = down && f.slots.low >= 0 ? f.slots.low : f.slots.heavy[horizontal ? 1 : 0];
    if (pressed & Button.Special) action = f.slots.special;
    if (action >= 0) {
      f.buffer = action;
      f.bufferT = INPUT_BUFFER;
    }
  }

  /** Remembers taps for double-tap dashes: +1 forward, -1 back, judged by facing at the time. */
  private tap(f: Fighter, bit: number): void {
    const dir = (bit === Button.Right ? 1 : -1) * f.facing;
    if (f.tapDir === dir && this.frame - f.tapFrame <= DOUBLE_TAP && f.state === S.idle && f.crouch === 0) {
      f.tapDir = 2 * dir;
    } else {
      f.tapDir = dir;
    }
    f.tapFrame = this.frame;
  }

  // State machine.

  private setState(f: Fighter, state: number, stun = 0, blend = 3): void {
    f.state = state;
    f.stateT = 0;
    f.stun = stun;
    f.stunTotal = stun;
    if (state !== S.attack) f.move = state === S.victory ? f.move : -1;
    if (blend > 0) this.snapshot(f, blend);
  }

  private snapshot(f: Fighter, blend: number): void {
    f.from.set(f.pose);
    f.blendT = 0;
    f.blendLen = blend;
  }

  private startMove(f: Fighter, index: number): void {
    const move = f.moves[index];
    if (!move) return;
    f.state = S.attack;
    f.stateT = 0;
    f.stun = 0;
    f.move = index;
    f.moveT = 0;
    f.moveHit = 0;
    f.cancel = 0;
    f.crouch = 0;
    f.walk = 0;
    f.armor = move.rules.armor;
    f.buffer = -1;
    f.bufferT = 0;
    f.tipValid = 0;
    sampleMove(move, 0, this.target);
    f.moveRootX = this.target[ROOT_X];
    this.snapshot(f, 4);
    f.stats[index].uses += 1;
    this.events.push({ type: 'move', side: f.side, move: index, slot: move.slot });
  }

  private faceOpponent(f: Fighter, other: Fighter): void {
    if (other.x === f.x) return;
    const facing = other.x > f.x ? 1 : -1;
    if (facing !== f.facing) {
      f.facing = facing;
      // Facing flips mirror the whole body; a short blend hides the turn.
      this.snapshot(f, 3);
      f.from[ROOT_X] = -f.from[ROOT_X];
    }
  }

  private think(f: Fighter, other: Fighter, live: boolean): void {
    const B = f.buttons;
    const fwdBit = f.facing > 0 ? Button.Right : Button.Left;
    const backBit = f.facing > 0 ? Button.Left : Button.Right;

    switch (f.state) {
      case S.idle:
      case S.block: {
        f.combo = 0;
        this.faceOpponent(f, other);
        if (!live) {
          if (f.state !== S.idle) this.setState(f, S.idle);
          f.crouch = 0;
          f.walk = 0;
          return;
        }
        if (f.buffer >= 0) return this.startMove(f, f.buffer);
        if (B & Button.Block) {
          f.walk = 0;
          f.crouch = B & Button.Down ? 1 : 0;
          if (!(f.prevButtons & Button.Block)) {
            this.setState(f, S.parry, 0, 2);
            f.parryT = PARRY_WINDOW;
            return;
          }
          if (f.state !== S.block) this.setState(f, S.block, 0, 3);
          return;
        }
        if (f.state === S.block) this.setState(f, S.idle, 0, 3);
        if (B & Button.Up) {
          f.jumpDir = B & fwdBit ? 1 : B & backBit ? -1 : 0;
          f.crouch = 0;
          this.setState(f, S.jumpsquat, JUMPSQUAT_FRAMES, 2);
          return;
        }
        if (f.tapDir === 2 || f.tapDir === -2) {
          const dir = f.tapDir > 0 ? 1 : -1;
          f.tapDir = 0;
          this.setState(f, S.dash, dir > 0 ? DASH_FRAMES : BACKDASH_FRAMES, 2);
          f.jumpDir = dir;
          f.vx = f.facing * dir * (dir > 0 ? DASH_SPEED : BACKDASH_SPEED);
          this.events.push({ type: 'dash', side: f.side, dir, x: f.x });
          return;
        }
        const crouch = B & Button.Down ? 1 : 0;
        if (crouch !== f.crouch) this.snapshot(f, 4);
        f.crouch = crouch;
        const walk = crouch ? 0 : B & fwdBit ? 1 : B & backBit ? -1 : 0;
        if (walk !== f.walk) this.snapshot(f, 4);
        f.walk = walk;
        return;
      }
      case S.jumpsquat:
        if (f.stun === 0) {
          f.vy = JUMP_V;
          f.vx = f.facing * f.jumpDir * JUMP_VX;
          f.y = 1;
          this.setState(f, S.air, 0, 3);
          this.events.push({ type: 'jump', side: f.side, x: f.x });
        }
        return;
      case S.land:
      case S.dash:
      case S.getup:
        if (f.stun === 0) this.setState(f, S.idle, 0, 3);
        else if (f.state === S.land && live && f.buffer >= 0 && f.stateT >= 2) this.startMove(f, f.buffer);
        return;
      case S.attack: {
        const move = f.moves[f.move];
        if (f.cancel && f.buffer >= 0 && live) {
          const next = f.moves[f.buffer];
          if (next && next.index !== move.index && (next.slot === 'heavy' || next.slot === 'special' || next.slot === 'low')) {
            this.startMove(f, f.buffer);
          }
        }
        return;
      }
      case S.parry:
        if (!live) this.setState(f, S.idle);
        return;
      case S.blockstun:
        if (f.stun === 0) {
          if (live && B & Button.Block) this.setState(f, S.block, 0, 3);
          else this.setState(f, S.idle, 0, 4);
        }
        return;
      case S.parryWhiff:
      case S.hitstun:
      case S.stagger:
        if (f.stun === 0) this.setState(f, S.idle, 0, 5);
        return;
      case S.knockdown:
        if (f.stun === 0) {
          this.setState(f, S.getup, GETUP_FRAMES, 0);
          f.invuln = GETUP_INVULN;
          f.facing = other.x >= f.x ? 1 : -1;
        }
        return;
      case S.victory: {
        const move = f.moves[f.move];
        if (move && f.moveT >= move.total) f.moveT = 0;
        return;
      }
    }
  }

  private physics(f: Fighter): void {
    switch (f.state) {
      case S.idle:
        if (f.walk !== 0) {
          f.x += f.facing * (f.walk > 0 ? WALK_FWD : -WALK_BACK);
          f.walkPhase = (f.walkPhase + (f.walk > 0 ? WALK_PHASE_FWD : WALK_PHASE_BACK)) & 0xffff;
        }
        f.x += f.vx;
        f.vx = fixedMul(f.vx, FRICTION);
        break;
      case S.air:
      case S.launched:
      case S.ko:
        if (f.y > 0 || f.vy > 0) {
          f.vy -= GRAVITY;
          f.x += f.vx;
          f.y += f.vy;
          f.vx = fixedMul(f.vx, AIR_DRAG);
          if (f.y <= 0) this.landed(f);
        } else {
          f.x += f.vx;
          f.vx = fixedMul(f.vx, FRICTION);
        }
        break;
      case S.attack: {
        const move = f.moves[f.move];
        sampleMove(move, recordedFrame(move, f.moveT), this.target);
        const rootX = this.target[ROOT_X];
        f.x += f.facing * (rootX - f.moveRootX);
        f.moveRootX = rootX;
        f.x += f.vx;
        f.vx = fixedMul(f.vx, FRICTION);
        break;
      }
      case S.dash:
        f.x += f.vx;
        f.vx = fixedMul(f.vx, DASH_DECAY);
        break;
      default:
        f.x += f.vx;
        f.vx = fixedMul(f.vx, FRICTION);
    }
    if (f.vx !== 0 && Math.abs(f.vx) < 64) f.vx = 0;
    f.x = clamp(f.x, WALL, this.arenaWidth - WALL);
  }

  private landed(f: Fighter): void {
    const speed = -f.vy;
    f.y = 0;
    f.vy = 0;
    if (f.state === S.air) {
      const hard = speed > toFixed(0.09);
      this.setState(f, S.land, hard ? LAND_HARD_FRAMES : LAND_FRAMES, 2);
      f.vx = 0;
      this.events.push({ type: 'land', side: f.side, x: f.x, hard });
    } else if (f.state === S.launched) {
      this.setState(f, S.knockdown, KNOCKDOWN_FRAMES, 4);
      f.vx = idiv(f.vx, 2);
      this.events.push({ type: 'knockdown', side: f.side, x: f.x });
      this.events.push({ type: 'land', side: f.side, x: f.x, hard: true });
    } else {
      f.vx = idiv(f.vx, 2);
      this.events.push({ type: 'land', side: f.side, x: f.x, hard: true });
    }
  }

  /** Keeps the fighters from overlapping, sharing the push unless one is against a wall. */
  private separate(): void {
    const [a, b] = this.fighters;
    if (Math.abs(a.y - b.y) > PUSH_HEIGHT) return;
    if (a.state === S.ko || b.state === S.ko) return;
    const gap = b.x - a.x;
    const overlap = 2 * BODY_HALF - Math.abs(gap);
    if (overlap <= 0) return;
    const dir = gap > 0 ? 1 : gap < 0 ? -1 : a.facing;
    const half = overlap >> 1;
    a.x -= dir * half;
    b.x += dir * (overlap - half);
    const minX = WALL;
    const maxX = this.arenaWidth - WALL;
    if (a.x < minX || a.x > maxX) {
      const fix = clamp(a.x, minX, maxX) - a.x;
      a.x += fix;
      b.x += fix;
    }
    if (b.x < minX || b.x > maxX) {
      const fix = clamp(b.x, minX, maxX) - b.x;
      b.x += fix;
      a.x += fix;
    }
  }

  // Poses.

  private animate(f: Fighter): void {
    const out = this.target;
    const t = f.stateT;
    let lying = false;
    switch (f.state) {
      case S.idle:
        if (f.crouch) builtinPose(out, P.crouch, this.frame);
        else if (f.walk !== 0) builtinPose(out, P.walk, t, f.walkPhase, f.walk);
        else builtinPose(out, P.stance, this.frame + f.side * 97);
        break;
      case S.jumpsquat:
        builtinPose(out, P.squat, t);
        break;
      case S.air:
        builtinPose(out, P.air, t, f.vy);
        break;
      case S.land:
        builtinPose(out, P.land, t, f.stunTotal);
        break;
      case S.attack:
      case S.victory: {
        const move = f.moves[f.move];
        if (!move) {
          stancePose(out, this.frame);
          break;
        }
        sampleMove(move, recordedFrame(move, f.moveT), out);
        out[ROOT_X] = 0;
        // Blend back to the stance over the last 6 frames.
        const left = move.total - f.moveT;
        if (f.state === S.attack && left <= 6) blendInto(out, stanceScratch(this.frame), ratio(7 - left, 7));
        break;
      }
      case S.block:
        builtinPose(out, f.crouch ? P.blockLow : P.block, t);
        break;
      case S.blockstun:
        builtinPose(out, f.crouch ? P.blockLow : P.block, t);
        out[ROOT_X] -= toFixed(0.03) * Math.max(0, 4 - t);
        break;
      case S.parry:
        builtinPose(out, f.crouch ? P.parryLow : P.parry, t);
        break;
      case S.parryWhiff:
        builtinPose(out, P.land, t, f.stunTotal);
        break;
      case S.hitstun:
        builtinPose(out, f.hitKind, t, f.stunTotal);
        break;
      case S.launched:
        builtinPose(out, P.launched, t);
        break;
      case S.knockdown:
        builtinPose(out, P.down, t);
        lying = true;
        break;
      case S.getup:
        builtinPose(out, P.getup, t, GETUP_FRAMES);
        lying = t < GETUP_FRAMES >> 1;
        break;
      case S.stagger:
        builtinPose(out, P.stagger, t);
        break;
      case S.dash:
        builtinPose(out, f.jumpDir > 0 ? P.dash : P.backdash, t);
        break;
      case S.ko:
        if (f.y > 0) builtinPose(out, P.launched, t);
        else {
          builtinPose(out, P.koDown, t);
          lying = true;
        }
        break;
      default:
        stancePose(out, this.frame);
    }

    if (f.blendT < f.blendLen) {
      f.blendT += 1;
      blendPose(f.from, out, ratio(f.blendT, f.blendLen + 1), f.pose);
    } else {
      f.pose.set(out);
    }

    // Never let the body sink into the floor.
    const low = lying ? lowestPoint(f.pose) : lowestFoot(f.pose);
    if (f.y + f.pose[ROOT_Y] + low < 0) f.pose[ROOT_Y] = -low - f.y;
    this.place(f);
  }

  /** World joint positions from the pose, the anchor and facing. */
  private place(f: Fighter): void {
    forwardKinematics(f.pose, this.joints);
    for (let j = 0; j < JOINT_COUNT; j++) {
      f.world[2 * j] = f.x + f.facing * this.joints[2 * j];
      f.world[2 * j + 1] = f.y + this.joints[2 * j + 1];
    }
  }

  // Hits.

  private detectHits(): void {
    this.pending.length = 0;
    for (const f of this.fighters) {
      const other = this.fighters[1 - f.side];
      if (f.state !== S.attack) continue;
      const move = f.moves[f.move];
      const tipX = f.world[2 * move.limb];
      const tipY = f.world[2 * move.limb + 1];
      if (move.hasHitbox && !f.moveHit && isActiveFrame(move, f.moveT)) {
        if (f.moveT === move.startup) this.events.push({ type: 'swing', side: f.side, move: move.index, strength: move.rules.strength, limb: move.limb });
        const hit = this.testHit(f, other, move, tipX, tipY);
        if (hit) this.pending.push(hit);
      }
      f.tipX = tipX;
      f.tipY = tipY;
      f.tipValid = 1;
    }
    for (const hit of this.pending) this.resolve(hit);
  }

  private testHit(a: Fighter, t: Fighter, move: CompiledMove, tipX: number, tipY: number): PendingHit | null {
    if (t.invuln > 0 || t.state === S.ko || t.state === S.knockdown || t.state === S.getup) return null;
    const tMove = t.currentMove;
    if (tMove && tMove.evasive && isActiveFrame(tMove, t.moveT)) return null;
    // Height rules: highs sail over a crouch, lows pass under anyone off the ground.
    if (move.height === HIGH && t.ducking) return null;
    if (move.height === LOW && (t.y > AIRBORNE || t.pose[ROOT_Y] + lowestFoot(t.pose) > AIRBORNE + toFixed(0.1))) return null;

    const baseX = a.world[2 * move.limbParent];
    const baseY = a.world[2 * move.limbParent + 1];
    const samples = this.samples;
    samples[0] = tipX;
    samples[1] = tipY;
    samples[2] = baseX + idiv((tipX - baseX) * 2, 3);
    samples[3] = baseY + idiv((tipY - baseY) * 2, 3);
    let count = 2;
    if (a.tipValid) {
      samples[4] = (a.tipX + tipX) >> 1;
      samples[5] = (a.tipY + tipY) >> 1;
      count = 3;
    }

    let best = -1;
    let bestDepth = 0;
    let px = 0;
    let py = 0;
    let hurtJoint: number = J.pelvis;
    for (const [from, to, radius] of HURT) {
      const ax = t.world[2 * from];
      const ay = t.world[2 * from + 1];
      const bx = t.world[2 * to];
      const by = t.world[2 * to + 1];
      const reach = radius + move.hitRadius;
      for (let s = 0; s < count; s++) {
        const sx = samples[2 * s];
        const sy = samples[2 * s + 1];
        const d = closest(sx, sy, ax, ay, bx, by, this.closestOut);
        if (d >= reach) continue;
        const depth = reach - d;
        if (depth > bestDepth) {
          bestDepth = depth;
          best = from;
          px = (sx + this.closestOut[0]) >> 1;
          py = (sy + this.closestOut[1]) >> 1;
          hurtJoint = s === 0 && from === to ? from : depthJoint(from, to, this.closestOut[2]);
        }
      }
    }
    if (best < 0) return null;
    const swingX = a.tipValid ? tipX - a.tipX : 0;
    const swingY = a.tipValid ? tipY - a.tipY : 0;
    return { attacker: a, target: t, move, px, py, glancing: bestDepth < GLANCE_DEPTH, hurtJoint, swingX, swingY };
  }

  private readonly samples = new Int32Array(6);
  private readonly closestOut = new Int32Array(3);

  private resolve(hit: PendingHit): void {
    const { attacker: a, target: t, move } = hit;
    const rules = move.rules;
    const stat = a.stats[move.index];
    a.moveHit = 1;

    // Parry: a tap of Block just before the strike lands.
    if (t.state === S.parry && t.parryT > 0 && (t.crouch ? move.height === LOW : move.height !== LOW)) {
      const heavy = rules.strength === 2;
      this.setState(a, S.stagger, heavy ? STAGGER_HEAVY : STAGGER_FRAMES, 2);
      a.vx = -a.facing * PARRY_PUSH;
      this.setState(t, S.idle, 0, 3);
      t.parryT = 0;
      t.crouch = 0;
      stat.parries += 1;
      this.hitstop = 12;
      this.events.push({ type: 'parry', side: t.side, target: a.side, x: hit.px, y: hit.py, heavy });
      return;
    }

    // Block: standing stops highs and mids, crouching stops lows.
    const blocking = t.state === S.block || t.state === S.blockstun;
    if (blocking && (t.crouch ? move.height === LOW : move.height !== LOW)) {
      const chip = idiv(rules.damage * 20, 100);
      t.health = Math.max(0, t.health - chip);
      t.damageTaken += chip;
      a.damageDealt += chip;
      this.setState(t, S.blockstun, rules.blockstun, 0);
      const push = idiv(rules.knockback, 2) + toFixed(0.02);
      t.vx = a.facing * push;
      if (this.nearWall(t)) a.vx = -a.facing * idiv(push, 2);
      stat.blocks += 1;
      this.hitstop = rules.strength === 2 ? 6 : 3;
      this.events.push({ type: 'block', side: a.side, target: t.side, x: hit.px, y: hit.py, strength: rules.strength, chip });
      if (t.health === 0) this.knockOut(a, t, hit, a.facing * toFixed(0.9), toFixed(0.4));
      return;
    }

    // Armor: a heavy in startup or active frames shrugs off one light hit.
    const tMove = t.currentMove;
    if (t.state === S.attack && tMove && t.armor > 0 && move.slot === 'light' && t.moveT < tMove.startup + tMove.active) {
      t.armor -= 1;
      const damage = rules.damage;
      t.health = Math.max(0, t.health - damage);
      t.damageTaken += damage;
      a.damageDealt += damage;
      stat.hits += 1;
      this.hitstop = 5;
      this.events.push({ type: 'armor', side: t.side, x: hit.px, y: hit.py });
      if (t.health === 0) this.knockOut(a, t, hit, a.facing * toFixed(0.9), toFixed(0.4));
      return;
    }

    // A clean hit.
    const counter = (t.state === S.attack && tMove !== null && t.moveT < tMove.startup) || t.state === S.parryWhiff || t.state === S.parry;
    let damage = rules.damage;
    if (counter) damage = idiv(damage * 125, 100);
    if (hit.glancing) damage = idiv(damage, 2);
    damage = idiv(damage * Math.max(50, 100 - 10 * t.combo), 100);
    t.health = Math.max(0, t.health - damage);
    t.damageTaken += damage;
    a.damageDealt += damage;
    stat.hits += 1;
    t.combo += 1;
    a.cancel = move.slot === 'light' ? 1 : 0;

    // Knockback along the real swing, capped at 70° above horizontal.
    let dx = hit.swingX;
    let dy = hit.swingY;
    const len = fixedLength(dx, dy);
    if (len < MIN_SWING) {
      dx = a.facing * ONE;
      dy = toFixed(0.15);
    } else {
      dx = fixedDiv(dx, len);
      dy = fixedDiv(dy, len);
    }
    dx = a.facing * Math.abs(dx);
    if (Math.abs(dx) < COS70) {
      dx = a.facing * COS70;
      dy = dy < 0 ? -SIN70 : SIN70;
    }
    const grounded = t.y <= 0 && t.state !== S.air;
    if (grounded && dy < 0) dy = 0;
    if (rules.strength === 0) dy = Math.min(dy, toFixed(0.25));
    const norm = fixedLength(dx, dy);
    if (norm > 0) {
      dx = fixedDiv(dx, norm);
      dy = fixedDiv(dy, norm);
    }
    // Stronger when the target is low on health, so late hits fly further.
    let speed = rules.knockback;
    speed += idiv(speed * (MAX_HEALTH - t.health), 2 * MAX_HEALTH);
    if (counter) speed += idiv(speed, 6);

    const ko = t.health === 0;
    const launch = !ko && ((rules.launch && dy > LAUNCH_MIN_UP) || t.state === S.air || t.state === S.launched || (t.y > AIRBORNE && rules.strength > 0));
    this.hitstop = rules.hitstop + (counter ? 2 : 0);
    this.events.push({
      type: 'hit',
      side: a.side,
      target: t.side,
      x: hit.px,
      y: hit.py,
      dirX: dx,
      dirY: dy,
      damage,
      strength: rules.strength,
      slot: move.slot,
      counter,
      glancing: hit.glancing,
      combo: t.combo,
      launch,
      ko,
      limb: move.limb,
      hurtJoint: hit.hurtJoint,
    });

    if (ko) {
      this.knockOut(a, t, hit, dx, dy);
      return;
    }
    if (launch) {
      this.setState(t, S.launched, 0, 2);
      t.vx = fixedMul(dx, speed);
      t.vy = Math.max(toFixed(0.045), fixedMul(fixedMul(dy, speed), LAUNCH_LIFT) + toFixed(0.03));
      t.y = Math.max(t.y, 1);
      return;
    }
    const stun = Math.max(8, rules.hitstun - 2 * (t.combo - 1));
    t.hitKind = rules.strength === 2 ? P.hitHeavy : move.slot === 'low' ? P.hitLow : P.hitLight;
    this.setState(t, S.hitstun, stun, 1);
    t.vx = fixedMul(dx, speed);
    if (this.nearWall(t)) a.vx = -a.facing * idiv(speed, 2);
  }

  private knockOut(a: Fighter, t: Fighter, hit: PendingHit, dx: number, dy: number): void {
    this.setState(t, S.ko, 0, 1);
    const vx = fixedMul(dx, KO_SPEED);
    t.vx = Math.abs(vx) < toFixed(0.08) ? a.facing * toFixed(0.08) : vx;
    t.vy = Math.max(KO_LIFT, fixedMul(Math.max(0, dy), KO_SPEED));
    t.y = Math.max(t.y, 1);
    this.hitstop = 20;
    this.events.push({ type: 'ko', side: t.side, x: hit.px, y: hit.py, vx: t.vx, vy: t.vy });
  }

  private nearWall(f: Fighter): boolean {
    return f.x <= WALL + toFixed(0.25) || f.x >= this.arenaWidth - WALL - toFixed(0.25);
  }

  private post(f: Fighter, live: boolean): void {
    f.stateT += 1;
    if (f.stun > 0) f.stun -= 1;
    if (f.invuln > 0) f.invuln -= 1;
    if (f.bufferT > 0) {
      f.bufferT -= 1;
      if (f.bufferT === 0) f.buffer = -1;
    }
    switch (f.state) {
      case S.attack: {
        const move = f.moves[f.move];
        if (move.hasHitbox && !f.moveHit && f.moveT === move.startup + move.active - 1) {
          f.stats[move.index].misses += 1;
          const other = this.fighters[1 - f.side];
          const near = Math.abs(other.x - f.x) < move.reach + toFixed(0.9);
          this.events.push({ type: 'whiff', side: f.side, move: move.index, near });
        }
        f.moveT += 1;
        if (f.moveT >= move.total) this.setState(f, S.idle, 0, 2);
        break;
      }
      case S.victory:
        f.moveT += 1;
        break;
      case S.parry:
        f.parryT -= 1;
        if (f.parryT <= 0) {
          if (live && f.buttons & Button.Block) {
            this.setState(f, S.block, 0, 3);
          } else {
            this.setState(f, S.parryWhiff, PARRY_WHIFF, 3);
            this.events.push({ type: 'parryWhiff', side: f.side });
          }
        }
        break;
    }
  }
}

/** Distance from point p to segment ab; out receives the closest point and t (0..ONE). */
function closest(px: number, py: number, ax: number, ay: number, bx: number, by: number, out: Int32Array): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = fixedMul(abx, abx) + fixedMul(aby, aby);
  let t = 0;
  if (len2 > 0) t = clamp(fixedDiv(fixedMul(px - ax, abx) + fixedMul(py - ay, aby), len2), 0, ONE);
  const cx = ax + fixedMul(abx, t);
  const cy = ay + fixedMul(aby, t);
  out[0] = cx;
  out[1] = cy;
  out[2] = t;
  return fixedLength(px - cx, py - cy);
}

function depthJoint(from: number, to: number, t: number): number {
  return t > ONE >> 1 ? to : from;
}

const stanceTmp = createPose();
function stanceScratch(frame: number): Int32Array {
  stancePose(stanceTmp, frame);
  return stanceTmp;
}

const blendTmp = createPose();
function blendInto(out: Int32Array, toward: Int32Array, t: number): void {
  blendTmp.set(out);
  blendPose(blendTmp, toward, t, out);
  out[ROOT_X] = 0;
}

/** Which side a player number fights on, for messages that use player numbers. */
export function sideOf(fighters: readonly [number, number], player: number): 0 | 1 | -1 {
  return fighters[0] === player ? 0 : fighters[1] === player ? 1 : -1;
}
