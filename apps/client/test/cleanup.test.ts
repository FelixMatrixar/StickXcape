import { decodeFrames, FRAME_VALUES, parseMoveFile } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { DEMO_ASPECT, demoTake } from '../src/capture/demo.ts';
import { FightSim } from '../src/engine/sim.ts';
import { analyse, cleanCapture, encodeMove, prepareFrames } from '../src/moves/cleanup.ts';
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
