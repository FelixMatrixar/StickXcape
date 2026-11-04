/**
 * Cleanup (MS-3, MS-4): raw tracking in, a game-ready move out. No raw capture ever reaches a
 * fight. In order:
 *
 *   1. Map MediaPipe's 33 points to the 17-joint stick man.
 *   2. Resample to 60 frames a second, filling hidden joints from neighbouring frames.
 *   3. Turn the clip to face forward, and scale it by the torso.
 *   4. Measure bone angles and smooth them per joint: strong on the torso, light on fists and
 *      feet so strikes stay sharp.
 *   5. Retarget onto the standard skeleton (fixed bone lengths), rest the feet on the floor and
 *      lock planted feet so they don't slide.
 *   6. Cap limb speed, trim to the motion, and start and end at the fighting stance.
 *   7. Find the striking limb, its active frames and the height it lands at.
 *
 * This runs once per capture on the phone, so it may use float maths: what it produces is
 * integers in a move file, and both phones fight with the same file.
 */
import { encodeFrames, FRAME_VALUES, JOINTS, MOVE_FORMAT_VERSION, MOVE_MAX_FRAMES, type JointName, type MoveSlot, type StrikeHeight, type UnhashedMove } from '@sticxcape/shared';
import { builtinPose, P } from '../engine/poses.ts';
import { A0, BONE_METRES, createPose, FK_ORDER, J, JOINT_COUNT, PARENT, POSE_SIZE } from '../engine/skeleton.ts';
import type { PoseFrame } from '../capture/tracker.ts';

const TAU = Math.PI * 2;
const FRAME = 1000 / 60;

/** MediaPipe landmark indices for each stick-man joint ([a, b] are averaged). */
const SOURCE: Record<number, number[]> = {
  [J.head]: [0, 7, 8],
  [J.neck]: [11, 12],
  [J.pelvis]: [23, 24],
  [J.lShoulder]: [11],
  [J.lElbow]: [13],
  [J.lWrist]: [15, 19],
  [J.rShoulder]: [12],
  [J.rElbow]: [14],
  [J.rWrist]: [16, 20],
  [J.lHip]: [23],
  [J.lKnee]: [25],
  [J.lAnkle]: [27],
  [J.lToe]: [31],
  [J.rHip]: [24],
  [J.rKnee]: [26],
  [J.rAnkle]: [28],
  [J.rToe]: [32],
};

const LEFT_RIGHT: [number, number][] = [
  [J.lShoulder, J.rShoulder],
  [J.lElbow, J.rElbow],
  [J.lWrist, J.rWrist],
  [J.lHip, J.rHip],
  [J.lKnee, J.rKnee],
  [J.lAnkle, J.rAnkle],
  [J.lToe, J.rToe],
];

/** Bones whose angle is measured from the capture: [joint, from, to, smoothing sigma in frames]. */
const MEASURED: [number, number, number, number][] = [
  [J.neck, J.pelvis, J.neck, 2.6],
  [J.head, J.neck, J.head, 2.2],
  [J.lElbow, J.lShoulder, J.lElbow, 1.4],
  [J.lWrist, J.lElbow, J.lWrist, 0.9],
  [J.rElbow, J.rShoulder, J.rElbow, 1.4],
  [J.rWrist, J.rElbow, J.rWrist, 0.9],
  [J.lKnee, J.lHip, J.lKnee, 1.5],
  [J.lAnkle, J.lKnee, J.lAnkle, 1.1],
  [J.lToe, J.lAnkle, J.lToe, 1.6],
  [J.rKnee, J.rHip, J.rKnee, 1.5],
  [J.rAnkle, J.rKnee, J.rAnkle, 1.1],
  [J.rToe, J.rAnkle, J.rToe, 1.6],
];

const SPEED_CAP = 17; // m/s at a fist or foot
const STANCE_IN = 5;
const STANCE_OUT = 8;

/** A float pose: root x, root y in metres, then 17 local angles in radians. */
export type FloatPose = Float64Array;

export interface CleanCapture {
  frames: FloatPose[];
  /** Frames to keep by default, inclusive. */
  trim: [number, number];
  /** 0..1, higher is smoother. */
  quality: number;
  /** Mean leftover jitter in degrees, for retake tips. */
  jitter: number;
  /** Frames the physics check had to correct (MS-10). */
  corrected: number;
}

