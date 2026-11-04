import { decodeFrames, FRAME_VALUES, parseMoveFile } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_ASPECT, demoTake } from '../src/capture/demo.ts';
import { FightSim } from '../src/engine/sim.ts';
import { analyse, clampPose, cleanCapture, encodeMove, floatJoints, prepareFrames, prepareIdle } from '../src/moves/cleanup.ts';
import { A0, J, JOINT_COUNT, POSE_SIZE } from '../src/engine/skeleton.ts';
import { defaultMoves } from '../src/moves/defaults.ts';
import { uuid, withHashSync } from '../src/moves/hash.ts';
import { LOADOUT_KEYS } from '../src/moves/loadout.ts';

describe('capture cleanup', () => {
  for (const [index, label] of [
    [0, 'jab'],
    [2, 'haymaker'],
    [4, 'sweep'],
    [6, 'slip'],
  ] as const) {
    it(`turns a noisy ${label} take into a valid move`, () => {
      const source = defaultMoves()[index];
      const clean = cleanCapture(demoTake(source), DEMO_ASPECT);
      expect(clean.frames.length).toBeGreaterThan(30);
      expect(clean.quality).toBeGreaterThan(0.3);
      const frames = prepareFrames(clean, { trim: clean.trim, mirror: false, speed: 1 });
      const info = analyse(frames, source.slot);
      const move = withHashSync(encodeMove(frames, info, { id: uuid(), slot: source.slot, name: `Test ${label}` }));
      expect(parseMoveFile(move)).not.toBeNull();
      const values = decodeFrames(move.frames)!;
      expect(values.length / FRAME_VALUES).toBeLessThanOrEqual(240);
      if (source.slot === 'light') expect(info.limb.endsWith('Wrist')).toBe(true);
      if (source.slot === 'low') expect(info.height).toBe('low');
      if (source.slot === 'defense') expect(info.limb).toBe('head');
      // The recorded move fights: put it in a loadout and run a few seconds.
      const loadout = defaultMoves().map((m, i) => (i === index ? move : m));
      const sim = new FightSim({ seed: 1, arena: { width: 10, spawns: [3.6, 6.4] }, loadouts: [loadout, loadout] });
      for (let f = 0; f < 400; f++) sim.step([0, 0]);
      expect(sim.fighters[0].moves[index].name).toBe(`Test ${label}`);
      void LOADOUT_KEYS;
    });
  }

  it('speeds up, slows down and mirrors without breaking the move', () => {
    const clean = cleanCapture(demoTake(defaultMoves()[2]), DEMO_ASPECT);
    for (const speed of [0.75, 1.25]) {
      const frames = prepareFrames(clean, { trim: clean.trim, mirror: true, speed });
      const info = analyse(frames, 'heavy');
      expect(parseMoveFile(withHashSync(encodeMove(frames, info, { id: uuid(), slot: 'heavy', name: 'Mirror' })))).not.toBeNull();
    }
  });
});

describe('physics check, half speed and idle stances', () => {
  it('plays a half-speed take back at full speed', () => {
    const take = demoTake(defaultMoves()[0]);
    const normal = cleanCapture(take, DEMO_ASPECT);
    const fast = cleanCapture(take, DEMO_ASPECT, { halfSpeed: true });
    expect(Math.abs(fast.frames.length - Math.ceil(normal.frames.length / 2))).toBeLessThanOrEqual(3);
  });

  it('fixes a knee that bends the wrong way', () => {
    const take = demoTake(defaultMoves()[0]);
    // Shove both knees far behind the line from hip to ankle in a run of frames.
    for (let f = 10; f < 16; f++) {
      const p = take[f].points;
      for (const [hip, knee, ankle] of [[23, 25, 27], [24, 26, 28]]) {
        const backX = (p[hip * 4] + p[ankle * 4]) / 2 - (p[ankle * 4] - p[hip * 4]) * 0 - 0.08 * Math.sign(p[0] - p[7 * 4] || 1);
        p[knee * 4] = backX;
      }
    }
    const clean = cleanCapture(take, DEMO_ASPECT);
    expect(clean.corrected).toBeGreaterThan(0);
    for (const pose of clean.frames) {
      for (const joint of [J.lAnkle, J.rAnkle]) {
        const a = Math.atan2(Math.sin(pose[A0 + joint]), Math.cos(pose[A0 + joint])) * (180 / Math.PI);
        expect(a).toBeGreaterThanOrEqual(-25.5);
        expect(a).toBeLessThanOrEqual(165.5);
      }
    }
  });

  it('closes an idle stance into a loop that stays in place', () => {
    const clean = cleanCapture(demoTake(defaultMoves()[7]), DEMO_ASPECT);
    const frames = prepareIdle(clean, clean.trim);
    expect(frames.every((pose) => pose[0] === 0)).toBe(true);
    const a = new Float64Array(JOINT_COUNT * 2);
    const b = new Float64Array(JOINT_COUNT * 2);
    floatJoints(frames[0], a);
    floatJoints(frames[frames.length - 1], b);
    const gap = Math.hypot(a[2 * J.rWrist] - b[2 * J.rWrist], a[2 * J.rWrist + 1] - b[2 * J.rWrist + 1]);
    expect(gap).toBeLessThan(0.12);
  });

  const DEG = Math.PI / 180;
  const wrapDeg = (a: number) => Math.atan2(Math.sin(a), Math.cos(a)) / DEG;

  it('keeps every built-in move inside human limits, frame by frame', () => {
    for (const move of defaultMoves()) {
      const values = decodeFrames(move.frames)!;
      for (let f = 0; f < values.length / FRAME_VALUES; f++) {
        const pose = new Float64Array(POSE_SIZE);
        for (let i = 0; i < POSE_SIZE; i++) pose[i] = i < A0 ? values[f * FRAME_VALUES + i] / 1000 : (values[f * FRAME_VALUES + i] / 65536) * Math.PI * 2;
        expect(clampPose(pose), `${move.name}, frame ${f}`).toBe(false);
      }
    }
  });

  it('stops an elbow folded past 180° at the full bend, never flipped to the far limit', () => {
    for (const fold of [-178, -186, -195, -205]) {
      const pose = new Float64Array(POSE_SIZE);
      pose[A0 + J.neck] = Math.PI;
      pose[A0 + J.rWrist] = fold * DEG;
      expect(clampPose(pose)).toBe(fold < -170.5);
      expect(wrapDeg(pose[A0 + J.rWrist])).toBeCloseTo(-170, 3);
    }
    // Bent the wrong way by a lot: the nearer limit is straight-ish, not the full bend.
    const pose = new Float64Array(POSE_SIZE);
    pose[A0 + J.lWrist] = 70 * DEG;
    clampPose(pose);
    expect(wrapDeg(pose[A0 + J.lWrist])).toBeCloseTo(30, 3);
  });

  it('cleans every demo take without a joint left past its limits', () => {
    for (const move of defaultMoves()) {
      const clean = cleanCapture(demoTake(move), DEMO_ASPECT);
      for (const pose of clean.frames) {
        for (const joint of [J.lWrist, J.rWrist]) {
          expect(wrapDeg(pose[A0 + joint])).toBeGreaterThanOrEqual(-170.5);
          expect(wrapDeg(pose[A0 + joint])).toBeLessThanOrEqual(30.5);
        }
      }
    }
  });
});
