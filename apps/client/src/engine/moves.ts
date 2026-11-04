/**
 * Moves as the engine plays them. The recording decides how a move looks, where its hitbox
 * travels and which height it hits; the slot decides its damage and timing (product PRD,
 * "Fairness: slots set the power"). The engine time-warps each recording so its windup fills
 * the slot's startup, its active window fills the active frames, and the rest fills recovery.
 */
import { decodeFrames, FRAME_VALUES, JOINTS, type JointName, type MoveFile, type MoveSlot, type StrikeHeight } from '@sticxcape/shared';
import { mmToFixed, ONE, toFixed, wrapAngle } from './fixed.ts';
import { A0, blendPose, createPose, forwardKinematics, J, JOINT_COUNT, PARENT, POSE_SIZE, ROOT_X, ROOT_Y } from './skeleton.ts';

export interface SlotRules {
  /** Health units; a fighter has 1000 (shown as 100). */
  damage: number;
  startup: number;
  active: number;
  recovery: number;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  /** Knockback speed at contact, Q16.16 m/frame. */
  knockback: number;
  /** Can launch when the swing points upward. */
  launch: boolean;
  /** Light hits absorbed during startup and active frames. */
  armor: number;
  /** 0 light, 1 medium, 2 heavy: picks effects and sounds. */
  strength: 0 | 1 | 2;
  /** Plays at recorded speed with no hitbox (taunt, victory). */
  natural: boolean;
}

/**
 * Starting values from the product PRD's slot table, tuned so a light hit can cancel into a
 * heavy: light hit stun is 17 frames, a little longer than a heavy's 14-frame startup.
 */
export const SLOT_RULES: Readonly<Record<MoveSlot, SlotRules>> = {
  light: { damage: 50, startup: 6, active: 3, recovery: 10, hitstun: 17, blockstun: 9, hitstop: 4, knockback: toFixed(0.032), launch: false, armor: 0, strength: 0, natural: false },
  heavy: { damage: 120, startup: 14, active: 4, recovery: 24, hitstun: 22, blockstun: 13, hitstop: 8, knockback: toFixed(0.17), launch: true, armor: 1, strength: 2, natural: false },
  low: { damage: 80, startup: 10, active: 3, recovery: 18, hitstun: 18, blockstun: 11, hitstop: 6, knockback: toFixed(0.07), launch: false, armor: 0, strength: 1, natural: false },
  special: { damage: 150, startup: 18, active: 5, recovery: 30, hitstun: 26, blockstun: 16, hitstop: 10, knockback: toFixed(0.21), launch: true, armor: 1, strength: 2, natural: false },
  defense: { damage: 0, startup: 2, active: 12, recovery: 16, hitstun: 0, blockstun: 0, hitstop: 0, knockback: 0, launch: false, armor: 0, strength: 0, natural: false },
  taunt: { damage: 0, startup: 0, active: 0, recovery: 0, hitstun: 0, blockstun: 0, hitstop: 0, knockback: 0, launch: false, armor: 0, strength: 0, natural: true },
  victory: { damage: 0, startup: 0, active: 0, recovery: 0, hitstun: 0, blockstun: 0, hitstop: 0, knockback: 0, launch: false, armor: 0, strength: 0, natural: true },
};

export const HEIGHT_CODE: Readonly<Record<StrikeHeight, number>> = { high: 0, mid: 1, low: 2 };
export const HIGH = 0;
export const MID = 1;
export const LOW = 2;

export interface CompiledMove {
  index: number;
  id: string;
  name: string;
  slot: MoveSlot;
  height: number;
  rules: SlotRules;
  /** Striking joint and the joint its bone starts from. */
  limb: number;
  limbParent: number;
  hitRadius: number;
  /** Poses, POSE_SIZE values per recorded frame: root in Q16.16 m, angles as stored. */
  frames: Int32Array;
  frameCount: number;
  activeFirst: number;
  activeLast: number;
  startup: number;
  active: number;
  recovery: number;
  total: number;
  /** Furthest forward reach of the striking limb during the active window, Q16.16 m. */
  reach: number;
  /** Strikes and defense moves have a live window; taunts and victory poses don't. */
  hasHitbox: boolean;
  evasive: boolean;
}

const LIMB_RADIUS: Partial<Record<number, number>> = {
  [J.lWrist]: toFixed(0.075),
  [J.rWrist]: toFixed(0.075),
  [J.lAnkle]: toFixed(0.08),
  [J.rAnkle]: toFixed(0.08),
  [J.lToe]: toFixed(0.08),
  [J.rToe]: toFixed(0.08),
  [J.lKnee]: toFixed(0.09),
  [J.rKnee]: toFixed(0.09),
  [J.lElbow]: toFixed(0.08),
  [J.rElbow]: toFixed(0.08),
  [J.head]: toFixed(0.11),
};

