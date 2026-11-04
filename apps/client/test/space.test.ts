import { describe, expect, it } from 'vitest';
import { bodyBox, steady, withinReach, type SpaceObject } from '../src/capture/space.ts';

const ASPECT = 16 / 9;
/** A player standing in the middle of a landscape picture, head to feet 0.1..0.9. */
const BODY = { x0: 0.45, y0: 0.1, x1: 0.55, y1: 0.9 };
const thing = (label: string, x0: number, y0: number, x1: number, y1: number): SpaceObject => ({ label, x0, y0, x1, y1 });

describe('clear-space check', () => {
  it('flags a chair standing beside the player', () => {
    expect(withinReach([thing('chair', 0.58, 0.55, 0.7, 0.9)], BODY, ASPECT).map((o) => o.label)).toEqual(['chair']);
  });

  it('flags a pet at the player’s feet', () => {
    expect(withinReach([thing('dog', 0.32, 0.72, 0.44, 0.91)], BODY, ASPECT)).toHaveLength(1);
  });

  it('ignores the same chair well out of reach', () => {
    expect(withinReach([thing('chair', 0.86, 0.55, 0.96, 0.9)], BODY, ASPECT)).toHaveLength(0);
  });

  it('ignores a TV on the back wall: its base is far above the feet line', () => {
    expect(withinReach([thing('tv', 0.3, 0.2, 0.44, 0.42)], BODY, ASPECT)).toHaveLength(0);
  });

  it('ignores furniture far behind the player and furniture right by the phone', () => {
    // Behind: it meets the floor well above the feet line.
    expect(withinReach([thing('couch', 0.55, 0.45, 0.85, 0.68)], BODY, ASPECT)).toHaveLength(0);
    // By the phone: cut off by the bottom of the picture while the feet are clear of it.
    expect(withinReach([thing('dining table', 0.5, 0.8, 0.9, 1)], { ...BODY, y1: 0.86 }, ASPECT)).toHaveLength(0);
  });

  it('ignores things that are not hazards, and other people (the pose check handles them)', () => {
    expect(withinReach([thing('person', 0.58, 0.1, 0.7, 0.9), thing('book', 0.58, 0.8, 0.62, 0.9)], BODY, ASPECT)).toHaveLength(0);
  });

  it('finds the body from visible landmarks, with room for the top of the head', () => {
    const points = new Float32Array(33 * 4);
    for (let i = 0; i < 33; i++) {
      points[i * 4] = 0.45 + (i % 5) * 0.025;
      points[i * 4 + 1] = 0.2 + (i / 32) * 0.7;
      points[i * 4 + 3] = i === 3 ? 0.1 : 0.9;
    }
    const box = bodyBox(points)!;
    expect(box.x0).toBeCloseTo(0.45);
    expect(box.x1).toBeCloseTo(0.55);
    expect(box.y1).toBeCloseTo(0.9);
    expect(box.y0).toBeLessThan(0.2);
    expect(bodyBox(new Float32Array(33 * 4))).toBeNull();
  });

  it('only counts what shows up in two of the last three looks', () => {
    const chair = thing('chair', 0.58, 0.55, 0.7, 0.9);
    expect(steady([new Set(['chair']), new Set(), new Set(['chair'])], [chair])).toHaveLength(1);
    expect(steady([new Set(), new Set(), new Set(['chair'])], [chair])).toHaveLength(0);
  });
});