export interface CleanOptions {
  /** Performed at half speed, to be played at full speed within the speed cap (safer for kicks). */
  halfSpeed?: boolean;
}

export interface MoveInfo {
  limb: JointName;
  height: StrikeHeight;
  active: [number, number];
  /** Peak speed of the striking limb, m/s. */
  peakSpeed: number;
  /** Frame of the strike's peak, for keyframes. */
  peak: number;
}

export class CleanupError extends Error {}

// Step 1–2: joints per frame, resampled to 60 fps.

interface JointTrack {
  /** x, y per joint per frame, in image units (x scaled by aspect, y up). */
  xy: Float64Array;
  vis: Float64Array;
  count: number;
}

function mapFrame(points: Float32Array, aspect: number, out: Float64Array, vis: Float64Array, offset: number): void {
  for (let j = 0; j < JOINT_COUNT; j++) {
    let x = 0;
    let y = 0;
    let w = 0;
    let v = 1;
    for (const index of SOURCE[j]) {
      const visibility = points[index * 4 + 3];
      // The head averages whichever of nose and ears are visible.
      if (j === J.head && visibility < 0.35) continue;
      const weight = j === J.lWrist || j === J.rWrist ? (index === 15 || index === 16 ? 0.7 : 0.3) : 1;
      x += points[index * 4] * aspect * weight;
      y += -points[index * 4 + 1] * weight;
      w += weight;
      v = Math.min(v, visibility);
    }
    if (w === 0) {
      x = points[0] * aspect;
      y = -points[1];
      w = 1;
      v = points[3];
    }
    out[offset + 2 * j] = x / w;
    out[offset + 2 * j + 1] = y / w;
    vis[offset / 2 + j] = v;
  }
}

function resample(raw: PoseFrame[], aspect: number): JointTrack {
  const n = raw.length;
  const xy = new Float64Array(n * JOINT_COUNT * 2);
  const vis = new Float64Array(n * JOINT_COUNT);
  for (let i = 0; i < n; i++) mapFrame(raw[i].points, aspect, xy, vis, i * JOINT_COUNT * 2);
  const t0 = raw[0].t;
  const duration = raw[n - 1].t - t0;
  const count = Math.min(MOVE_MAX_FRAMES * 2, Math.floor(duration / FRAME) + 1);
  const outXY = new Float64Array(count * JOINT_COUNT * 2);
  const outVis = new Float64Array(count * JOINT_COUNT);
  for (let j = 0; j < JOINT_COUNT; j++) {
    // Visible samples only; hidden joints are filled from the frames around them.
    const times: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      if (vis[i * JOINT_COUNT + j] < 0.35 && !(j === J.pelvis || j === J.neck)) continue;
      times.push(raw[i].t - t0);
      xs.push(xy[i * JOINT_COUNT * 2 + 2 * j]);
      ys.push(xy[i * JOINT_COUNT * 2 + 2 * j + 1]);
    }
    if (times.length === 0) {
      for (let i = 0; i < n; i++) {
        times.push(raw[i].t - t0);
        xs.push(xy[i * JOINT_COUNT * 2 + 2 * j]);
        ys.push(xy[i * JOINT_COUNT * 2 + 2 * j + 1]);
      }
    }
    let k = 0;
    for (let f = 0; f < count; f++) {
      const t = f * FRAME;
      while (k < times.length - 2 && times[k + 1] < t) k++;
      const ta = times[k];
      const tb = times[Math.min(k + 1, times.length - 1)];
      const u = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
      outXY[f * JOINT_COUNT * 2 + 2 * j] = xs[k] + (xs[Math.min(k + 1, xs.length - 1)] - xs[k]) * u;
      outXY[f * JOINT_COUNT * 2 + 2 * j + 1] = ys[k] + (ys[Math.min(k + 1, ys.length - 1)] - ys[k]) * u;
      outVis[f * JOINT_COUNT + j] = 1;
    }
  }
  return { xy: outXY, vis: outVis, count };
}

// Helpers.

const at = (track: JointTrack, f: number, j: number) => f * JOINT_COUNT * 2 + 2 * j;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 0;
}

/** Zero-phase Gaussian smoothing of a series. */
function gaussian(values: Float64Array, sigma: number): Float64Array {
  if (sigma <= 0.01) return values.slice();
  const radius = Math.ceil(sigma * 2.5);
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = Math.max(0, Math.min(values.length - 1, i + k));
      acc += values[idx] * kernel[k + radius];
    }
    out[i] = acc / sum;
  }
  return out;
}

