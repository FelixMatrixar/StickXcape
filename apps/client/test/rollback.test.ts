import { Rng } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { PracticeBot } from '../src/engine/bot.ts';
import { FightSim, type SimOptions } from '../src/engine/sim.ts';
import { buildLoadout } from '../src/moves/loadout.ts';
import { arenaFileById, simArena } from '../src/render/arena-files.ts';

/** The rooftop, so drop edges and ledges are in play. */
const OPTIONS: SimOptions = { seed: 31, arena: simArena(arenaFileById('rooftop')), loadouts: [buildLoadout({}, []), buildLoadout({}, [])] };

/** Inputs from two hard bots playing a whole match: grabs, launches, ledges and ring-outs. */
function botMatch(): [number, number][] {
  const sim = new FightSim(OPTIONS);
  const bots = [new PracticeBot(0, 7, 'hard'), new PracticeBot(1, 8, 'hard')] as const;
  const inputs: [number, number][] = [];
  for (let f = 0; f < 60 * 60 * 5 && !sim.over; f++) {
    const frame: [number, number] = [bots[0].input(sim), bots[1].input(sim)];
    inputs.push(frame);
    sim.step(frame);
  }
  return inputs;
}

function play(sim: FightSim, inputs: readonly [number, number][], from: number, to: number): void {
  for (let f = from; f < to; f++) sim.step(inputs[f]);
}

/**
 * Every field of the fight and both fighters, found independently of save(), minus scratch space
 * reused within a frame. If save() ever leaves out real state, a load won't match this.
 */
function everything(sim: FightSim): unknown {
  const pick = (obj: object, skip: ReadonlySet<string>) =>
    Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => !skip.has(key))
        .map(([key, value]) => [key, value instanceof Int32Array ? Array.from(value) : value instanceof Rng ? value.state : value]),
    );
  return {
    ...pick(sim, new Set(['fighters', 'events', 'target', 'joints', 'pending'])),
    fighters: sim.fighters.map((f) => pick(f, new Set(['moves']))),
  };
}

describe('save and load for rollback (MP-6)', () => {
  const inputs = botMatch();
  const end = inputs.length;

  it('re-running from a save plays out exactly the same fight', () => {
    const sim = new FightSim(OPTIONS);
    const marks = [0, 97, Math.floor(end / 3), Math.floor((2 * end) / 3), end - 5];
    const saves = new Map<number, ReturnType<FightSim['save']>>();
    let at = 0;
    for (const mark of marks) {
      play(sim, inputs, at, mark);
      saves.set(mark, sim.save());
      at = mark;
    }
    play(sim, inputs, at, end);
    const final = sim.save();
    const hash = sim.hash();
    for (const mark of marks) {
      sim.load(saves.get(mark)!);
      play(sim, inputs, mark, end);
      expect(sim.hash()).toBe(hash);
      expect(sim.save()).toEqual(final);
    }
  });

  it('a load puts back every field, not just the ones that showed up in this match', () => {
    for (const mark of [233, Math.floor(end / 3) + 11, Math.floor(end / 2) + 7, end - 40]) {
      const reference = new FightSim(OPTIONS);
      play(reference, inputs, 0, mark);
      const sim = new FightSim(OPTIONS);
      play(sim, inputs, 0, mark);
      const save = sim.save();
      play(sim, inputs, mark, end);
      sim.load(save);
      expect(everything(sim)).toEqual(everything(reference));
    }
  });

  it('undoes a different future', () => {
    const sim = new FightSim(OPTIONS);
    const mark = Math.floor(end / 2);
    play(sim, inputs, 0, mark);
    const save = sim.save();
    play(sim, inputs, mark, end);
    const final = sim.save();
    // Rewind, play something else entirely, rewind again, then the real inputs.
    sim.load(save);
    const rng = new Rng(99);
    for (let f = 0; f < 400; f++) sim.step([rng.nextInt(512), rng.nextInt(512)]);
    sim.load(save);
    play(sim, inputs, mark, end);
    expect(sim.save()).toEqual(final);
  });

  it('loads into a fresh fight built with the same options', () => {
    const a = new FightSim(OPTIONS);
    const mark = Math.floor(end / 4);
    play(a, inputs, 0, mark);
    const b = new FightSim(OPTIONS);
    b.load(a.save());
    play(a, inputs, mark, end);
    play(b, inputs, mark, end);
    expect(b.save()).toEqual(a.save());
  });

  it('is cheap enough to save every frame', () => {
    const sim = new FightSim(OPTIONS);
    play(sim, inputs, 0, 600);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) sim.load(sim.save());
    // A rollback client saves once a frame and loads a few times a second.
    expect((performance.now() - started) / 1000).toBeLessThan(0.5);
  });
});
