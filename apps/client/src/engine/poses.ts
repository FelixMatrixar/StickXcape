/**
 * The built-in movement set that players don't record: stance, walk, crouch, jump, block,
 * parry, hit reactions, launches, knockdowns, dashes. Keyframes are written as world angles in
 * degrees; every animated pose is computed from them per frame with integer maths only.
 */
import { deg, fixedSin, lerpAngle, ONE, wrapAngle } from './fixed.ts';
import { A0, createPose, groundBody, groundPose, HIP_LOCAL, J, ROOT_X, ROOT_Y, SHOULDER_LOCAL, type PoseSpec } from './skeleton.ts';

/** A pose as world angles: rot, spine, head, arms (upper, fore), legs (thigh, shin, foot). */
const W = { rot: 0, spine: 1, head: 2, lUp: 3, lFore: 4, rUp: 5, rFore: 6, lThigh: 7, lShin: 8, lFoot: 9, rThigh: 10, rShin: 11, rFoot: 12 } as const;
const WORLD_SIZE = 13;

function world(spec: Omit<PoseSpec, 'x' | 'lift' | 'lying'>): Int32Array {
  const w = new Int32Array(WORLD_SIZE);
  w[W.rot] = deg(spec.rot ?? 0);
  w[W.spine] = deg(spec.spine);
  w[W.head] = deg(spec.head);
  w[W.lUp] = deg(spec.lUp);
  w[W.lFore] = deg(spec.lFore);
  w[W.rUp] = deg(spec.rUp);
  w[W.rFore] = deg(spec.rFore);
  w[W.lThigh] = deg(spec.lThigh);
  w[W.lShin] = deg(spec.lShin);
  w[W.lFoot] = deg(spec.lFoot);
  w[W.rThigh] = deg(spec.rThigh);
  w[W.rShin] = deg(spec.rShin);
  w[W.rFoot] = deg(spec.rFoot);
  return w;
}

