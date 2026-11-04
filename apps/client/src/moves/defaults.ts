/**
 * The default moveset (MS-6): what the practice bot fights with and what new players start from.
 * Each move is keyframed as world-angle poses, sampled at 60 frames a second and stored in the
 * same move file format as a recording, so it plays through exactly the same engine path.
 */
import { encodeFrames, FRAME_VALUES, MOVE_FORMAT_VERSION, type JointName, type MoveFile, type MoveSlot, type StrikeHeight } from '@sticxcape/shared';
import { fixedToMm, toFixed } from '../engine/fixed.ts';
import { A0, groundPose, JOINT_COUNT, poseFromSpec, ROOT_X, ROOT_Y, type PoseSpec } from '../engine/skeleton.ts';
import { withHashSync } from './hash.ts';

type Spec = Omit<PoseSpec, 'lying'>;
type Ease = 'linear' | 'in' | 'out' | 'inout' | 'snap';
type Key = [frame: number, pose: Spec, ease?: Ease];

const STANCE: Spec = { spine: 8, head: 4, lUp: 140, lFore: 25, rUp: 160, rFore: 12, lThigh: 155, lShin: 175, lFoot: 95, rThigh: 195, rShin: 205, rFoot: 100 };
const S = (over: Partial<Spec>): Spec => ({ ...STANCE, ...over });

const ANGLE_KEYS = ['rot', 'spine', 'head', 'lUp', 'lFore', 'rUp', 'rFore', 'lThigh', 'lShin', 'lFoot', 'rThigh', 'rShin', 'rFoot'] as const;

function ease(t: number, kind: Ease): number {
  switch (kind) {
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'snap':
      // Fast out of the gate, then settles: strikes read as speed, not floatiness.
      return 1 - (1 - t) * (1 - t) * (1 - t);
    default:
      return t * t * (3 - 2 * t);
  }
}

/** Shortest-arc blend in degrees. */
function lerpDeg(a: number, b: number, t: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * t;
}

/** Segments that bend from a parent: blended as a bend, so a forearm never swings through the upper arm. */
const BENDS_FROM: Partial<Record<(typeof ANGLE_KEYS)[number], (typeof ANGLE_KEYS)[number]>> = {
  head: 'spine',
  lFore: 'lUp',
  rFore: 'rUp',
  lShin: 'lThigh',
  rShin: 'rThigh',
  lFoot: 'lShin',
  rFoot: 'rShin',
};

function sample(keys: readonly Key[], frame: number): Spec {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= frame) i++;
  const [f0, a] = keys[i];
  const [f1, b, kind] = keys[i + 1];
  const t = f1 === f0 ? 1 : ease(Math.min(1, Math.max(0, (frame - f0) / (f1 - f0))), kind ?? 'inout');
  const out: Record<string, number> = {};
  for (const key of ANGLE_KEYS) {
    const parent = BENDS_FROM[key];
    // Parents come first in ANGLE_KEYS, so out[parent] is already blended.
    out[key] = parent
      ? out[parent] + lerpDeg((a[key] ?? 0) - (a[parent] ?? 0), (b[key] ?? 0) - (b[parent] ?? 0), t)
      : lerpDeg(a[key] ?? 0, b[key] ?? 0, t);
  }
  out.x = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * t;
  out.lift = (a.lift ?? 0) + ((b.lift ?? 0) - (a.lift ?? 0)) * t;
  return out as unknown as Spec;
}

interface DefaultMove {
  id: string;
  slot: MoveSlot;
  name: string;
  limb: JointName;
  height: StrikeHeight;
  active: [number, number];
  keys: Key[];
}