/** Natural-speed moves play at least this long and at most this long. */
const NATURAL_MIN = 30;
const NATURAL_MAX = 180;

export function compileMove(file: MoveFile, index: number): CompiledMove {
  const values = decodeFrames(file.frames);
  if (!values) throw new Error(`Move ${file.id} has bad frames`);
  const frameCount = values.length / FRAME_VALUES;
  const frames = new Int32Array(frameCount * POSE_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const src = f * FRAME_VALUES;
    const dst = f * POSE_SIZE;
    frames[dst + ROOT_X] = mmToFixed(values[src]);
    frames[dst + ROOT_Y] = mmToFixed(values[src + 1]);
    for (let j = 0; j < JOINT_COUNT; j++) frames[dst + A0 + j] = wrapAngle(values[src + 2 + j]);
  }
  const rules = SLOT_RULES[file.slot];
  let limb = JOINTS.indexOf(file.limb as JointName);
  if (limb < 0 || limb === J.pelvis || limb === J.neck) limb = J.rWrist;
  const activeFirst = Math.min(file.active[0], frameCount - 1);
  const activeLast = Math.max(activeFirst, Math.min(file.active[1], frameCount - 1));

  let startup = rules.startup;
  let active = rules.active;
  let recovery = rules.recovery;
  if (rules.natural) {
    startup = 0;
    active = 0;
    recovery = Math.max(NATURAL_MIN, Math.min(NATURAL_MAX, frameCount));
  } else if (file.slot === 'defense') {
    // The evasive window keeps close to its recorded length.
    active = Math.max(8, Math.min(16, activeLast - activeFirst + 1));
  }

  const move: CompiledMove = {
    index,
    id: file.id,
    name: file.name,
    slot: file.slot,
    height: HEIGHT_CODE[file.height],
    rules,
    limb,
    limbParent: PARENT[limb] < 0 ? J.pelvis : PARENT[limb],
    hitRadius: LIMB_RADIUS[limb] ?? toFixed(0.075),
    frames,
    frameCount,
    activeFirst,
    activeLast,
    startup,
    active,
    recovery,
    total: startup + active + recovery,
    reach: 0,
    hasHitbox: !rules.natural && file.slot !== 'defense',
    evasive: file.slot === 'defense',
  };
  move.reach = measureReach(move);
  return move;
}

const reachPose = createPose();
const reachJoints = new Int32Array(JOINT_COUNT * 2);

function measureReach(move: CompiledMove): number {
  if (!move.hasHitbox) return 0;
  let best = 0;
  for (let f = move.activeFirst; f <= move.activeLast; f++) {
    reachPose.set(move.frames.subarray(f * POSE_SIZE, (f + 1) * POSE_SIZE));
    forwardKinematics(reachPose, reachJoints);
    best = Math.max(best, reachJoints[2 * move.limb] + move.hitRadius);
  }
  return best;
}

/** The recorded frame (Q16.16) to show `t` frames into the move. */
export function recordedFrame(move: CompiledMove, t: number): number {
  const last = (move.frameCount - 1) * ONE;
  if (move.rules.natural) {
    const span = move.recovery;
    const r = Math.trunc((Math.min(t, span) * (move.frameCount - 1) * ONE) / Math.max(1, span));
    return Math.min(r, last);
  }
  const f0 = move.activeFirst;
  const f1 = Math.min(move.activeLast + 1, move.frameCount - 1);
  let r: number;
  if (t < move.startup) {
    r = Math.trunc((t * f0 * ONE) / move.startup);
  } else if (t < move.startup + move.active) {
    r = f0 * ONE + Math.trunc(((t - move.startup) * (f1 - f0) * ONE) / move.active);
  } else {
    const into = t - move.startup - move.active;
    r = f1 * ONE + Math.trunc((into * (move.frameCount - 1 - f1) * ONE) / Math.max(1, move.recovery));
  }
  return Math.max(0, Math.min(r, last));
}

const sampleA = createPose();
const sampleB = createPose();

/** Writes the move's pose at recorded frame r16 (Q16.16), blending neighbouring frames. */
export function sampleMove(move: CompiledMove, r16: number, out: Int32Array): void {
  const i = Math.floor(r16 / ONE);
  const frac = r16 - i * ONE;
  const a = Math.min(i, move.frameCount - 1);
  const b = Math.min(i + 1, move.frameCount - 1);
  sampleA.set(move.frames.subarray(a * POSE_SIZE, (a + 1) * POSE_SIZE));
  if (frac === 0 || a === b) {
    out.set(sampleA);
    return;
  }
  sampleB.set(move.frames.subarray(b * POSE_SIZE, (b + 1) * POSE_SIZE));
  blendPose(sampleA, sampleB, frac, out);
}

/** True while t is in the move's live window. */
export function isActiveFrame(move: CompiledMove, t: number): boolean {
  return t >= move.startup && t < move.startup + move.active;
}
