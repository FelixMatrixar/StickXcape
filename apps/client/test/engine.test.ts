import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Button, computeMoveHash, parseLoadout, parseMoveFile, Rng } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { PracticeBot } from '../src/engine/bot.ts';
import { FightSim, PHASE, S } from '../src/engine/sim.ts';
import { defaultMoves } from '../src/moves/defaults.ts';
import { moveHash } from '../src/moves/hash.ts';
import { buildLoadout, completeLoadout } from '../src/moves/loadout.ts';
import { sha256Hex } from '../src/moves/sha256.ts';

const ARENA = { width: 10, spawns: [3.6, 6.4] as [number, number] };

function newSim(seed: number): FightSim {
  const loadout = buildLoadout({}, []);
  return new FightSim({ seed, arena: ARENA, loadouts: [loadout, loadout] });
}

/** Random button mashing with held directions, the worst case for divergence. */
function masher(seed: number): () => number {
  const rng = new Rng(seed);
  let held = 0;
  return () => {
    if (rng.nextInt(8) === 0) held = rng.nextInt(16) & (Button.Up | Button.Down | Button.Left | Button.Right);
    let buttons = held;
    const roll = rng.nextInt(40);
    if (roll === 0) buttons |= Button.Light;
    else if (roll === 1) buttons |= Button.Heavy;
    else if (roll === 2) buttons |= Button.Special;
    else if (roll === 3) buttons |= Button.Defense;
    else if (roll < 7) buttons |= Button.Block;
    return buttons;
  };
}

describe('default moveset', () => {
  it('passes the contract validator, with hashes matching crypto.subtle', async () => {
    const moves = defaultMoves();
    expect(moves).toHaveLength(9);
    for (const move of moves) {
      expect(parseMoveFile(move)).not.toBeNull();
      expect(move.hash).toBe(await computeMoveHash(move));
      expect(moveHash(move)).toBe(move.hash);
    }
    expect(parseLoadout(moves)).not.toBeNull();
  });

  it('fills loadouts to nine distinct moves', () => {
    const full = buildLoadout({ light1: defaultMoves()[1].id, light2: defaultMoves()[1].id }, defaultMoves());
    expect(new Set(full.map((m) => m.id)).size).toBe(9);
    expect(parseLoadout(full)).not.toBeNull();
    expect(completeLoadout([defaultMoves()[2]])).toHaveLength(9);
  });
});

describe('sha256', () => {
  it('matches crypto.subtle', async () => {
    for (const text of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'ünïcødé ✓'.repeat(40)]) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      expect(sha256Hex(text)).toBe(hex);
    }
  });
});

describe('fight engine', () => {
  it('computes identical fights from identical inputs', () => {
    const a = newSim(1234);
    const b = newSim(1234);
    const left = masher(1);
    const right = masher(2);
    for (let frame = 0; frame < 3600; frame++) {
      const inputs: [number, number] = [left(), right()];
      a.step(inputs);
      b.step(inputs);
      if (frame % 60 === 0) expect(a.hash()).toBe(b.hash());
    }
    expect(a.hash()).toBe(b.hash());
  });

  it('diverges when one input differs', () => {
    const a = newSim(9);
    const b = newSim(9);
    for (let frame = 0; frame < 400; frame++) {
      a.step([frame === 200 ? Button.Right : 0, 0]);
      b.step([0, 0]);
    }
    expect(a.hash()).not.toBe(b.hash());
  });

  it('plays a full bot match to a result', () => {
    const sim = newSim(77);
    const bots = [new PracticeBot(0, 1, 'hard'), new PracticeBot(1, 2, 'hard')] as const;
    let hits = 0;
    let blocks = 0;
    let rounds = 0;
    for (let frame = 0; frame < 60 * 60 * 6 && !sim.over; frame++) {
      sim.step([bots[0].input(sim), bots[1].input(sim)]);
      for (const event of sim.events) {
        if (event.type === 'hit') hits++;
        // Holding Block always opens with a parry window, so both count as defence.
        if (event.type === 'block' || event.type === 'parry') blocks++;
        if (event.type === 'roundEnd') rounds++;
      }
    }
    expect(sim.over).toBe(true);
    expect(rounds).toBeGreaterThanOrEqual(2);
    expect(hits).toBeGreaterThan(5);
    expect(blocks).toBeGreaterThan(0);
    expect(sim.winner === null || sim.winner === 0 || sim.winner === 1).toBe(true);
  });

  it('lands a jab in range and knocks the target back', () => {
    const sim = newSim(5);
    while (sim.phase !== PHASE.fight) sim.step([0, 0]);
    // Walk in.
    for (let i = 0; i < 40; i++) sim.step([Button.Right, 0]);
    const before = sim.fighters[1].x;
    let hit = false;
    sim.step([Button.Light, 0]);
    for (let i = 0; i < 30; i++) {
      sim.step([0, 0]);
      if (sim.events.some((e) => e.type === 'hit')) hit = true;
    }
    expect(hit).toBe(true);
    expect(sim.fighters[1].health).toBeLessThan(1000);
    expect(sim.fighters[1].x).toBeGreaterThan(before);
  });

  it('parries a strike tapped just before it lands', () => {
    const sim = newSim(6);
    while (sim.phase !== PHASE.fight) sim.step([0, 0]);
    for (let i = 0; i < 40; i++) sim.step([Button.Right, 0]);
    sim.step([Button.Heavy, 0]);
    let parried = false;
    for (let i = 0; i < 40; i++) {
      // At this range the haymaker connects late in its active window; tap just before.
      sim.step([0, i === 11 ? Button.Block : 0]);
      if (sim.events.some((e) => e.type === 'parry')) parried = true;
    }
    expect(parried).toBe(true);
    expect(sim.fighters[1].health).toBe(1000);
  });

  it('blocks highs standing and lets lows through', () => {
    const sim = newSim(8);
    while (sim.phase !== PHASE.fight) sim.step([0, 0]);
    for (let i = 0; i < 40; i++) sim.step([Button.Right, Button.Block]);
    sim.step([Button.Down | Button.Heavy, Button.Block]);
    let lowHit = false;
    for (let i = 0; i < 40; i++) {
      sim.step([0, Button.Block]);
      if (sim.events.some((e) => e.type === 'hit')) lowHit = true;
    }
    expect(lowHit).toBe(true);
    expect(sim.fighters[1].state === S.hitstun || sim.fighters[1].health < 1000).toBe(true);
  });
});

describe('determinism rules', () => {
  it('keeps browser maths out of the engine', () => {
    const dir = fileURLToPath(new URL('../src/engine/', import.meta.url));
    const forbidden = /Math\.(sin|cos|tan|asin|acos|atan2?|sqrt|cbrt|hypot|pow|exp|expm1|log\d*|log1p|random|fround)\b/;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(dir + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(forbidden.exec(source)?.[0] ?? null, file).toBeNull();
    }
  });
});