function unwrap(values: Float64Array): void {
  for (let i = 1; i < values.length; i++) {
    let d = values[i] - values[i - 1];
    while (d > Math.PI) {
      values[i] -= TAU;
      d -= TAU;
    }
    while (d < -Math.PI) {
      values[i] += TAU;
      d += TAU;
    }
  }
}

/** Joint positions (metres, relative to the root) for a float pose. */
export function floatJoints(pose: FloatPose, out: Float64Array): void {
  const world = new Float64Array(JOINT_COUNT);
  for (const j of FK_ORDER) {
    const parent = PARENT[j];
    if (parent < 0) {
      world[j] = pose[A0 + j];
      out[2 * j] = pose[0];
      out[2 * j + 1] = pose[1];
      continue;
    }
    const angle = world[parent] + pose[A0 + j];
    world[j] = angle;
    out[2 * j] = out[2 * parent] + BONE_METRES[j] * Math.sin(angle);
    out[2 * j + 1] = out[2 * parent + 1] + BONE_METRES[j] * Math.cos(angle);
  }
}

function stanceFloat(): FloatPose {
  const pose = createPose();
  builtinPose(pose, P.stance, 0);
  const out = new Float64Array(POSE_SIZE);
  out[0] = 0;
  out[1] = pose[1] / 65536;
  for (let j = 0; j < JOINT_COUNT; j++) out[A0 + j] = (pose[A0 + j] / 65536) * TAU;
  return out;
}

function lerpPose(a: FloatPose, b: FloatPose, t: number): FloatPose {
  const out = new Float64Array(POSE_SIZE);
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  for (let i = A0; i < POSE_SIZE; i++) {
    let d = (b[i] - a[i]) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    out[i] = a[i] + d * t;
  }
  return out;
}

/** Lowest foot point relative to the root, metres. */
function lowestFootF(pose: FloatPose, scratch: Float64Array): number {
  floatJoints(pose, scratch);
  return Math.min(scratch[2 * J.lAnkle + 1], scratch[2 * J.rAnkle + 1], scratch[2 * J.lToe + 1], scratch[2 * J.rToe + 1]) - pose[1];
}

// The pipeline.