// Keyframes. Facing +x; the left side is the near side and leads (orthodox stance).
export const STANCE = world({ spine: 8, head: 4, lUp: 140, lFore: 25, rUp: 160, rFore: 12, lThigh: 155, lShin: 175, lFoot: 95, rThigh: 195, rShin: 205, rFoot: 100 });
const STANCE_IN = world({ spine: 5, head: 1, lUp: 136, lFore: 20, rUp: 156, rFore: 8, lThigh: 153, lShin: 174, lFoot: 95, rThigh: 196, rShin: 205, rFoot: 100 });
const CROUCH = world({ spine: 34, head: 22, lUp: 150, lFore: 40, rUp: 172, rFore: 26, lThigh: 102, lShin: 176, lFoot: 95, rThigh: 152, rShin: 250, rFoot: 268 });
const SQUAT = world({ spine: 20, head: 10, lUp: 155, lFore: 50, rUp: 175, rFore: 40, lThigh: 125, lShin: 185, lFoot: 95, rThigh: 175, rShin: 225, rFoot: 120 });
const RISE = world({ spine: 6, head: 0, lUp: 95, lFore: 15, rUp: 215, rFore: 140, lThigh: 118, lShin: 205, lFoot: 130, rThigh: 165, rShin: 238, rFoot: 210 });
const FALL = world({ spine: 4, head: -4, lUp: 115, lFore: 65, rUp: 225, rFore: 175, lThigh: 150, lShin: 182, lFoot: 105, rThigh: 192, rShin: 205, rFoot: 120 });
const BLOCK = world({ spine: -3, head: -2, lUp: 98, lFore: 4, rUp: 122, rFore: 8, lThigh: 158, lShin: 172, lFoot: 95, rThigh: 202, rShin: 212, rFoot: 105 });
const BLOCK_LOW = world({ spine: 28, head: 18, lUp: 108, lFore: 14, rUp: 126, rFore: 16, lThigh: 102, lShin: 176, lFoot: 95, rThigh: 152, rShin: 250, rFoot: 268 });
const PARRY = world({ spine: 4, head: 2, lUp: 62, lFore: -24, rUp: 150, rFore: 18, lThigh: 152, lShin: 172, lFoot: 95, rThigh: 200, rShin: 210, rFoot: 105 });
const PARRY_LOW = world({ spine: 30, head: 20, lUp: 118, lFore: 96, rUp: 168, rFore: 28, lThigh: 102, lShin: 176, lFoot: 95, rThigh: 152, rShin: 250, rFoot: 268 });
const HIT_LIGHT = world({ spine: -14, head: -34, lUp: 128, lFore: 62, rUp: 172, rFore: 74, lThigh: 160, lShin: 170, lFoot: 92, rThigh: 198, rShin: 206, rFoot: 102 });
const HIT_HEAVY = world({ spine: -34, head: -56, lUp: 58, lFore: 122, rUp: 232, rFore: 205, lThigh: 140, lShin: 152, lFoot: 82, rThigh: 206, rShin: 200, rFoot: 102 });
const HIT_LOW = world({ spine: 18, head: 6, lUp: 120, lFore: 70, rUp: 190, rFore: 120, lThigh: 140, lShin: 205, lFoot: 120, rThigh: 190, rShin: 215, rFoot: 110 });
const LAUNCH = world({ rot: -28, spine: -48, head: -78, lUp: 22, lFore: 72, rUp: -42, rFore: -8, lThigh: 112, lShin: 150, lFoot: 70, rThigh: 140, rShin: 186, rFoot: 120 });
const DOWN = world({ rot: -90, spine: -94, head: -100, lUp: -40, lFore: -88, rUp: -128, rFore: -70, lThigh: 72, lShin: 108, lFoot: 28, rThigh: 88, rShin: 94, rFoot: 8 });
const KO_DOWN = world({ rot: -90, spine: -96, head: -112, lUp: -152, lFore: -170, rUp: -24, rFore: 40, lThigh: 80, lShin: 98, lFoot: 20, rThigh: 96, rShin: 86, rFoot: 2 });
const STAGGER = world({ spine: -20, head: -30, lUp: 38, lFore: 92, rUp: -32, rFore: 18, lThigh: 150, lShin: 166, lFoot: 100, rThigh: 212, rShin: 218, rFoot: 122 });
const STAGGER_B = world({ spine: -10, head: -18, lUp: 70, lFore: 140, rUp: 10, rFore: 70, lThigh: 156, lShin: 170, lFoot: 98, rThigh: 206, rShin: 212, rFoot: 116 });
const DASH = world({ spine: 28, head: 16, lUp: 162, lFore: 84, rUp: 222, rFore: 172, lThigh: 128, lShin: 172, lFoot: 100, rThigh: 214, rShin: 240, rFoot: 200 });
const BACKDASH = world({ spine: -8, head: -4, lUp: 132, lFore: 30, rUp: 152, rFore: 16, lThigh: 172, lShin: 188, lFoot: 98, rThigh: 208, rShin: 196, rFoot: 104 });
const WIN = world({ spine: -4, head: -10, lUp: 160, lFore: 8, rUp: 4, rFore: 2, lThigh: 165, lShin: 178, lFoot: 95, rThigh: 196, rShin: 200, rFoot: 100 });

const scratchA = new Int32Array(WORLD_SIZE);
const scratchB = new Int32Array(WORLD_SIZE);

function blendWorld(a: Int32Array, b: Int32Array, t: number, out: Int32Array): void {
  for (let i = 0; i < WORLD_SIZE; i++) out[i] = lerpAngle(a[i], b[i], t);
}

