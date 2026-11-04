import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinPose, P, stancePose } from '../src/engine/poses.ts';
import { createPose, J, JOINT_COUNT } from '../src/engine/skeleton.ts';
import { jointsBetween } from '../src/render/pose.ts';
import { Ragdoll } from '../src/render/ragdoll.ts';

/** World joints (metres) for a pose with its root at (x, y). */
function joints(pose: Int32Array, x: number, y = 0): Float32Array {
  const out = new Float32Array(JOINT_COUNT * 2);
  jointsBetween(pose, pose, 0, out);
  for (let j = 0; j < JOINT_COUNT; j++) {
    out[2 * j] += x;
    out[2 * j + 1] += y;
  }
  return out;
}

function stance(x: number, y = 0): Float32Array {
  const pose = createPose();
  stancePose(pose, 0);
  return joints(pose, x, y);
}

// The ragdoll scatters its starting speeds with Math.random; seed it so every run is the same.
beforeEach(() => {
  let s = 12345;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const lowest = (r: Ragdoll) => r.bottom;
const pelvisGap = (r: Ragdoll) => Math.hypot(r.pos[2 * J.pelvis] - r.target[2 * J.pelvis], r.pos[2 * J.pelvis + 1] - r.target[2 * J.pelvis + 1]);

/** The worst distance of any joint from where the target pose puts it, measured from each pelvis. */
function shapeError(r: Ragdoll): number {
  let worst = 0;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const dx = r.pos[2 * j] - r.pos[2 * J.pelvis] - (r.target[2 * j] - r.target[2 * J.pelvis]);
    const dy = r.pos[2 * j + 1] - r.pos[2 * J.pelvis + 1] - (r.target[2 * j + 1] - r.target[2 * J.pelvis + 1]);
    worst = Math.max(worst, Math.hypot(dx, dy));
  }
  return worst;
}

describe('ragdoll and ledges', () => {
  const ledge = { x0: 4, x1: 5.2, top: 0.55 };

  it('comes to rest on top of a ledge it falls onto', () => {
    // Lying flat over a ledge wide enough to hold the whole body.
    const down = createPose();
    builtinPose(down, P.down, 30);
    const r = new Ragdoll(joints(down, 5, 0.9), 0, 0, 0);
    r.ledges = [{ x0: 3.6, x1: 6.4, top: 0.55 }];
    for (let i = 0; i < 180; i++) r.update(1 / 60);
    expect(lowest(r)).toBeGreaterThan(0.55);
    expect(lowest(r)).toBeLessThan(0.55 + 0.2);
  });

  it('never lets a point inside a ledge it slides into', () => {
    const r = new Ragdoll(stance(3.3), 4, 0, 0);
    r.ledges = [ledge];
    for (let i = 0; i < 120; i++) {
      r.update(1 / 60);
      // It may stop at the side or topple over the top, but never ends up inside the block.
      for (let j = 0; j < JOINT_COUNT; j++) {
        const x = r.pos[2 * j];
        expect(r.pos[2 * j + 1] < ledge.top && x > ledge.x0 + 0.01 && x < ledge.x1 - 0.01).toBe(false);
      }
    }
  });
});

describe('active ragdoll (CB-8)', () => {
  it('keeps its body where the fight has it, even after a hard kick', () => {
    const start = stance(5);
    const r = new Ragdoll(start, 0, 0, 0);
    r.active = true;
    r.setMuscles(0.006, 0.25, 0.15);
    r.kick(J.head, -9, 6);
    let worst = 0;
    let flail = 0;
    // The fight carries the body along at 2 m/s.
    for (let i = 0; i < 40; i++) {
      r.target.set(stance(5 + (2 * i) / 60, 0.4));
      r.tvx = 2;
      r.tvy = 0;
      r.update(1 / 60);
      if (i > 10) worst = Math.max(worst, pelvisGap(r));
      flail = Math.max(flail, shapeError(r));
    }
    expect(worst).toBeLessThan(0.12);
    // The kick shows: the limbs swing well away from the pose on the way.
    expect(flail).toBeGreaterThan(0.15);
  });

  it('gathers itself into the pose once the muscles firm up', () => {
    const down = createPose();
    builtinPose(down, P.down, 30);
    const r = new Ragdoll(stance(5), 1.5, 2, -4);
    r.active = true;
    r.target.set(joints(down, 5));
    r.setMuscles(0.2, 0.4, 0.9);
    for (let i = 0; i < 90; i++) r.update(1 / 60);
    expect(pelvisGap(r)).toBeLessThan(0.06);
    expect(shapeError(r)).toBeLessThan(0.12);
  });
});
