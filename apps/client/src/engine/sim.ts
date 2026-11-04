/**
 * The fight engine: a deterministic 60 Hz simulation of two stick men.
 *
 * Both phones run this from the same seed, loadouts and inputs and must reach the same state
 * bit for bit, so it uses integers and Q16.16 only (see fixed.ts). It never reads the screen,
 * the clock or the network: the renderer reads `fighters` and `events` after each step.
 */
import { Button, cleanButtons, hashInts, Rng, type MoveFile, type MoveSlot } from '@sticxcape/shared';
import { clamp, fixedDiv, fixedLength, fixedMul, idiv, lerpFixed, ONE, ratio, toFixed } from './fixed.ts';
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
  grab: 17,
  throw: 18,
  thrown: 19,
  guardBreak: 20,
  roll: 21,
} as const;

export const PHASE = { intro: 0, fight: 1, ko: 2, timeup: 3, matchEnd: 4, over: 5, ringout: 6 } as const;

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
const BODY_HALF = toFixed(0.27);
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

// Stamina (CB-7): heavies and specials spend it and it refills, so nobody spams the strongest move.
export const STAMINA_MAX = 1000;
const STAMINA_REGEN = 4;
const STAMINA_WAIT = 36;
export const HEAVY_COST = 220;
export const SPECIAL_COST = 330;
// Guard (CB-7): holding Block drains it and blocked hits drain more; empty is a guard break.
export const GUARD_MAX = 1000;
const GUARD_HOLD_DRAIN = 2;
const GUARD_REGEN = 5;
const GUARD_WAIT = 30;
const GUARD_BREAK_FRAMES = 40;
// Grabs (CB-6): L and H together. Strikes beat grabs; grabs beat blocks and parries.
export const GRAB_ACTION = 64;
export const GRAB_STARTUP = 8;
const GRAB_ACTIVE = 3;
const GRAB_RECOVERY = 30;
export const GRAB_RANGE = toFixed(0.95);
/** L then H this many frames apart still makes a grab. */
const GRAB_COMBINE = 2;
const THROW_FRAMES = 36;
const THROW_SLAM = 20;
export const THROW_DAMAGE = 100;
// Get-up rolls: hold forward or back while down.
const ROLL_FRAMES = 22;
const ROLL_SPEED = toFixed(0.062);
const ROLL_INVULN = 28;
// Ring-outs (CB-8): past a drop edge there is no floor.
const RINGOUT_FRAMES = 200;
const FALL_LIMIT = toFixed(-30);
const NO_LIMIT = toFixed(100);
// Ledges (AR-6): solid blocks you can stand on. A fighter's centre keeps this far from a ledge's
// side; standing on top counts this far past either end, so stepping off never jumps sideways.
const LEDGE_MARGIN = toFixed(0.12);

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
  | { type: 'jump'; side: number; x: number; y: number }
  | { type: 'land'; side: number; x: number; y: number; hard: boolean }
  | { type: 'dash'; side: number; dir: number; x: number; y: number }
  | { type: 'knockdown'; side: number; x: number; y: number }
  | { type: 'ko'; side: number; x: number; y: number; vx: number; vy: number }
  | { type: 'tick'; seconds: number }
  | { type: 'timeup' }
  | { type: 'grab'; side: number; target: number; x: number; y: number }
  | { type: 'throw'; side: number; target: number; x: number; y: number; damage: number; ko: boolean }
  | { type: 'clash'; x: number; y: number }
  | { type: 'guardBreak'; side: number; x: number; y: number }
  | { type: 'tired'; side: number }
  | { type: 'roll'; side: number; dir: number; x: number; y: number }
  | { type: 'ringout'; side: number; x: number }
  | { type: 'roundEnd'; winner: number | null; reason: 'ko' | 'time' | 'ringout' }
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
  stamina = STAMINA_MAX;
  staminaWait = 0;
  guard = GUARD_MAX;
  guardWait = 0;
  rollDir = 0;
  /** Off a drop edge with no floor below: falling out of the arena. */
  falling = 0;
  /** Height of what the fighter stands on: 0 for the floor, a ledge's top, or 0 while airborne. */
  floor = 0;
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
  /** Drop edges allow ring-outs; walls stop fighters. Walls when left out. */
  edges?: { left: 'wall' | 'drop'; right: 'wall' | 'drop' };
  /** Ledges (AR-6): solid blocks from the floor up to y, starting at x. Stand on top; the sides stop you. */
  ledges?: readonly { x: number; y: number; width: number }[];
}

