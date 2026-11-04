/**
 * Poses for drawing: the engine's integer poses turned into joint positions in metres. Drawing
 * may use float maths freely; nothing here feeds back into the simulation.
 */
import { A0, BONE_METRES, FK_ORDER, JOINT_COUNT, PARENT, POSE_SIZE, ROOT_X, ROOT_Y } from '../engine/skeleton.ts';

const TO_RAD = (Math.PI * 2) / 65536;
const Q16 = 1 / 65536;

/** Shortest-arc blend of two binary angles, returned in radians. */
function lerpAngleRad(a: number, b: number, t: number): number {
  let d = (b - a) % 65536;
  if (d > 32768) d -= 65536;
  if (d < -32768) d += 65536;
  return (a + d * t) * TO_RAD;
}

const worldAngle = new Float64Array(JOINT_COUNT);
const local = new Float64Array(JOINT_COUNT);

/**
 * Joint positions in metres relative to the anchor, forward = +x, for the pose between `a`
 * and `b` at t (0..1). Root values in `a` and `b` are Q16.16 metres.
 */
export function jointsBetween(a: Int32Array, b: Int32Array, t: number, out: Float32Array, angles?: Float32Array): void {
  for (let j = 0; j < JOINT_COUNT; j++) local[j] = lerpAngleRad(a[A0 + j], b[A0 + j], t);
  const rootX = (a[ROOT_X] + (b[ROOT_X] - a[ROOT_X]) * t) * Q16;
  const rootY = (a[ROOT_Y] + (b[ROOT_Y] - a[ROOT_Y]) * t) * Q16;
  for (const j of FK_ORDER) {
    const parent = PARENT[j];
    if (parent < 0) {
      worldAngle[j] = local[j];
      out[2 * j] = rootX;
      out[2 * j + 1] = rootY;
    } else {
      const angle = worldAngle[parent] + local[j];
      worldAngle[j] = angle;
      const len = BONE_METRES[j];
      out[2 * j] = out[2 * parent] + len * Math.sin(angle);
      out[2 * j + 1] = out[2 * parent + 1] + len * Math.cos(angle);
    }
    if (angles) angles[j] = worldAngle[j];
  }
}

export function joints(pose: Int32Array, out: Float32Array): void {
  jointsBetween(pose, pose, 0, out);
}

export function copyPose(from: Int32Array): Int32Array {
  const copy = new Int32Array(POSE_SIZE);
  copy.set(from);
  return copy;
}