/** Cleans a capture. `aspect` is the video's width over its height. */
export function cleanCapture(raw: PoseFrame[], aspect: number, options: CleanOptions = {}): CleanCapture {
  const usable = raw.filter((frame) => frame.points.length >= 33 * 4);
  if (usable.length < 12) throw new CleanupError('Not enough of you was tracked. Step back so your whole body is in frame.');
  let track = resample(usable, aspect);
  if (options.halfSpeed) track = speedUp(track, 2);
  const n = track.count;
  if (n < 20) throw new CleanupError('That take was too short. Try again and keep moving for a second or two.');

  // Step 3: which way the player faces, and how big they are.
  const facingVotes: number[] = [];
  const torso: number[] = [];
  for (let f = 0; f < n; f++) {
    const p = track.xy;
    const head = at(track, f, J.head);
    const neck = at(track, f, J.neck);
    const pelvis = at(track, f, J.pelvis);
    const toes = (p[at(track, f, J.lToe)] + p[at(track, f, J.rToe)]) / 2;
    const ankles = (p[at(track, f, J.lAnkle)] + p[at(track, f, J.rAnkle)]) / 2;
    facingVotes.push(Math.sign(toes - ankles) * 2 + Math.sign(usableNoseLead(usable, f, n)));
    torso.push(Math.hypot(p[neck] - p[pelvis], p[neck + 1] - p[pelvis + 1]));
    void head;
  }
  const facing = median(facingVotes) >= 0 ? 1 : -1;
  const scale = 0.5 / Math.max(0.02, median(torso));
  if (facing < 0) {
    // Mirror the clip so it faces forward. Anatomical sides stay as they are, so an orthodox
    // stance stays orthodox whichever way the player faced the phone.
    for (let f = 0; f < n; f++) for (let j = 0; j < JOINT_COUNT; j++) track.xy[at(track, f, j)] *= -1;
  }
  fixSideSwaps(track);

  // Into metres, with the floor at the lowest the feet go.
  const footLows: number[] = [];
  for (let f = 0; f < n; f++) {
    footLows.push(Math.min(...[J.lAnkle, J.rAnkle, J.lToe, J.rToe].map((j) => track.xy[at(track, f, j) + 1])));
  }
  const floor = percentile(footLows, 0.08);
  const x0 = track.xy[at(track, 0, J.pelvis)];
  const metres = new Float64Array(track.xy.length);
  for (let f = 0; f < n; f++) {
    for (let j = 0; j < JOINT_COUNT; j++) {
      const i = at(track, f, j);
      metres[i] = (track.xy[i] - x0) * scale;
      metres[i + 1] = (track.xy[i + 1] - floor) * scale;
    }
  }

  // Step 4: bone angles, unwrapped and smoothed per joint.
  const raw4: Float64Array[] = [];
  const smooth: Float64Array[] = [];
  let jitterSum = 0;
  let jitterCount = 0;
  for (const [, from, to, sigma] of MEASURED) {
    const series = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      const a = at(track, f, from);
      const b = at(track, f, to);
      series[f] = Math.atan2(metres[b] - metres[a], metres[b + 1] - metres[a + 1]);
    }
    unwrap(series);
    const smoothed = gaussian(series, sigma);
    for (let f = 0; f < n; f++) {
      jitterSum += Math.abs(series[f] - smoothed[f]);
      jitterCount += 1;
    }
    raw4.push(series);
    smooth.push(smoothed);
  }
  const jitterDeg = (jitterSum / Math.max(1, jitterCount)) * (180 / Math.PI);
  const quality = Math.max(0, Math.min(1, 1 - (jitterDeg - 0.6) / 6));

  const pelvisX = new Float64Array(n);
  const footHeight = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    pelvisX[f] = metres[at(track, f, J.pelvis)];
    footHeight[f] = Math.max(0, Math.min(...[J.lAnkle, J.rAnkle, J.lToe, J.rToe].map((j) => metres[at(track, f, j) + 1])));
  }
  const pelvisXs = gaussian(pelvisX, 2.2);
  const footHs = gaussian(footHeight, 1.6);

  // Step 5: local angles on the standard skeleton.
  const angleOf = (joint: number, f: number) => smooth[MEASURED.findIndex((m) => m[0] === joint)][f];
  let frames: FloatPose[] = [];
  const scratch = new Float64Array(JOINT_COUNT * 2);
  for (let f = 0; f < n; f++) {
    const pose = new Float64Array(POSE_SIZE);
    const spine = angleOf(J.neck, f);
    pose[A0 + J.pelvis] = 0;
    pose[A0 + J.neck] = spine;
    pose[A0 + J.head] = angleOf(J.head, f) - spine;
    for (const side of ['l', 'r'] as const) {
      const up = angleOf(side === 'l' ? J.lElbow : J.rElbow, f);
      const fore = angleOf(side === 'l' ? J.lWrist : J.rWrist, f);
      const thigh = angleOf(side === 'l' ? J.lKnee : J.rKnee, f);
      const shin = angleOf(side === 'l' ? J.lAnkle : J.rAnkle, f);
      const foot = angleOf(side === 'l' ? J.lToe : J.rToe, f);
      const [shoulder, elbow, wrist, hip, knee, ankle, toe] =
        side === 'l' ? [J.lShoulder, J.lElbow, J.lWrist, J.lHip, J.lKnee, J.lAnkle, J.lToe] : [J.rShoulder, J.rElbow, J.rWrist, J.rHip, J.rKnee, J.rAnkle, J.rToe];
      pose[A0 + shoulder] = Math.PI;
      pose[A0 + elbow] = up - (spine + Math.PI);
      pose[A0 + wrist] = fore - up;
      pose[A0 + hip] = Math.PI;
      pose[A0 + knee] = thigh - Math.PI;
      pose[A0 + ankle] = shin - thigh;
      pose[A0 + toe] = foot - shin;
    }
    pose[0] = pelvisXs[f];
    // Feet on the floor, keeping real jumps.
    pose[1] = 0;
    pose[1] = -lowestFootF(pose, scratch) + Math.max(0, footHs[f] - 0.03);
    frames.push(pose);
  }

  // Foot locking: a planted foot stays where it landed.
  // Physics check (MS-10): no joint bends past what a body can do.
  const corrected = clampJoints(frames, scratch);
  lockFeet(frames, footHs);

  // Step 6: speed cap, then auto-trim to the motion.
  frames = capSpeed(frames);
  const trim = autoTrim(frames);
  return { frames, trim, quality, jitter: jitterDeg, corrected };
}