/** World angles to the local angles a pose stores (root x is left at 0). */
export function worldToPose(w: Int32Array, out: Int32Array): void {
  const shoulderWorld = w[W.spine] + SHOULDER_LOCAL;
  const hipWorld = w[W.rot] + HIP_LOCAL;
  out[ROOT_X] = 0;
  out[A0 + J.pelvis] = wrapAngle(w[W.rot]);
  out[A0 + J.neck] = wrapAngle(w[W.spine] - w[W.rot]);
  out[A0 + J.head] = wrapAngle(w[W.head] - w[W.spine]);
  out[A0 + J.lShoulder] = wrapAngle(SHOULDER_LOCAL);
  out[A0 + J.rShoulder] = wrapAngle(SHOULDER_LOCAL);
  out[A0 + J.lElbow] = wrapAngle(w[W.lUp] - shoulderWorld);
  out[A0 + J.lWrist] = wrapAngle(w[W.lFore] - w[W.lUp]);
  out[A0 + J.rElbow] = wrapAngle(w[W.rUp] - shoulderWorld);
  out[A0 + J.rWrist] = wrapAngle(w[W.rFore] - w[W.rUp]);
  out[A0 + J.lHip] = wrapAngle(HIP_LOCAL);
  out[A0 + J.rHip] = wrapAngle(HIP_LOCAL);
  out[A0 + J.lKnee] = wrapAngle(w[W.lThigh] - hipWorld);
  out[A0 + J.lAnkle] = wrapAngle(w[W.lShin] - w[W.lThigh]);
  out[A0 + J.lToe] = wrapAngle(w[W.lFoot] - w[W.lShin]);
  out[A0 + J.rKnee] = wrapAngle(w[W.rThigh] - hipWorld);
  out[A0 + J.rAnkle] = wrapAngle(w[W.rShin] - w[W.rThigh]);
  out[A0 + J.rToe] = wrapAngle(w[W.rFoot] - w[W.rShin]);
}

function finish(w: Int32Array, out: Int32Array, lying = false): void {
  worldToPose(w, out);
  out[ROOT_Y] = 0;
  if (lying) groundBody(out);
  else groundPose(out);
}

/** Built-in pose kinds, chosen by the fighter's state. */
export const P = {
  stance: 0,
  walk: 1,
  crouch: 2,
  squat: 3,
  air: 4,
  land: 5,
  block: 6,
  blockLow: 7,
  parry: 8,
  parryLow: 9,
  hitLight: 10,
  hitHeavy: 11,
  hitLow: 12,
  launched: 13,
  down: 14,
  getup: 15,
  stagger: 16,
  dash: 17,
  backdash: 18,
  koDown: 19,
  win: 20,
} as const;

const DEG = deg(1);

/**
 * Writes a built-in pose. `t` is frames into the state; `param` depends on the kind: the walk
 * phase and direction, vertical speed in the air, how long the state lasts, and so on.
 */
