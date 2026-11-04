/**
 * The standard stick man: 17 joints, fixed bone lengths, and forward kinematics in fixed point.
 *
 * A pose is 19 integers, the same layout as a frame in a move file:
 *   [0] root x: the pelvis's forward offset (Q16.16 m in the engine, mm in files)
 *   [1] root y: the pelvis's height above the fighter's feet line
 *   [2 + j] the local angle of joint j (binary units, 65536 a turn), in JOINTS order.
 *
 * Joint j's angle turns the bone that ends at j, relative to its parent bone. The pelvis angle
 * is the whole body's rotation. World angle 0 points straight up and a quarter turn points
 * forward, so a bone at world angle a points along (sin a, cos a). Poses always face forward
 * (+x); a fighter facing left is mirrored when placed in the world.
 */
import { deg, fixedCos, fixedMul, fixedSin, HALF_TURN, toFixed, wrapAngle } from './fixed.ts';

export const J = {
  head: 0,
  neck: 1,
  pelvis: 2,
  lShoulder: 3,
  lElbow: 4,
  lWrist: 5,
  rShoulder: 6,
  rElbow: 7,
  rWrist: 8,
  lHip: 9,
  lKnee: 10,
  lAnkle: 11,
  lToe: 12,
  rHip: 13,
  rKnee: 14,
  rAnkle: 15,
  rToe: 16,
} as const;

export const JOINT_COUNT = 17;
export const POSE_SIZE = 19;
export const ROOT_X = 0;
export const ROOT_Y = 1;
export const A0 = 2;

/** Parent of each joint (the joint its bone starts from); -1 for the pelvis. */
export const PARENT = [1, 2, -1, 1, 3, 4, 1, 6, 7, 2, 9, 10, 11, 2, 13, 14, 15] as const;