const ARM_CHAINS: [number[], number[]] = [
  [J.lElbow, J.lWrist],
  [J.rElbow, J.rWrist],
];
const LEG_CHAINS: [number[], number[]] = [
  [J.lKnee, J.lAnkle, J.lToe],
  [J.rKnee, J.rAnkle, J.rToe],
];

/**
 * Side-on, the tracker sometimes trades the left and right limbs for a frame or two. Whenever
 * swapping a pair of limbs back lines them up better with the frame before, swap them.
 */
function fixSideSwaps(track: JointTrack): void {
  const p = track.xy;
  for (const [left, right] of [ARM_CHAINS, LEG_CHAINS]) {
    for (let f = 1; f < track.count; f++) {
      let keep = 0;
      let swap = 0;
      for (let i = 0; i < left.length; i++) {
        const l = at(track, f, left[i]);
        const r = at(track, f, right[i]);
        const pl = at(track, f - 1, left[i]);
        const pr = at(track, f - 1, right[i]);
        keep += Math.hypot(p[l] - p[pl], p[l + 1] - p[pl + 1]) + Math.hypot(p[r] - p[pr], p[r + 1] - p[pr + 1]);
        swap += Math.hypot(p[r] - p[pl], p[r + 1] - p[pl + 1]) + Math.hypot(p[l] - p[pr], p[l + 1] - p[pr + 1]);
      }
      if (swap < keep * 0.6) {
        for (let i = 0; i < left.length; i++) {
          const l = at(track, f, left[i]);
          const r = at(track, f, right[i]);
          const lx = p[l];
          const ly = p[l + 1];
          p[l] = p[r];
          p[l + 1] = p[r + 1];
          p[r] = lx;
          p[r + 1] = ly;
        }
      }
    }
  }
}

/** Plays a track faster: a half-speed take becomes full speed. The speed cap still applies after. */
function speedUp(track: JointTrack, factor: number): JointTrack {
  const count = Math.max(2, Math.floor((track.count - 1) / factor) + 1);
  const xy = new Float64Array(count * JOINT_COUNT * 2);
  const vis = new Float64Array(count * JOINT_COUNT);
  for (let f = 0; f < count; f++) {
    const src = Math.min(track.count - 1, f * factor);
    xy.set(track.xy.subarray(src * JOINT_COUNT * 2, (src + 1) * JOINT_COUNT * 2), f * JOINT_COUNT * 2);
    vis.set(track.vis.subarray(src * JOINT_COUNT, (src + 1) * JOINT_COUNT), f * JOINT_COUNT);
  }
  return { xy, vis, count };
}

const RAD = Math.PI / 180;
/** Joint limits in degrees for local angles: [joint, min, max]. Generous, because a side-on 2D view can make a real bend look odd. */
const LIMITS: [number, number, number][] = [
  [J.lAnkle, -25, 165],
  [J.rAnkle, -25, 165],
  [J.lWrist, -170, 30],
  [J.rWrist, -170, 30],
  [J.lToe, -150, -15],
  [J.rToe, -150, -15],
  [J.head, -80, 80],
];
/** Hip: the thigh's angle from the spine, 15° (folded) to 235° (leg swept back). */
const HIP_MIN = 15 * RAD;
const HIP_MAX = 235 * RAD;

function wrapPi(a: number): number {
  return a - Math.round(a / TAU) * TAU;
}

