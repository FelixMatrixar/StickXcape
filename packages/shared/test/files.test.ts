import { describe, expect, it } from 'vitest';
import {
  ARENA_FORMAT_VERSION,
  computeMoveHash,
  decodeFrames,
  defaultMoveName,
  encodeFrames,
  FRAME_VALUES,
  MOVE_FORMAT_VERSION,
  MOVE_MAX_FRAMES,
  parseArenaFile,
  parseLoadout,
  parseMoveFile,
  verifyMoveHash,
  withHash,
  type MoveFile,
  type MoveSlot,
  type UnhashedMove,
} from '@sticxcape/shared';

function frames(count: number): string {
  const values = new Int16Array(count * FRAME_VALUES);
  for (let i = 0; i < values.length; i++) values[i] = ((i * 7919) % 65536) - 32768;
  return encodeFrames(values);
}

let nextId = 1;
function unhashed(overrides: Partial<UnhashedMove> = {}): UnhashedMove {
  const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  return { id, version: MOVE_FORMAT_VERSION, slot: 'heavy', name: 'Thunder Fist', frames: frames(30), active: [10, 14], limb: 'rightWrist', height: 'high', ...overrides };
}

const move = (overrides: Partial<UnhashedMove> = {}) => withHash(unhashed(overrides));

describe('move frames', () => {
  it('round-trips little-endian int16 values, extremes included', () => {
    const values = Int16Array.from({ length: FRAME_VALUES * 2 }, (_, i) => [-32768, 32767, 0, -1, 1][i % 5]!);
    expect(decodeFrames(encodeFrames(values))).toEqual(values);
    expect(encodeFrames(Int16Array.of(1, -2))).toBe(Buffer.from([1, 0, 0xfe, 0xff]).toString('base64'));
  });

  it('refuses frames that are empty or not whole', () => {
    expect(decodeFrames('')).toBeNull();
    expect(decodeFrames(encodeFrames(new Int16Array(FRAME_VALUES + 1)))).toBeNull();
    expect(decodeFrames('not base64!')).toBeNull();
  });
});

describe('move hash', () => {
  it('is SHA-256 of the canonical field array', async () => {
    const m = unhashed();
    const canonical = JSON.stringify([m.id, m.version, m.slot, m.name, m.frames, [m.active[0], m.active[1]], m.limb, m.height]);
    const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))).toString('hex');
    expect(await computeMoveHash(m)).toBe(expected);
  });

  it('catches an edited move', async () => {
    const m = await move();
    expect(await verifyMoveHash(m)).toBe(true);
    expect(await verifyMoveHash({ ...m, name: 'Thunder Fist 2' })).toBe(false);
    expect(await verifyMoveHash({ ...m, active: [9, 14] })).toBe(false);
    expect(await verifyMoveHash({ ...m, signature: 'later' })).toBe(true);
  });
});

describe('parseMoveFile', () => {
  it('keeps exactly the contract fields', async () => {
    const m = await move();
    expect(parseMoveFile({ ...m, extra: 'dropped' })).toEqual(m);
    expect(parseMoveFile({ ...m, signature: 'sig' })).toEqual({ ...m, signature: 'sig' });
  });

  it('refuses broken moves', async () => {
    const m: MoveFile = await move();
    const bad: Record<string, unknown>[] = [
      { id: 'not-a-uuid' },
      { version: 2 },
      { slot: 'grab' },
      { name: ' Thunder Fist' },
      { name: 'x'.repeat(33) },
      { frames: frames(MOVE_MAX_FRAMES + 1) },
      { active: [10, 30] },
      { active: [14, 10] },
      { active: [10] },
      { limb: 'tail' },
      { height: 'ankle' },
      { hash: 'ABC' },
      { signature: 'x'.repeat(513) },
    ];
    for (const overrides of bad) expect(parseMoveFile({ ...m, ...overrides }), JSON.stringify(overrides).slice(0, 60)).toBeNull();
  });

  it('accepts the longest move', async () => {
    expect(parseMoveFile(await move({ frames: frames(MOVE_MAX_FRAMES), active: [0, MOVE_MAX_FRAMES - 1] }))).not.toBeNull();
  });
});

describe('parseLoadout', () => {
  it('accepts up to the per-slot limits', async () => {
    const slots: MoveSlot[] = ['light', 'light', 'heavy', 'heavy', 'low', 'special', 'defense', 'taunt', 'victory'];
    const moves = await Promise.all(slots.map((slot) => move({ slot })));
    expect(parseLoadout(moves)).toEqual(moves);
  });

  it('refuses too many of a slot, duplicate ids and empty loadouts', async () => {
    const lights = await Promise.all([1, 2, 3].map(() => move({ slot: 'light' })));
    expect(parseLoadout(lights)).toBeNull();
    const one = await move();
    expect(parseLoadout([one, one])).toBeNull();
    expect(parseLoadout([])).toBeNull();
    expect(parseLoadout('moves')).toBeNull();
  });

  it('names a move by its slot when Meta AI cannot', () => {
    expect(defaultMoveName('heavy', 2)).toBe('Heavy 2');
    expect(defaultMoveName('light')).toBe('Light 1');
  });
});

describe('parseArenaFile', () => {
  const arena = {
    id: 'rooftop',
    version: ARENA_FORMAT_VERSION,
    name: 'Rooftop',
    layers: ['/arenas/rooftop/back.webp', '/arenas/rooftop/front.webp'],
    floor: 0.8,
    width: 12,
    spawns: [4, 8],
    ledges: [{ x: 2, y: 2.5, width: 3 }],
    edges: { left: 'wall', right: 'drop' },
  };

  it('keeps exactly the contract fields', () => {
    expect(parseArenaFile({ ...arena, name: '  Rooftop ', extra: 1, ledges: [{ x: 2, y: 2.5, width: 3, color: 'red' }] })).toEqual(arena);
  });

  it('refuses broken arenas', () => {
    const bad: Record<string, unknown>[] = [
      { id: 'Rooftop' },
      { version: 2 },
      { name: '' },
      { layers: [] },
      { layers: [''] },
      { floor: -1 },
      { width: 0.5 },
      { spawns: [8, 4] },
      { spawns: [4, 13] },
      { ledges: [{ x: 2, y: 2.5, width: 0 }] },
      { edges: { left: 'wall', right: 'lava' } },
    ];
    for (const overrides of bad) expect(parseArenaFile({ ...arena, ...overrides }), JSON.stringify(overrides)).toBeNull();
  });
});