/** Parents before children. */
export const FK_ORDER = [2, 1, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/** Bone lengths in metres, for the bone ending at each joint. Same body for everyone. */
export const BONE_METRES = [0.2, 0.5, 0, 0.03, 0.28, 0.26, 0.03, 0.28, 0.26, 0.03, 0.44, 0.43, 0.14, 0.03, 0.44, 0.43, 0.14] as const;
export const BONE = BONE_METRES.map((m) => toFixed(m));

/** Joints whose bones are drawn, as [from, to] pairs (shoulders and hips sit on the spine). */
export const BONES: readonly (readonly [number, number])[] = [
  [J.pelvis, J.neck],
  [J.neck, J.head],
  [J.lShoulder, J.lElbow],
  [J.lElbow, J.lWrist],
  [J.rShoulder, J.rElbow],
  [J.rElbow, J.rWrist],
  [J.lHip, J.lKnee],
  [J.lKnee, J.lAnkle],
  [J.lAnkle, J.lToe],
  [J.rHip, J.rKnee],
  [J.rKnee, J.rAnkle],
  [J.rAnkle, J.rToe],
];

/** The default shoulder and hip angles: hanging straight down from the spine and the pelvis. */
export const SHOULDER_LOCAL = HALF_TURN;
export const HIP_LOCAL = HALF_TURN;

export const LIMB_TIPS = [J.lWrist, J.rWrist, J.lAnkle, J.rAnkle, J.lToe, J.rToe, J.lKnee, J.rKnee, J.lElbow, J.rElbow, J.head] as const;

export function createPose(): Int32Array {
  return new Int32Array(POSE_SIZE);
}

/**
 * Joint positions relative to the fighter's anchor, forward = +x: out[2j], out[2j+1] in Q16.16 m.
 * `world` receives each joint's world angle when given.
 */
export function forwardKinematics(pose: Int32Array, out: Int32Array, world: Int32Array = scratchWorld): void {
  for (const j of FK_ORDER) {
    const parent = PARENT[j];
    if (parent < 0) {
      world[j] = pose[A0 + j];
      out[2 * j] = pose[ROOT_X];
      out[2 * j + 1] = pose[ROOT_Y];
      continue;
    }
    const angle = wrapAngle(world[parent] + pose[A0 + j]);
    world[j] = angle;
    const len = BONE[j];
    out[2 * j] = out[2 * parent] + fixedMul(len, fixedSin(angle));
    out[2 * j + 1] = out[2 * parent + 1] + fixedMul(len, fixedCos(angle));
  }
}

const scratchWorld = new Int32Array(JOINT_COUNT);
const scratchJoints = new Int32Array(JOINT_COUNT * 2);

/** Lowest point of the feet (ankles and toes) relative to the root, Q16.16. */
export function lowestFoot(pose: Int32Array): number {
  forwardKinematics(pose, scratchJoints);
  let low = scratchJoints[2 * J.lAnkle + 1];
  for (const j of [J.rAnkle, J.lToe, J.rToe]) low = Math.min(low, scratchJoints[2 * j + 1]);
  return low - pose[ROOT_Y];
}

/** Lowest point of any joint relative to the root, allowing for the head's radius. */
export function lowestPoint(pose: Int32Array): number {
  forwardKinematics(pose, scratchJoints);
  let low = scratchJoints[1];
  for (let j = 0; j < JOINT_COUNT; j++) {
    const y = scratchJoints[2 * j + 1] - (j === J.head ? HEAD_RADIUS : j === J.pelvis ? PELVIS_PAD : 0);
    if (y < low) low = y;
  }
  return low - pose[ROOT_Y];
}

export const HEAD_RADIUS = toFixed(0.11);
const PELVIS_PAD = toFixed(0.06);

/** Sets root y so the lowest foot rests on the floor (plus `lift`). */
export function groundPose(pose: Int32Array, lift = 0): void {
  pose[ROOT_Y] = -lowestFoot(pose) + lift;
}

/** Sets root y so the lowest part of the body rests on the floor, for lying poses. */
export function groundBody(pose: Int32Array): void {
  pose[ROOT_Y] = -lowestPoint(pose);
}

/**
 * A pose described with world angles in degrees (0 = up, 90 = forward), turned into the local
 * angles a pose stores. Used for the built-in stances and the default moveset.
 */
export interface PoseSpec {
  /** Whole-body rotation. */
  rot?: number;
  spine: number;
  head: number;
  lUp: number;
  lFore: number;
  rUp: number;
  rFore: number;
  lThigh: number;
  lShin: number;
  lFoot: number;
  rThigh: number;
  rShin: number;
  rFoot: number;
  /** Forward offset of the pelvis, metres. */
  x?: number;
  /** Height above resting on the floor, metres. */
  lift?: number;
  /** Rest on the lowest body part instead of the feet (lying down). */
  lying?: boolean;
}

export function poseFromSpec(spec: PoseSpec): Int32Array {
  const pose = createPose();
  const rot = deg(spec.rot ?? 0);
  const spine = deg(spec.spine);
  const shoulderWorld = spine + SHOULDER_LOCAL;
  const hipWorld = rot + HIP_LOCAL;
  const set = (joint: number, world: number, parentWorld: number) => (pose[A0 + joint] = wrapAngle(world - parentWorld));
  pose[A0 + J.pelvis] = wrapAngle(rot);
  set(J.neck, spine, rot);
  set(J.head, deg(spec.head), spine);
  set(J.lElbow, deg(spec.lUp), shoulderWorld);
  set(J.lWrist, deg(spec.lFore), deg(spec.lUp));
  set(J.rElbow, deg(spec.rUp), shoulderWorld);
  set(J.rWrist, deg(spec.rFore), deg(spec.rUp));
  pose[A0 + J.lHip] = wrapAngle(HIP_LOCAL);
  pose[A0 + J.rHip] = wrapAngle(HIP_LOCAL);
  set(J.lKnee, deg(spec.lThigh), hipWorld);
  set(J.lAnkle, deg(spec.lShin), deg(spec.lThigh));
  set(J.lToe, deg(spec.lFoot), deg(spec.lShin));
  set(J.rKnee, deg(spec.rThigh), hipWorld);
  set(J.rAnkle, deg(spec.rShin), deg(spec.rThigh));
  set(J.rToe, deg(spec.rFoot), deg(spec.rShin));
  pose[A0 + J.lShoulder] = wrapAngle(SHOULDER_LOCAL);
  pose[A0 + J.rShoulder] = wrapAngle(SHOULDER_LOCAL);
  pose[ROOT_X] = toFixed(spec.x ?? 0);
  if (spec.lying) groundBody(pose);
  else groundPose(pose, toFixed(spec.lift ?? 0));
  return pose;
}

/** Copies a pose. */
export function copyPose(from: Int32Array, to: Int32Array): void {
  to.set(from);
}

/** out = blend of a and b by t (0..ONE), shortest arc for angles. */
export function blendPose(a: Int32Array, b: Int32Array, t: number, out: Int32Array): void {
  out[ROOT_X] = a[ROOT_X] + Math.floor(((b[ROOT_X] - a[ROOT_X]) * t) / 65536);
  out[ROOT_Y] = a[ROOT_Y] + Math.floor(((b[ROOT_Y] - a[ROOT_Y]) * t) / 65536);
  for (let i = A0; i < POSE_SIZE; i++) {
    const d = wrapAngle(b[i] - a[i]);
    out[i] = wrapAngle(a[i] + Math.floor((d * t) / 65536));
  }
}