/** Clamps joints past human limits; returns how many frames needed it. */
function clampJoints(frames: FloatPose[], scratch: Float64Array): number {
  let fixed = 0;
  for (const pose of frames) {
    let changed = false;
    for (const [joint, lo, hi] of LIMITS) {
      const a = wrapPi(pose[A0 + joint]);
      const c = Math.max(lo * RAD, Math.min(hi * RAD, a));
      if (Math.abs(c - a) > 0.5 * RAD) changed = true;
      pose[A0 + joint] = c;
    }
    for (const knee of [J.lKnee, J.rKnee]) {
      const spine = pose[A0 + J.neck] + pose[A0 + J.pelvis];
      const thigh = pose[A0 + J.pelvis] + pose[A0 + (knee === J.lKnee ? J.lHip : J.rHip)] + pose[A0 + knee];
      let d = (thigh - spine) % TAU;
      if (d < 0) d += TAU;
      if (d >= HIP_MIN && d <= HIP_MAX) continue;
      const target = d > HIP_MAX && d < HIP_MAX + (TAU - HIP_MAX + HIP_MIN) / 2 ? HIP_MAX : HIP_MIN;
      pose[A0 + knee] += target - d;
      changed = true;
    }
    if (changed) {
      fixed += 1;
      // The feet may have moved: keep them on the floor.
      const low = lowestFootF(pose, scratch);
      if (pose[1] + low < 0) pose[1] = -low;
    }
  }
  return fixed;
}

/** Which way the nose points relative to the ears, per frame (for facing). */
function usableNoseLead(raw: PoseFrame[], f: number, n: number): number {
  const i = Math.min(raw.length - 1, Math.floor((f / Math.max(1, n - 1)) * (raw.length - 1)));
  const p = raw[i].points;
  const earX = p[7 * 4 + 3] > p[8 * 4 + 3] ? p[7 * 4] : p[8 * 4];
  return p[0] - earX;
}

function lockFeet(frames: FloatPose[], footHeight: Float64Array): void {
  const scratch = new Float64Array(JOINT_COUNT * 2);
  let lockFoot = -1;
  let lockX = 0;
  let offset = 0;
  for (let f = 0; f < frames.length; f++) {
    const pose = frames[f];
    pose[0] += offset;
    floatJoints(pose, scratch);
    const lx = scratch[2 * J.lToe];
    const rx = scratch[2 * J.rToe];
    const ly = Math.min(scratch[2 * J.lAnkle + 1], scratch[2 * J.lToe + 1]);
    const ry = Math.min(scratch[2 * J.rAnkle + 1], scratch[2 * J.rToe + 1]);
    const planted = footHeight[f] < 0.05;
    const foot = ly <= ry ? J.lToe : J.rToe;
    if (!planted) {
      lockFoot = -1;
      continue;
    }
    const footX = foot === J.lToe ? lx : rx;
    if (foot !== lockFoot) {
      lockFoot = foot;
      lockX = footX;
      continue;
    }
    const drift = footX - lockX;
    pose[0] -= drift;
    offset -= drift;
  }
}

function tipSpeeds(frames: FloatPose[]): Float64Array {
  const speeds = new Float64Array(frames.length);
  const a = new Float64Array(JOINT_COUNT * 2);
  const b = new Float64Array(JOINT_COUNT * 2);
  for (let f = 1; f < frames.length; f++) {
    floatJoints(frames[f - 1], a);
    floatJoints(frames[f], b);
    let top = 0;
    for (const j of [J.lWrist, J.rWrist, J.lToe, J.rToe, J.lAnkle, J.rAnkle]) top = Math.max(top, Math.hypot(b[2 * j] - a[2 * j], b[2 * j + 1] - a[2 * j + 1]) * 60);
    speeds[f] = top;
  }
  return speeds;
}

/** Slows down any stretch where a fist or foot moves faster than a person can. */
function capSpeed(frames: FloatPose[]): FloatPose[] {
  const speeds = tipSpeeds(frames);
  if (Math.max(...speeds) <= SPEED_CAP) return frames;
  const times = [0];
  for (let f = 1; f < frames.length; f++) times.push(times[f - 1] + Math.max(1, speeds[f] / SPEED_CAP));
  const out: FloatPose[] = [];
  const total = times[times.length - 1];
  let k = 0;
  for (let t = 0; t <= total && out.length < MOVE_MAX_FRAMES * 2; t += 1) {
    while (k < times.length - 2 && times[k + 1] < t) k++;
    const span = times[k + 1] - times[k];
    out.push(lerpPose(frames[k], frames[Math.min(k + 1, frames.length - 1)], span > 0 ? (t - times[k]) / span : 0));
  }
  return out;
}