/** A ledge in simulation units, Q16.16 m. */
export interface Ledge {
  x0: number;
  x1: number;
  top: number;
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
  readonly dropLeft: boolean;
  readonly dropRight: boolean;
  readonly ledges: readonly Ledge[];
  /** The side that fell out of the arena this round, or -1. */
  ringoutSide = -1;
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
    this.dropLeft = options.arena.edges?.left === 'drop';
    this.dropRight = options.arena.edges?.right === 'drop';
    this.ledges = (options.arena.ledges ?? []).map((l) => ({ x0: toFixed(l.x), x1: toFixed(l.x + l.width), top: toFixed(l.y) }));
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
    if (!holdA) this.physics(a, b);
    if (!holdB) this.physics(b, a);
    this.separate();
    if (!holdA) this.animate(a);
    if (!holdB) this.animate(b);
    if (live) this.detectHits();
    if (live) this.detectGrabs();
    if (!holdA) this.post(a, live);
    if (!holdB) this.post(b, live);
    this.advancePhase();
    this.frame += 1;
  }

  private held(f: Fighter): boolean {
    if (this.phase === PHASE.ringout) return this.phaseT < KO_HOLD_FRAMES && f.side !== this.ringoutSide;
    return this.phase === PHASE.ko && this.phaseT < KO_HOLD_FRAMES && f.state !== S.ko;
  }

  /** Unsigned 32-bit hash of everything that decides the fight, sent to the relay every 60 frames. */
  hash(): number {
    const values: number[] = [this.frame, this.phase, this.phaseT, this.timer, this.hitstop, this.round, this.rng.state | 0, this.ringoutSide];
    for (const f of this.fighters) {
      values.push(
        f.x, f.y, f.vx, f.vy, f.facing, f.state, f.stateT, f.stun, f.move, f.moveT, f.moveHit, f.moveRootX, f.armor, f.cancel,
        f.health, f.parryT, f.combo, f.invuln, f.buffer, f.bufferT, f.crouch, f.walk, f.walkPhase, f.roundsWon, f.blendT, f.blendLen,
        f.stamina, f.staminaWait, f.guard, f.guardWait, f.rollDir, f.falling, f.floor,
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
    this.ringoutSide = -1;
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
      f.stamina = STAMINA_MAX;
      f.staminaWait = 0;
      f.guard = GUARD_MAX;
      f.guardWait = 0;
      f.rollDir = 0;
      f.falling = 0;
      f.floor = 0;
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
      case PHASE.ringout: {
        const limit = this.phase === PHASE.ko ? KO_FRAMES : this.phase === PHASE.ringout ? RINGOUT_FRAMES : TIMEUP_FRAMES;
        if (this.phaseT >= limit) this.endRound(this.phase === PHASE.ko ? 'ko' : this.phase === PHASE.ringout ? 'ringout' : 'time');
        return;
      }
      case PHASE.matchEnd:
        if (this.phaseT >= MATCH_END_FRAMES) {
          this.phase = PHASE.over;
          this.phaseT = 0;
        }
        return;
    }
  }

  private endRound(reason: 'ko' | 'time' | 'ringout'): void {
    const [a, b] = this.fighters;
    let winner: number | null = null;
    if (reason === 'ringout') {
      winner = this.ringoutSide >= 0 ? 1 - this.ringoutSide : null;
    } else if (reason === 'ko') {
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
    if (pressed & (Button.Light | Button.Heavy) && f.buttons & Button.Light && f.buttons & Button.Heavy) action = GRAB_ACTION;
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

  /** Starts whatever is buffered: a grab or a move. */
  private startAction(f: Fighter): void {
    if (f.buffer === GRAB_ACTION) this.startGrab(f);
    else this.startMove(f, f.buffer);
  }

  private startGrab(f: Fighter): void {
    this.setState(f, S.grab, 0, 3);
    f.crouch = 0;
    f.walk = 0;
    f.vx = 0;
    f.buffer = -1;
    f.bufferT = 0;
  }

  private startMove(f: Fighter, index: number): void {
    const move = f.moves[index];
    if (!move) return;
    const cost = move.slot === 'heavy' ? HEAVY_COST : move.slot === 'special' ? SPECIAL_COST : 0;
    if (cost > f.stamina) {
      // Out of breath: the move doesn't come out.
      f.buffer = -1;
      f.bufferT = 0;
      this.events.push({ type: 'tired', side: f.side });
      return;
    }
    if (cost > 0) {
      f.stamina -= cost;
      f.staminaWait = STAMINA_WAIT;
    }
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
        if (f.buffer >= 0) return this.startAction(f);
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
          this.events.push({ type: 'dash', side: f.side, dir, x: f.x, y: f.floor });
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
          this.events.push({ type: 'jump', side: f.side, x: f.x, y: f.floor });
          this.takeOff(f);
          this.setState(f, S.air, 0, 3);
        }
        return;
      case S.land:
      case S.dash:
      case S.getup:
        if (f.stun === 0) this.setState(f, S.idle, 0, 3);
        else if (f.state === S.land && live && f.buffer >= 0 && f.stateT >= 2) this.startAction(f);
        return;
      case S.attack: {
        const move = f.moves[f.move];
        // L then H a frame apart still makes a grab, not a jab.
        if (live && f.buffer === GRAB_ACTION && f.moveT <= GRAB_COMBINE && !f.moveHit && (move.slot === 'light' || move.slot === 'heavy')) {
          f.stats[move.index].uses -= 1;
          if (move.slot === 'heavy') f.stamina = Math.min(STAMINA_MAX, f.stamina + HEAVY_COST);
          this.startGrab(f);
          return;
        }
        if (f.cancel && f.buffer >= 0 && f.buffer !== GRAB_ACTION && live) {
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
          f.facing = other.x >= f.x ? 1 : -1;
          // Hold forward or back to roll out, so nobody gets trapped on the floor.
          const fwdNow = f.facing > 0 ? Button.Right : Button.Left;
          const backNow = f.facing > 0 ? Button.Left : Button.Right;
          const dir = live ? (B & fwdNow ? 1 : B & backNow ? -1 : 0) : 0;
          if (dir !== 0) {
            this.setState(f, S.roll, ROLL_FRAMES, 3);
            f.rollDir = dir;
            f.invuln = ROLL_INVULN;
            this.events.push({ type: 'roll', side: f.side, dir, x: f.x, y: f.floor });
          } else {
            this.setState(f, S.getup, GETUP_FRAMES, 0);
            f.invuln = GETUP_INVULN;
          }
        }
        return;
      case S.guardBreak:
      case S.roll:
        if (f.stun === 0) this.setState(f, S.idle, 0, 5);
        return;
      case S.thrown:
        // If the throw is interrupted (the round ended), drop.
        if (other.state !== S.throw) this.setState(f, S.launched, 0, 3);
        return;
      case S.victory: {
        const move = f.moves[f.move];
        if (move && f.moveT >= move.total) f.moveT = 0;
        return;
      }
    }
  }

  private physics(f: Fighter, other: Fighter): void {
    const fromX = f.x;
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
        if (f.y > f.floor || f.vy > 0 || f.falling) {
          const fromY = f.y;
          f.vy -= GRAVITY;
          f.x += f.vx;
          f.y = Math.max(FALL_LIMIT, f.y + f.vy);
          f.vx = fixedMul(f.vx, AIR_DRAG);
          const top = f.falling ? -1 : this.ledgeBelow(f, fromY);
          if (top >= 0) {
            f.floor = top;
            this.landed(f);
          } else if (f.y <= 0) {
            if (this.offEdge(f)) this.startFalling(f);
            else if (!f.falling) {
              f.floor = 0;
              this.landed(f);
            }
          }
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
      case S.roll:
        f.x += f.facing * f.rollDir * ROLL_SPEED;
        break;
      case S.thrown:
        this.carry(f, other);
        break;
      default:
        f.x += f.vx;
        f.vx = fixedMul(f.vx, FRICTION);
    }
    if (f.vx !== 0 && Math.abs(f.vx) < 64) f.vx = 0;
    const [lo, hi] = this.limits(f, fromX, true);
    f.x = clamp(f.x, lo, hi);
    // Walked, dashed or got knocked off the end of a ledge: nothing underfoot now.
    if (f.floor > 0 && f.state !== S.thrown && !this.onLedge(f)) this.stepOff(f);
    // Slid off a drop edge: no floor, so down they go.
    if (!f.falling && f.y <= 0 && this.offEdge(f)) {
      if (f.state !== S.ko) this.setState(f, S.launched, 0, 3);
      f.y = -1;
      this.startFalling(f);
    }
  }

  /**
   * How far a fighter may move this frame. Fighters moving on purpose stop at the edge; only being
   * hit or thrown can carry someone off a drop. A ledge's sides are walls to anyone below its top,
   * judged by which side they started the frame on, and moves and rolls stop at the end of the
   * ledge they stand on.
   */
  private limits(f: Fighter, fromX: number, dropsOpen: boolean): [number, number] {
    const pushed = dropsOpen && (PUSHED.has(f.state) || f.falling === 1);
    let lo = this.dropLeft && pushed ? -NO_LIMIT : WALL;
    let hi = this.dropRight && pushed ? this.arenaWidth + NO_LIMIT : this.arenaWidth - WALL;
    for (const ledge of this.ledges) {
      if (f.floor === ledge.top && f.floor > 0 && fromX >= ledge.x0 - LEDGE_MARGIN && fromX <= ledge.x1 + LEDGE_MARGIN) {
        if (STAY_ON_LEDGE.has(f.state)) {
          lo = Math.max(lo, ledge.x0);
          hi = Math.min(hi, ledge.x1);
        }
        continue;
      }
      if (f.y >= ledge.top) continue;
      if (fromX < (ledge.x0 + ledge.x1) >> 1) hi = Math.min(hi, ledge.x0 - LEDGE_MARGIN);
      else lo = Math.max(lo, ledge.x1 + LEDGE_MARGIN);
    }
    return [lo, Math.max(lo, hi)];
  }

  /** The top of the highest ledge a falling fighter came down on this frame, or -1. */
  private ledgeBelow(f: Fighter, fromY: number): number {
    if (f.vy > 0) return -1;
    let best = -1;
    for (const ledge of this.ledges) {
      if (fromY >= ledge.top && f.y <= ledge.top && f.x >= ledge.x0 - LEDGE_MARGIN && f.x <= ledge.x1 + LEDGE_MARGIN && ledge.top > best) best = ledge.top;
    }
    return best;
  }

  /** Still standing on the ledge at the fighter's floor height. */
  private onLedge(f: Fighter): boolean {
    for (const ledge of this.ledges) {
      if (ledge.top === f.floor && f.x >= ledge.x0 - LEDGE_MARGIN && f.x <= ledge.x1 + LEDGE_MARGIN) return true;
    }
    return false;
  }

  /** Off the end of a ledge: a hit carries on as a launch, anything else just drops. */
  private stepOff(f: Fighter): void {
    this.takeOff(f);
    f.vy = 0;
    if (f.state === S.air || f.state === S.launched || f.state === S.ko) return;
    const knocked = f.state === S.hitstun || f.state === S.stagger || f.state === S.guardBreak || f.state === S.knockdown;
    this.setState(f, knocked ? S.launched : S.air, 0, 4);
    f.jumpDir = 0;
  }

  /** Leaves the ground or a ledge: airborne until landing on whatever is below. */
  private takeOff(f: Fighter): void {
    f.y = Math.max(f.y, f.floor + 1);
    f.floor = 0;
  }

  private offEdge(f: Fighter): boolean {
    return (this.dropLeft && f.x < 0) || (this.dropRight && f.x > this.arenaWidth);
  }

  /** Past a drop edge and below the roof: there is no coming back, so the round ends now. */
  private startFalling(f: Fighter): void {
    if (f.falling) return;
    f.falling = 1;
    this.ringout(f);
  }

  private ringout(f: Fighter): void {
    if (this.phase !== PHASE.fight || this.ringoutSide >= 0) return;
    this.ringoutSide = f.side;
    this.phase = PHASE.ringout;
    this.phaseT = 0;
    this.events.push({ type: 'ringout', side: f.side, x: f.x });
  }

  /** The thrown fighter rides the throw: lifted, swung over, then slammed down in front. */
  private carry(t: Fighter, a: Fighter): void {
    const k = a.stateT;
    let dist: number;
    let height: number;
    if (k < 10) {
      const u = ratio(k, 10);
      dist = lerpFixed(toFixed(0.62), toFixed(0.38), u);
      height = fixedMul(toFixed(0.75), u);
    } else {
      const u = ratio(Math.min(k - 10, THROW_SLAM - 10), THROW_SLAM - 10);
      dist = lerpFixed(toFixed(0.38), toFixed(0.95), u);
      height = fixedMul(toFixed(0.75), ONE - fixedMul(u, u));
    }
    t.x = a.x + a.facing * dist;
    t.floor = a.floor;
    t.y = a.floor + Math.max(0, height);
    t.vx = 0;
    t.vy = 0;
  }

  /** Touched down on the floor or a ledge; `f.floor` already holds its height. */
  private landed(f: Fighter): void {
    const speed = -f.vy;
    f.y = f.floor;
    f.vy = 0;
    if (f.state === S.air) {
      const hard = speed > toFixed(0.09);
      this.setState(f, S.land, hard ? LAND_HARD_FRAMES : LAND_FRAMES, 2);
      f.vx = 0;
      this.events.push({ type: 'land', side: f.side, x: f.x, y: f.floor, hard });
    } else if (f.state === S.launched) {
      this.setState(f, S.knockdown, KNOCKDOWN_FRAMES, 4);
      f.vx = idiv(f.vx, 2);
      this.events.push({ type: 'knockdown', side: f.side, x: f.x, y: f.floor });
      this.events.push({ type: 'land', side: f.side, x: f.x, y: f.floor, hard: true });
    } else {
      f.vx = idiv(f.vx, 2);
      this.events.push({ type: 'land', side: f.side, x: f.x, y: f.floor, hard: true });
    }
  }

  /** Keeps the fighters from overlapping, sharing the push unless one is against a wall. */
  private separate(): void {
    const [a, b] = this.fighters;
    if (Math.abs(a.y - b.y) > PUSH_HEIGHT) return;
    if (a.state === S.ko || b.state === S.ko) return;
    if (a.falling || b.falling || NO_PUSH.has(a.state) || NO_PUSH.has(b.state)) return;
    const gap = b.x - a.x;
    const overlap = 2 * BODY_HALF - Math.abs(gap);
    if (overlap <= 0) return;
    const dir = gap > 0 ? 1 : gap < 0 ? -1 : a.facing;
    const half = overlap >> 1;
    // Walls, drop edges and ledge sides all hold here: a shove never pushes anyone out of the arena or into a ledge.
    const [aLo, aHi] = this.limits(a, a.x, false);
    const [bLo, bHi] = this.limits(b, b.x, false);
    a.x -= dir * half;
    b.x += dir * (overlap - half);
    if (a.x < aLo || a.x > aHi) {
      const fix = clamp(a.x, aLo, aHi) - a.x;
      a.x += fix;
      b.x += fix;
    }
    if (b.x < bLo || b.x > bHi) {
      const fix = clamp(b.x, bLo, bHi) - b.x;
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
      case S.grab:
        builtinPose(out, P.grab, t, GRAB_STARTUP, GRAB_STARTUP + GRAB_ACTIVE);
        break;
      case S.throw:
        builtinPose(out, P.throw, t, THROW_SLAM, THROW_FRAMES);
        break;
      case S.thrown:
        builtinPose(out, P.thrown, t);
        lying = true;
        break;
      case S.guardBreak:
        builtinPose(out, P.guardBreak, t);
        break;
      case S.roll:
        builtinPose(out, P.roll, t, ROLL_FRAMES, f.rollDir);
        lying = true;
        break;
      case S.ko:
        if (f.y > f.floor || f.falling) builtinPose(out, P.launched, t);
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

    // Never let the body sink into the floor or the ledge underfoot.
    if (!f.falling) {
      const low = lying ? lowestPoint(f.pose) : lowestFoot(f.pose);
      if (f.y + f.pose[ROOT_Y] + low < f.floor) f.pose[ROOT_Y] = f.floor - low - f.y;
    }
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
    if (t.invuln > 0 || t.falling || t.state === S.ko || t.state === S.knockdown || t.state === S.getup || t.state === S.thrown || t.state === S.roll) return null;
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
      t.guard = GUARD_MAX;
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
      if (t.health === 0) {
        this.knockOut(a, t, hit, a.facing * toFixed(0.9), toFixed(0.4));
        return;
      }
      t.guard -= idiv(rules.damage * 5, 2) + 40;
      t.guardWait = GUARD_WAIT;
      if (t.guard <= 0) this.guardBreak(t);
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
    const grounded = t.y <= t.floor && t.state !== S.air;
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
      this.takeOff(t);
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
    this.takeOff(t);
    this.hitstop = 20;
    this.events.push({ type: 'ko', side: t.side, x: hit.px, y: hit.py, vx: t.vx, vy: t.vy });
  }

  private detectGrabs(): void {
    const [a, b] = this.fighters;
    const ca = this.canCatch(a, b);
    const cb = this.canCatch(b, a);
    if (ca && cb) {
      // Both grabbed at once: they break apart.
      for (const f of this.fighters) {
        this.setState(f, S.stagger, 12, 2);
        f.vx = -f.facing * toFixed(0.06);
      }
      this.hitstop = 6;
      this.events.push({ type: 'clash', x: (a.x + b.x) >> 1, y: a.floor + toFixed(1.2) });
      return;
    }
    if (ca) this.catch(a, b);
    else if (cb) this.catch(b, a);
  }

  /** Strikes beat grabs (nobody is caught mid-swing); grabs beat blocks and parries. */
  private canCatch(f: Fighter, t: Fighter): boolean {
    if (f.state !== S.grab || f.stateT < GRAB_STARTUP || f.stateT >= GRAB_STARTUP + GRAB_ACTIVE) return false;
    if (Math.abs(t.x - f.x) > GRAB_RANGE || t.y > t.floor || f.y > f.floor || t.floor !== f.floor || t.invuln > 0 || t.falling) return false;
    switch (t.state) {
      case S.idle:
      case S.block:
      case S.parry:
      case S.parryWhiff:
      case S.land:
      case S.dash:
      case S.stagger:
      case S.guardBreak:
      case S.grab:
      case S.jumpsquat:
        return true;
      case S.attack: {
        const m = t.currentMove;
        return m !== null && t.moveT >= m.startup + m.active;
      }
      default:
        return false;
    }
  }

  private catch(f: Fighter, t: Fighter): void {
    this.setState(f, S.throw, 0, 2);
    this.setState(t, S.thrown, 0, 2);
    t.facing = f.facing > 0 ? -1 : 1;
    t.crouch = 0;
    t.parryT = 0;
    t.combo = 0;
    f.vx = 0;
    t.vx = 0;
    this.hitstop = 4;
    this.events.push({ type: 'grab', side: f.side, target: t.side, x: (f.x + t.x) >> 1, y: f.floor + toFixed(1.1) });
  }

  private slam(a: Fighter, t: Fighter): void {
    t.health = Math.max(0, t.health - THROW_DAMAGE);
    t.damageTaken += THROW_DAMAGE;
    a.damageDealt += THROW_DAMAGE;
    // Slammed onto whatever the thrower stands on; off the end of a ledge, they drop from there.
    t.floor = a.floor;
    t.y = a.floor;
    const ko = t.health === 0;
    this.events.push({ type: 'throw', side: a.side, target: t.side, x: t.x, y: t.floor + toFixed(0.15), damage: THROW_DAMAGE, ko });
    if (ko) {
      this.setState(t, S.ko, 0, 1);
      t.vx = a.facing * toFixed(0.11);
      t.vy = toFixed(0.06);
      this.events.push({ type: 'ko', side: t.side, x: t.x, y: t.floor + toFixed(0.3), vx: t.vx, vy: t.vy });
      this.takeOff(t);
      this.hitstop = 20;
      return;
    }
    this.hitstop = 9;
    this.setState(t, S.knockdown, KNOCKDOWN_FRAMES, 2);
    t.vx = a.facing * toFixed(0.05);
    this.events.push({ type: 'knockdown', side: t.side, x: t.x, y: t.floor });
  }

  private meters(f: Fighter): void {
    if (f.staminaWait > 0) f.staminaWait -= 1;
    else if (f.stamina < STAMINA_MAX) f.stamina = Math.min(STAMINA_MAX, f.stamina + STAMINA_REGEN);
    if (f.state === S.block) {
      f.guard -= GUARD_HOLD_DRAIN;
      f.guardWait = GUARD_WAIT;
      if (f.guard <= 0) this.guardBreak(f);
    } else if (f.state === S.blockstun) {
      f.guardWait = GUARD_WAIT;
    } else if (f.guardWait > 0) {
      f.guardWait -= 1;
    } else if (f.guard < GUARD_MAX) {
      f.guard = Math.min(GUARD_MAX, f.guard + GUARD_REGEN);
    }
  }

  private guardBreak(f: Fighter): void {
    f.guard = 0;
    f.guardWait = GUARD_BREAK_FRAMES + GUARD_WAIT;
    this.setState(f, S.guardBreak, GUARD_BREAK_FRAMES, 2);
    f.crouch = 0;
    this.hitstop = Math.max(this.hitstop, 10);
    this.events.push({ type: 'guardBreak', side: f.side, x: f.world[2 * J.neck], y: f.world[2 * J.neck + 1] });
  }

  /** Pinned against a wall or a ledge's side, so pushback goes to the attacker instead. */
  private nearWall(f: Fighter): boolean {
    const near = toFixed(0.25);
    if (f.x <= WALL + near || f.x >= this.arenaWidth - WALL - near) return true;
    for (const ledge of this.ledges) {
      if (f.y >= ledge.top) continue;
      if (Math.abs(f.x - (ledge.x0 - LEDGE_MARGIN)) <= near || Math.abs(f.x - (ledge.x1 + LEDGE_MARGIN)) <= near) return true;
    }
    return false;
  }

  private post(f: Fighter, live: boolean): void {
    f.stateT += 1;
    if (f.stun > 0) f.stun -= 1;
    if (f.invuln > 0) f.invuln -= 1;
    if (f.bufferT > 0) {
      f.bufferT -= 1;
      if (f.bufferT === 0) f.buffer = -1;
    }
    this.meters(f);
    switch (f.state) {
      case S.grab: {
        if (f.stateT === GRAB_STARTUP + GRAB_ACTIVE) {
          const other = this.fighters[1 - f.side];
          this.events.push({ type: 'whiff', side: f.side, move: -1, near: Math.abs(other.x - f.x) < GRAB_RANGE + toFixed(0.8) });
        }
        if (f.stateT >= GRAB_STARTUP + GRAB_ACTIVE + GRAB_RECOVERY) this.setState(f, S.idle, 0, 4);
        break;
      }
      case S.throw: {
        const other = this.fighters[1 - f.side];
        if (f.stateT === THROW_SLAM && other.state === S.thrown) this.slam(f, other);
        if (f.stateT >= THROW_FRAMES) this.setState(f, S.idle, 0, 4);
        break;
      }
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

/** States a hit or a throw has put someone in: only these can be carried off a drop edge. */
const PUSHED = new Set<number>([S.hitstun, S.launched, S.blockstun, S.stagger, S.knockdown, S.ko, S.thrown, S.guardBreak]);
/** States that pass through the other fighter instead of pushing. */
const NO_PUSH = new Set<number>([S.roll, S.thrown, S.throw]);
/** On a ledge, these stop at its end (like a move's root motion); walking, dashing and being hit can carry you off. */
const STAY_ON_LEDGE = new Set<number>([S.attack, S.roll, S.getup, S.land, S.jumpsquat, S.grab, S.throw, S.victory]);

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