function build(def: DefaultMove): MoveFile {
  const frameCount = def.keys[def.keys.length - 1][0] + 1;
  const values = new Int16Array(frameCount * FRAME_VALUES);
  for (let f = 0; f < frameCount; f++) {
    const spec = sample(def.keys, f);
    const pose = poseFromSpec({ ...spec, x: 0, lift: 0 });
    groundPose(pose, toFixed(spec.lift ?? 0));
    pose[ROOT_X] = toFixed(spec.x ?? 0);
    const at = f * FRAME_VALUES;
    values[at] = fixedToMm(pose[ROOT_X]);
    values[at + 1] = fixedToMm(pose[ROOT_Y]);
    for (let j = 0; j < JOINT_COUNT; j++) values[at + 2 + j] = pose[A0 + j];
  }
  return withHashSync({
    id: def.id,
    version: MOVE_FORMAT_VERSION,
    slot: def.slot,
    name: def.name,
    frames: encodeFrames(values),
    active: def.active,
    limb: def.limb,
    height: def.height,
  });
}

const id = (n: number) => `5ef0c0de-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const DEFS: DefaultMove[] = [
  {
    id: id(1),
    slot: 'light',
    name: 'Snap Jab',
    limb: 'leftWrist',
    height: 'high',
    active: [6, 9],
    keys: [
      [0, STANCE],
      [4, S({ spine: 4, lUp: 152, lFore: 44, x: -0.02 })],
      [7, S({ spine: 14, head: 8, lUp: 80, lFore: 80, rUp: 166, rFore: 8, lThigh: 150, rThigh: 200, rShin: 212, x: 0.06 }), 'snap'],
      [9, S({ spine: 15, head: 8, lUp: 82, lFore: 84, rUp: 166, rFore: 8, lThigh: 150, rThigh: 200, rShin: 212, x: 0.07 })],
      [15, S({ spine: 10, lUp: 124, lFore: 38, x: 0.03 }), 'out'],
      [20, STANCE],
    ],
  },
  {
    id: id(2),
    slot: 'light',
    name: 'Snap Kick',
    limb: 'leftToe',
    height: 'mid',
    active: [7, 10],
    keys: [
      [0, STANCE],
      [5, S({ spine: 0, head: 0, lUp: 128, lFore: 32, rUp: 172, rFore: 12, lThigh: 86, lShin: 172, lFoot: 120, rThigh: 186, rShin: 190, rFoot: 95 })],
      [8, S({ spine: -14, head: -4, lUp: 108, lFore: 52, rUp: 204, rFore: 126, lThigh: 80, lShin: 88, lFoot: 62, rThigh: 188, rShin: 192, rFoot: 96, x: 0.05 }), 'snap'],
      [10, S({ spine: -15, head: -4, lUp: 108, lFore: 52, rUp: 204, rFore: 126, lThigh: 82, lShin: 90, lFoot: 64, rThigh: 188, rShin: 192, rFoot: 96, x: 0.06 })],
      [15, S({ spine: 0, lThigh: 96, lShin: 182, lFoot: 110, rThigh: 188, rShin: 194, x: 0.04 }), 'out'],
      [22, STANCE],
    ],
  },
  {
    id: id(3),
    slot: 'heavy',
    name: 'Haymaker',
    limb: 'rightWrist',
    height: 'high',
    active: [13, 16],
    keys: [
      [0, STANCE],
      [6, S({ spine: -6, head: 0, lUp: 122, lFore: 40, rUp: 214, rFore: 120, lThigh: 160, lShin: 178, rThigh: 200, rShin: 210, x: -0.04 })],
      [11, S({ spine: -12, head: -2, lUp: 118, lFore: 46, rUp: 232, rFore: 152, lThigh: 162, lShin: 178, rThigh: 202, rShin: 212, x: -0.07 }), 'out'],
      [15, S({ spine: 24, head: 15, lUp: 176, lFore: 122, rUp: 74, rFore: 78, lThigh: 138, lShin: 172, rThigh: 212, rShin: 226, rFoot: 122, x: 0.2 }), 'in'],
      [18, S({ spine: 28, head: 16, lUp: 178, lFore: 126, rUp: 72, rFore: 66, lThigh: 136, lShin: 172, rThigh: 214, rShin: 228, rFoot: 124, x: 0.24 })],
      [27, S({ spine: 14, rUp: 122, rFore: 42, lUp: 150, lFore: 60, x: 0.2 }), 'out'],
      [36, S({ x: 0.18 })],
    ],
  },
  {
    id: id(4),
    slot: 'heavy',
    name: 'Rising Uppercut',
    limb: 'rightWrist',
    height: 'mid',
    active: [13, 17],
    keys: [
      [0, STANCE],
      [8, S({ spine: 26, head: 20, lUp: 152, lFore: 50, rUp: 192, rFore: 118, lThigh: 128, lShin: 180, rThigh: 172, rShin: 226, rFoot: 110, x: 0.02 })],
      [13, S({ spine: 6, head: 4, lUp: 158, lFore: 70, rUp: 116, rFore: 34, lThigh: 158, lShin: 172, rThigh: 196, rShin: 202, rFoot: 120, x: 0.1, lift: 0.02 }), 'in'],
      [16, S({ spine: -8, head: -12, lUp: 162, lFore: 92, rUp: 28, rFore: 4, lThigh: 166, lShin: 170, rThigh: 200, rShin: 206, rFoot: 140, x: 0.13, lift: 0.07 }), 'snap'],
      [20, S({ spine: -10, head: -14, lUp: 162, lFore: 92, rUp: 22, rFore: 0, lThigh: 166, lShin: 170, rThigh: 200, rShin: 206, rFoot: 140, x: 0.14, lift: 0.05 })],
      [31, S({ x: 0.12 })],
    ],
  },
  {
    id: id(5),
    slot: 'low',
    name: 'Leg Sweep',
    limb: 'rightAnkle',
    height: 'low',
    active: [11, 15],
    keys: [
      [0, STANCE],
      [5, S({ spine: 42, head: 26, lUp: 162, lFore: 84, rUp: 176, rFore: 62, lThigh: 96, lShin: 176, lFoot: 95, rThigh: 158, rShin: 250, rFoot: 268 })],
      [9, S({ spine: 52, head: 32, lUp: 172, lFore: 112, rUp: 186, rFore: 80, lThigh: 94, lShin: 176, lFoot: 95, rThigh: 226, rShin: 246, rFoot: 250 })],
      [13, S({ spine: 46, head: 30, lUp: 170, lFore: 110, rUp: 200, rFore: 120, lThigh: 94, lShin: 176, lFoot: 95, rThigh: 102, rShin: 98, rFoot: 92, x: 0.06 }), 'snap'],
      [16, S({ spine: 44, head: 28, lUp: 168, lFore: 104, rUp: 204, rFore: 128, lThigh: 94, lShin: 176, lFoot: 95, rThigh: 84, rShin: 80, rFoot: 70, x: 0.07 })],
      [23, S({ spine: 34, head: 22, lUp: 150, lFore: 42, rUp: 172, rFore: 28, lThigh: 104, lShin: 176, rThigh: 156, rShin: 248, rFoot: 266, x: 0.06 }), 'out'],
      [31, S({ x: 0.06 })],
    ],
  },
  {
    id: id(6),
    slot: 'special',
    name: 'Flying Kick',
    limb: 'leftToe',
    height: 'mid',
    active: [19, 24],
    keys: [
      [0, STANCE],
      [6, S({ spine: 20, head: 10, lUp: 150, lFore: 60, rUp: 190, rFore: 120, lThigh: 125, lShin: 190, rThigh: 175, rShin: 225, rFoot: 120 })],
      [12, S({ spine: 2, head: 0, lUp: 100, lFore: 30, rUp: 220, rFore: 160, lThigh: 110, lShin: 200, lFoot: 140, rThigh: 160, rShin: 230, rFoot: 200, lift: 0.3, x: 0.3 }), 'in'],
      [17, S({ spine: -8, head: -2, lUp: 92, lFore: 40, rUp: 226, rFore: 170, lThigh: 72, lShin: 160, lFoot: 120, rThigh: 180, rShin: 240, rFoot: 220, lift: 0.46, x: 0.6 }), 'out'],
      [21, S({ spine: -20, head: -8, lUp: 60, lFore: 36, rUp: 230, rFore: 180, lThigh: 84, lShin: 94, lFoot: 70, rThigh: 190, rShin: 250, rFoot: 230, lift: 0.45, x: 0.92 }), 'snap'],
      [25, S({ spine: -18, head: -8, lUp: 64, lFore: 40, rUp: 228, rFore: 178, lThigh: 86, lShin: 96, lFoot: 72, rThigh: 190, rShin: 248, rFoot: 228, lift: 0.36, x: 1.02 })],
      [32, S({ spine: 6, lThigh: 140, lShin: 175, rThigh: 190, rShin: 200, rFoot: 110, lift: 0.12, x: 1.12 }), 'in'],
      [36, S({ spine: 20, head: 10, lUp: 150, lFore: 60, rUp: 180, rFore: 60, lThigh: 125, lShin: 186, rThigh: 175, rShin: 225, rFoot: 120, x: 1.15 })],
      [44, S({ x: 1.15 })],
    ],
  },
  {
    id: id(7),
    slot: 'defense',
    name: 'Slip Back',
    limb: 'head',
    height: 'mid',
    active: [3, 13],
    keys: [
      [0, STANCE],
      [4, S({ spine: -30, head: -22, lUp: 122, lFore: 42, rUp: 142, rFore: 22, lThigh: 166, lShin: 186, rThigh: 216, rShin: 222, x: -0.24 }), 'snap'],
      [12, S({ spine: -32, head: -24, lUp: 124, lFore: 44, rUp: 144, rFore: 22, lThigh: 168, lShin: 186, rThigh: 218, rShin: 224, x: -0.36 })],
      [21, S({ x: -0.4 })],
    ],
  },
  {
    id: id(8),
    slot: 'taunt',
    name: 'Come At Me',
    limb: 'leftWrist',
    height: 'mid',
    active: [0, 1],
    keys: [
      [0, STANCE],
      [10, S({ spine: 0, head: -8, lUp: 100, lFore: 22, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [17, S({ spine: 0, head: -10, lUp: 100, lFore: -24, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [24, S({ spine: 0, head: -8, lUp: 100, lFore: 22, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [31, S({ spine: 0, head: -10, lUp: 100, lFore: -24, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [38, S({ spine: 0, head: -8, lUp: 100, lFore: 22, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [48, S({ spine: -4, head: -18, lUp: 120, lFore: 40, rUp: 176, rFore: 172, lThigh: 165, lShin: 180, rThigh: 190, rShin: 195 })],
      [60, STANCE],
    ],
  },
  {
    id: id(9),
    slot: 'victory',
    name: 'Champion',
    limb: 'rightWrist',
    height: 'high',
    active: [0, 1],
    keys: [
      [0, S({ spine: -5, head: -15, rUp: 2, rFore: 0, lUp: 176, lFore: 140, lThigh: 168, lShin: 180, rThigh: 192, rShin: 196 })],
      [12, S({ spine: -6, head: -18, rUp: -4, rFore: -8, lUp: 176, lFore: 140, lThigh: 168, lShin: 180, rThigh: 192, rShin: 196, lift: 0.07 }), 'out'],
      [24, S({ spine: -5, head: -15, rUp: 2, rFore: 0, lUp: 176, lFore: 140, lThigh: 168, lShin: 180, rThigh: 192, rShin: 196 }), 'in'],
      [36, S({ spine: -6, head: -18, rUp: -4, rFore: -8, lUp: 176, lFore: 140, lThigh: 168, lShin: 180, rThigh: 192, rShin: 196, lift: 0.07 }), 'out'],
      [48, S({ spine: -5, head: -15, rUp: 2, rFore: 0, lUp: 176, lFore: 140, lThigh: 168, lShin: 180, rThigh: 192, rShin: 196 }), 'in'],
    ],
  },
];

let cache: MoveFile[] | null = null;

/** The default moves, one per loadout key, in loadout order. */
export function defaultMoves(): MoveFile[] {
  return (cache ??= DEFS.map(build));
}

export function isDefaultMove(moveId: string): boolean {
  return moveId.startsWith('5ef0c0de-0000-4000-8000-');
}