/** The frames where something happens, with a little lead-in and follow-through. */
function autoTrim(frames: FloatPose[]): [number, number] {
  const n = frames.length;
  const energy = new Float64Array(n);
  for (let f = 1; f < n; f++) {
    let e = Math.abs(frames[f][0] - frames[f - 1][0]) * 3;
    for (let i = A0; i < POSE_SIZE; i++) e += Math.abs(frames[f][i] - frames[f - 1][i]);
    energy[f] = e;
  }
  const smooth = gaussian(energy, 2);
  const peak = Math.max(...smooth);
  const threshold = peak * 0.16;
  let first = 0;
  while (first < n - 1 && smooth[first] < threshold) first++;
  let last = n - 1;
  while (last > first && smooth[last] < threshold) last--;
  first = Math.max(0, first - 8);
  last = Math.min(n - 1, last + 10);
  if (last - first + 1 > MOVE_MAX_FRAMES - STANCE_IN - STANCE_OUT) last = first + MOVE_MAX_FRAMES - STANCE_IN - STANCE_OUT - 1;
  if (last - first < 12) {
    first = Math.max(0, first - 6);
    last = Math.min(n - 1, first + 24);
  }
  return [first, last];
}

// Step 7: from cleaned frames to a move.

export interface BuildOptions {
  id: string;
  slot: MoveSlot;
  name: string;
  trim: [number, number];
  /** Swap the lead and rear sides (MS-8). */
  mirror: boolean;
  /** Playback speed, 0.75..1.25 (MS-8). */
  speed: number;
}

/** The trimmed, adjusted frames a move is built from (for previews and for the file). */
export function prepareFrames(clean: CleanCapture, options: Pick<BuildOptions, 'trim' | 'mirror' | 'speed'>): FloatPose[] {
  const [a, b] = options.trim;
  let frames: FloatPose[] = clean.frames.slice(a, b + 1).map((f) => f.slice());
  if (options.speed !== 1) {
    const out: FloatPose[] = [];
    const step = Math.max(0.75, Math.min(1.25, options.speed));
    for (let t = 0; t <= frames.length - 1; t += step) {
      const k = Math.floor(t);
      out.push(lerpPose(frames[k], frames[Math.min(k + 1, frames.length - 1)], t - k));
    }
    frames = out;
  }
  if (options.mirror) {
    for (const pose of frames) {
      for (const [l, r] of LEFT_RIGHT) {
        const tmp = pose[A0 + l];
        pose[A0 + l] = pose[A0 + r];
        pose[A0 + r] = tmp;
      }
    }
  }
  // Root x starts at zero; the move ends wherever it travelled to.
  const startX = frames[0][0];
  for (const pose of frames) pose[0] -= startX;
  // Start and end at the fighting stance.
  const stance = stanceFloat();
  const out: FloatPose[] = [];
  for (let i = 0; i < STANCE_IN; i++) out.push(lerpPose(stance, frames[0], (i + 1) / (STANCE_IN + 1)));
  out.push(...frames);
  const end = frames[frames.length - 1];
  const endStance = stance.slice();
  endStance[0] = end[0];
  for (let i = 0; i < STANCE_OUT; i++) out.push(lerpPose(end, endStance, ((i + 1) / STANCE_OUT) ** 1.4));
  return out.slice(0, MOVE_MAX_FRAMES);
}