export function builtinPose(out: Int32Array, kind: number, t: number, param = 0, param2 = 0): void {
  switch (kind) {
    case P.stance: {
      // A slow breath: about 2.4 s a cycle.
      const breath = (ONE + fixedSin(t * 455)) >> 1;
      blendWorld(STANCE, STANCE_IN, breath, scratchA);
      return finish(scratchA, out);
    }
    case P.walk: {
      // param: phase (binary angle), param2: +1 forward, -1 back.
      const phase = param;
      const s = fixedSin(phase);
      const c = fixedSin(phase + 16384);
      scratchA.set(STANCE);
      const swing = Math.floor((s * 17 * DEG) / ONE);
      scratchA[W.lThigh] += swing;
      scratchA[W.rThigh] -= swing;
      scratchA[W.lShin] = scratchA[W.lThigh] + 16 * DEG + Math.floor((Math.max(0, c) * 26 * DEG) / ONE);
      scratchA[W.rShin] = scratchA[W.rThigh] + 10 * DEG + Math.floor((Math.max(0, -c) * 26 * DEG) / ONE);
      scratchA[W.lUp] -= Math.floor((s * 7 * DEG) / ONE);
      scratchA[W.rUp] += Math.floor((s * 7 * DEG) / ONE);
      scratchA[W.spine] += (param2 > 0 ? 4 : -3) * DEG + Math.floor((fixedSin(phase * 2) * 2 * DEG) / ONE);
      return finish(scratchA, out);
    }
    case P.crouch: {
      const breath = (ONE + fixedSin(t * 520)) >> 1;
      scratchA.set(CROUCH);
      scratchA[W.spine] -= Math.floor((breath * 2 * DEG) / ONE);
      return finish(scratchA, out);
    }
    case P.squat:
      return finish(SQUAT, out);
    case P.air: {
      // param: vertical speed (Q16.16 m/frame); rising tucks, falling opens up.
      const t16 = clampRatio(Math.floor(((toRise - param) * ONE) / (toRise * 2)));
      blendWorld(RISE, FALL, t16, scratchA);
      return finish(scratchA, out);
    }
    case P.land: {
      // param: frames the landing lasts.
      const t16 = clampRatio(Math.floor((t * ONE) / Math.max(1, param)));
      blendWorld(SQUAT, STANCE, t16, scratchA);
      return finish(scratchA, out);
    }
    case P.block:
      return finish(BLOCK, out);
    case P.blockLow:
      return finish(BLOCK_LOW, out);
    case P.parry:
      return finish(PARRY, out);
    case P.parryLow:
      return finish(PARRY_LOW, out);
    case P.hitLight:
    case P.hitHeavy:
    case P.hitLow: {
      // param: total stun frames. Snap into the reaction, then ease back toward the stance.
      const target = kind === P.hitHeavy ? HIT_HEAVY : kind === P.hitLow ? HIT_LOW : HIT_LIGHT;
      const total = Math.max(1, param);
      const back = clampRatio(Math.floor(((t - (total >> 1)) * ONE) / Math.max(1, total - (total >> 1))));
      blendWorld(target, STANCE, back > 0 ? back : 0, scratchA);
      // A quick shudder on the head and spine.
      const shake = Math.floor((fixedSin(t * 9000) * Math.max(0, 8 - t) * DEG) / ONE);
      scratchA[W.head] += shake;
      scratchA[W.spine] += shake >> 1;
      return finish(scratchA, out);
    }
    case P.launched: {
      // param: frames airborne so far; the body tips back as it flies.
      blendWorld(LAUNCH, LAUNCH, 0, scratchA);
      scratchA[W.rot] -= Math.min(t, 24) * 2 * DEG;
      scratchA[W.spine] -= Math.min(t, 24) * 2 * DEG;
      scratchA[W.head] -= Math.min(t, 24) * 2 * DEG;
      const flail = Math.floor((fixedSin(t * 5200) * 14 * DEG) / ONE);
      scratchA[W.lUp] += flail;
      scratchA[W.rUp] -= flail;
      scratchA[W.lThigh] += flail >> 1;
      return finish(scratchA, out);
    }
    case P.down:
      return finish(DOWN, out, true);
    case P.koDown:
      return finish(KO_DOWN, out, true);
    case P.getup: {
      // param: total get-up frames. Lying, to a crouch, to the stance.
      const total = Math.max(2, param);
      const half = total >> 1;
      if (t < half) {
        blendWorld(DOWN, CROUCH, clampRatio(Math.floor((t * ONE) / half)), scratchA);
        worldToPose(scratchA, out);
        // Blend between resting the body and standing on the feet.
        const lie = createPoseScratch();
        lie.set(out);
        groundBody(lie);
        groundPose(out);
        const w = clampRatio(Math.floor((t * ONE) / half));
        out[ROOT_Y] = lie[ROOT_Y] + Math.floor(((out[ROOT_Y] - lie[ROOT_Y]) * w) / ONE);
        return;
      }
      blendWorld(CROUCH, STANCE, clampRatio(Math.floor(((t - half) * ONE) / (total - half))), scratchA);
      return finish(scratchA, out);
    }
    case P.stagger: {
      const w = (ONE + fixedSin(t * 3600)) >> 1;
      blendWorld(STAGGER, STAGGER_B, w, scratchB);
      return finish(scratchB, out);
    }
    case P.dash:
      return finish(DASH, out);
    case P.backdash:
      return finish(BACKDASH, out);
    case P.win: {
      const bounce = (ONE + fixedSin(t * 2400)) >> 1;
      blendWorld(WIN, STANCE_IN, bounce >> 2, scratchA);
      scratchA[W.rUp] = WIN[W.rUp] + Math.floor((fixedSin(t * 2400) * 8 * DEG) / ONE);
      return finish(scratchA, out);
    }
    default:
      return finish(STANCE, out);
  }
}

/** The fighting stance as a pose, for blending moves in and out. */
export function stancePose(out: Int32Array, t: number): void {
  builtinPose(out, P.stance, t);
}

const toRise = 6554; // 0.1 m/frame in Q16.16: full tuck at this upward speed

function clampRatio(t: number): number {
  return t < 0 ? 0 : t > ONE ? ONE : t;
}

let poseScratch: Int32Array | null = null;
function createPoseScratch(): Int32Array {
  return (poseScratch ??= createPose());
}
