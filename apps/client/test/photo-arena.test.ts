import { parseArenaFile } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { FightSim } from '../src/engine/sim.ts';
import { average, inkWash, type Pixels } from '../src/arenas/ink.ts';
import { arenaFileFor, checkPhoto, estimateFloor, floorYOf, layoutFor, ledgesFrom, type FoundBox } from '../src/arenas/layout.ts';
import { buildLoadout } from '../src/moves/loadout.ts';
import { simArena } from '../src/render/arena-files.ts';

/** A small fake photo: a pale wall over a darker floor, with a sharp-edged dark box. */
function room(w = 160, h = 90): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      const floor = y > h * 0.75;
      const box = x > 40 && x < 80 && y > h * 0.5 && y <= h * 0.75;
      const [r, g, b] = box ? [60, 40, 90] : floor ? [150, 110, 70] : [220, 210, 190];
      data.set([r, g, b, 255], i);
    }
  }
  return { width: w, height: h, data };
}

const box = (label: string, x0: number, y0: number, x1: number, y1: number): FoundBox => ({ label, x0, y0, x1, y1 });

describe('ink restyle (LS-11)', () => {
  it('keeps the picture’s size, mutes its colour and inks its edges', () => {
    const src = room();
    const out = inkWash(src);
    expect(out.width).toBe(src.width);
    expect(out.data.length).toBe(src.data.length);
    // Muted: the purple box keeps far less of its colour than it had.
    const before = average(src, 0.3, 0.6, 0.45, 0.7);
    const after = average(out, 0.3, 0.6, 0.45, 0.7);
    const spread = (c: number[]) => Math.max(...c) - Math.min(...c);
    expect(spread(after)).toBeLessThan(spread(before) / 2);
    // Inked: the box's edge is darker than the flat wall beside it.
    const edge = average(out, 40.5 / 160, 0.55, 41.5 / 160, 0.7);
    const wall = average(out, 0.7, 0.2, 0.9, 0.4);
    expect(edge[0]).toBeLessThan(wall[0] - 40);
    // Every pixel is opaque.
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it('gives the same picture every time', () => {
    expect(inkWash(room()).data).toEqual(inkWash(room()).data);
  });
});

describe('making a photo playable', () => {
  it('puts the fight line where the nearest furniture meets the floor', () => {
    expect(estimateFloor([box('couch', 0.1, 0.5, 0.4, 0.82), box('chair', 0.6, 0.4, 0.7, 0.7)])).toBeCloseTo(0.82);
    expect(estimateFloor([])).toBeCloseTo(0.8);
  });

  it('turns furniture on the line into jumpable ledges, clear of the spawns', () => {
    const found = [box('couch', 0.02, 0.5, 0.2, 0.8), box('dining table', 0.78, 0.55, 0.97, 0.79), box('tv', 0.4, 0.2, 0.6, 0.4), box('chair', 0.4, 0.5, 0.5, 0.8)];
    const ledges = ledgesFrom(found, 0.8);
    expect(ledges.map((l) => l.y)).toEqual([0.45, 0.75]);
    for (const ledge of ledges) {
      expect(ledge.y).toBeLessThanOrEqual(0.9);
      for (const spawn of [3.6, 6.4]) expect(ledge.x > spawn + 0.5 || ledge.x + ledge.width < spawn - 0.5).toBe(true);
    }
    // Furniture far behind the line is backdrop, not a ledge.
    expect(ledgesFrom([box('couch', 0.1, 0.3, 0.3, 0.55)], 0.8)).toHaveLength(0);
  });

  it('turns down portrait, dark or floorless photos', () => {
    expect(checkPhoto(900, 1600, 0.8, 120)).toMatch(/sideways/);
    expect(checkPhoto(1600, 900, 0.8, 10)).toMatch(/too dark/);
    expect(checkPhoto(1600, 900, 0.4, 120)).toMatch(/floor barely shows/);
    expect(checkPhoto(1600, 900, 0.8, 120)).toBeNull();
  });

  it('writes a valid arena file that fights, and reads the fight line back from it', () => {
    const layout = { ...layoutFor([box('couch', 0.02, 0.5, 0.2, 0.8)], 0.8), edges: { left: 'drop' as const, right: 'wall' as const } };
    const file = arenaFileFor('8c0f6a4e-1f7b-4a49-9f22-0d5d0d9e2a11', 'The Living Room', layout, 16 / 9);
    expect(parseArenaFile(file)).toEqual(file);
    expect(floorYOf(file, 16 / 9)).toBeCloseTo(0.8, 2);
    const loadout = buildLoadout({}, []);
    const sim = new FightSim({ seed: 3, arena: simArena(file), loadouts: [loadout, loadout] });
    for (let f = 0; f < 600; f++) sim.step([0, 0]);
    expect(sim.ledges).toHaveLength(1);
    expect(sim.dropLeft).toBe(true);
  });
});