/** Finds the striking limb, its live frames, the height it lands at and its top speed. */
export function analyse(frames: FloatPose[], slot: MoveSlot): MoveInfo {
  const n = frames.length;
  const joints = frames.map((pose) => {
    const out = new Float64Array(JOINT_COUNT * 2);
    floatJoints(pose, out);
    return out;
  });
  if (slot === 'taunt' || slot === 'victory') {
    return { limb: 'rightWrist', height: 'mid', active: [0, Math.min(1, n - 1)], peakSpeed: 0, peak: Math.floor(n / 2) };
  }
  if (slot === 'defense') {
    // The evasive window: while the head is furthest from where it started.
    const disp = joints.map((j) => Math.hypot(j[2 * J.head] - joints[0][2 * J.head], j[2 * J.head + 1] - joints[0][2 * J.head + 1]));
    const top = Math.max(...disp);
    let first = disp.findIndex((d) => d >= top * 0.55);
    let last = n - 1 - [...disp].reverse().findIndex((d) => d >= top * 0.55);
    if (first < 0) first = Math.floor(n * 0.25);
    if (last <= first) last = Math.min(n - 1, first + 10);
    return { limb: 'head', height: 'mid', active: [first, last], peakSpeed: 0, peak: disp.indexOf(top) };
  }
  const candidates = [J.lWrist, J.rWrist, J.lToe, J.rToe, J.lKnee, J.rKnee, J.lElbow, J.rElbow];
  let best = { joint: J.rWrist as number, score: -Infinity, peak: 0, speed: 0, gain: 0, rest: 0 };
  // Measure from the first captured frame, not the blended-in stance before it.
  const restFrame = Math.min(STANCE_IN, n - 1);
  for (const joint of candidates) {
    const ext = joints.map((j) => j[2 * joint] - j[2 * J.pelvis]);
    const rest = ext[restFrame];
    let peak = 0;
    for (let f = 1; f < n; f++) if (ext[f] > ext[peak]) peak = f;
    let speed = 0;
    for (let f = 1; f < n; f++) {
      const dx = joints[f][2 * joint] - joints[f - 1][2 * joint];
      const dy = joints[f][2 * joint + 1] - joints[f - 1][2 * joint + 1];
      speed = Math.max(speed, Math.hypot(dx, dy) * 60);
    }
    const gain = ext[peak] - rest;
    const tipBonus = joint === J.lWrist || joint === J.rWrist || joint === J.lToe || joint === J.rToe ? 1.15 : 0.9;
    const score = (gain + speed * 0.03) * tipBonus;
    if (score > best.score) best = { joint, score, peak, speed, gain, rest };
  }
  const ext = joints.map((j) => j[2 * best.joint] - j[2 * J.pelvis]);
  const threshold = best.rest + best.gain * 0.78;
  let first = best.peak;
  let last = best.peak;
  while (first > 0 && ext[first - 1] >= threshold && best.peak - first < 6) first--;
  while (last < n - 1 && ext[last + 1] >= threshold && last - best.peak < 4) last++;
  if (last - first < 1) last = Math.min(n - 1, first + 1);
  const tipY = joints[best.peak][2 * best.joint + 1];
  const height: StrikeHeight = tipY >= 1.33 ? 'high' : tipY >= 0.72 ? 'mid' : 'low';
  return { limb: JOINTS[best.joint], height, active: [first, last], peakSpeed: Math.min(100, best.speed), peak: best.peak };
}

/** Encodes frames as a move file, without the hash. */
export function encodeMove(frames: FloatPose[], info: MoveInfo, options: Pick<BuildOptions, 'id' | 'slot' | 'name'>): UnhashedMove {
  const values = new Int16Array(frames.length * FRAME_VALUES);
  const toInt16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
  frames.forEach((pose, f) => {
    const at = f * FRAME_VALUES;
    values[at] = toInt16(pose[0] * 1000);
    values[at + 1] = toInt16(pose[1] * 1000);
    for (let j = 0; j < JOINT_COUNT; j++) {
      let units = Math.round((pose[A0 + j] / TAU) * 65536) % 65536;
      if (units > 32767) units -= 65536;
      if (units < -32768) units += 65536;
      values[at + 2 + j] = units;
    }
  });
  return {
    id: options.id,
    version: MOVE_FORMAT_VERSION,
    slot: options.slot,
    name: options.name,
    frames: encodeFrames(values),
    active: [Math.min(info.active[0], frames.length - 1), Math.min(info.active[1], frames.length - 1)],
    limb: info.limb,
    height: info.height,
  };
}

/**
 * An idle stance (LS-12): the trimmed take held in place and closed into a seamless loop. It is
 * drawn between moves for looks only, so it needs no strike and no stance blend.
 */
export function prepareIdle(clean: CleanCapture, trim: [number, number]): FloatPose[] {
  const frames: FloatPose[] = clean.frames.slice(trim[0], trim[1] + 1).map((f) => f.slice());
  for (const pose of frames) pose[0] = 0;
  const fade = Math.min(14, Math.floor(frames.length / 3));
  const first = frames[0];
  for (let i = 0; i < fade; i++) {
    const at = frames.length - fade + i;
    frames[at] = lerpPose(frames[at], first, (i + 1) / (fade + 1));
  }
  return frames.slice(0, MOVE_MAX_FRAMES);
}

/** Plain-language tips when a take is shaky (MS-9). */
export function jitterTip(clean: CleanCapture): string | null {
  if (clean.quality > 0.62) return null;
  if (clean.jitter > 5) return 'That take was shaky. Add more light, or step back a little.';
  return 'A bit jittery: try moving a touch slower, or stand where the light is even.';
}
