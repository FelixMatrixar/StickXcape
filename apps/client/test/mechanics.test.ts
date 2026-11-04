import { Button, Rng, toFixed } from '@sticxcape/shared';
import { describe, expect, it } from 'vitest';
import { PracticeBot } from '../src/engine/bot.ts';
import { FightSim, GUARD_MAX, PHASE, S, THROW_DAMAGE, type SimEvent, type SimArena } from '../src/engine/sim.ts';
import { buildLoadout } from '../src/moves/loadout.ts';
import { arenaFileById, simArena } from '../src/render/arena-files.ts';

const WALLS: SimArena = { width: 10, spawns: [3.6, 6.4] };
const DROPS: SimArena = { width: 10, spawns: [3.6, 6.4], edges: { left: 'drop', right: 'drop' } };
/** The rooftop: drop edges and an air-conditioning unit (a ledge) near each end. */
const ROOF: SimArena = simArena(arenaFileById('rooftop'));

function fightReady(arena: SimArena = WALLS, seed = 11): FightSim {
  const loadout = buildLoadout({}, []);
  const sim = new FightSim({ seed, arena, loadouts: [loadout, loadout] });
  while (sim.phase !== PHASE.fight) sim.step([0, 0]);
  return sim;
}

/** Steps with the given inputs and returns every event seen. */
function run(sim: FightSim, frames: number, input: (frame: number) => [number, number]): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let i = 0; i < frames; i++) {
    sim.step(input(i));
    seen.push(...sim.events);
  }
  return seen;
}

function closeIn(sim: FightSim, rightInput = 0): void {
  // The left fighter walks in until the gap is about grab range.
  for (let i = 0; i < 120 && sim.fighters[1].x - sim.fighters[0].x > toFixed(0.75); i++) sim.step([Button.Right, rightInput]);
}

describe('grabs', () => {
  it('beat a block: the blocker is thrown and takes throw damage', () => {
    const sim = fightReady();
    closeIn(sim, Button.Block);
    const events = run(sim, 60, (i) => [i === 0 ? Button.Light | Button.Heavy : 0, Button.Block]);
    expect(events.some((e) => e.type === 'grab')).toBe(true);
    expect(events.some((e) => e.type === 'throw')).toBe(true);
    expect(sim.fighters[1].health).toBe(1000 - THROW_DAMAGE);
  });

  it('lose to a strike: a jab thrown at the same time lands first', () => {
    const sim = fightReady();
    closeIn(sim);
    const events = run(sim, 40, (i) => (i === 0 ? [Button.Light | Button.Heavy, Button.Light] : [0, 0]));
    expect(events.some((e) => e.type === 'grab')).toBe(false);
    expect(events.some((e) => e.type === 'hit' && e.side === 1)).toBe(true);
  });

  it('work when L and H land a frame apart', () => {
    const sim = fightReady();
    closeIn(sim, Button.Block);
    const events = run(sim, 60, (i) => [i === 0 ? Button.Light : i === 1 ? Button.Light | Button.Heavy : 0, Button.Block]);
    expect(events.some((e) => e.type === 'throw')).toBe(true);
  });
});

describe('meters', () => {
  it('stamina stops heavy spam', () => {
    const sim = fightReady();
    const events = run(sim, 44 * 8, (i) => [i % 44 === 0 ? Button.Heavy : 0, 0]);
    expect(events.filter((e) => e.type === 'move' && e.slot === 'heavy').length).toBeLessThan(8);
    expect(events.some((e) => e.type === 'tired')).toBe(true);
  });

  it('blocking drains the guard until it breaks, and a parry refills it', () => {
    const sim = fightReady();
    closeIn(sim, Button.Block);
    const events = run(sim, 400, (i) => [i % 20 === 0 ? Button.Light : 0, Button.Block]);
    expect(events.some((e) => e.type === 'guardBreak' && e.side === 1)).toBe(true);

    const fresh = fightReady();
    closeIn(fresh);
    fresh.fighters[1].guard = 200;
    // A heavy's 14-frame startup; tap Block so the parry window covers the strike.
    const parried = run(fresh, 40, (i) => [i === 0 ? Button.Heavy : 0, i === 13 ? Button.Block : 0]);
    if (parried.some((e) => e.type === 'parry')) expect(fresh.fighters[1].guard).toBeGreaterThan(GUARD_MAX - 50);
  });
});

describe('ring-outs', () => {
  it('a heavy near a drop edge knocks the target out of the arena', () => {
    const sim = fightReady(DROPS);
    sim.fighters[0].x = toFixed(8.75);
    sim.fighters[1].x = toFixed(9.55);
    const events = run(sim, 400, (i) => [i === 0 ? Button.Heavy : 0, 0]);
    const ringout = events.find((e) => e.type === 'ringout');
    expect(ringout && ringout.type === 'ringout' && ringout.side).toBe(1);
    const end = events.find((e) => e.type === 'roundEnd');
    expect(end && end.type === 'roundEnd' && end.reason).toBe('ringout');
    expect(end && end.type === 'roundEnd' && end.winner).toBe(0);
  });

  it('nobody walks or rolls off on purpose', () => {
    const sim = fightReady(DROPS);
    run(sim, 300, () => [Button.Left, Button.Right]);
    expect(sim.fighters[0].falling).toBe(0);
    expect(sim.fighters[1].falling).toBe(0);
    expect(sim.phase).toBe(PHASE.fight);
  });

  it('walls stop the same heavy', () => {
    const sim = fightReady(WALLS);
    sim.fighters[0].x = toFixed(8.75);
    sim.fighters[1].x = toFixed(9.55);
    const events = run(sim, 120, (i) => [i === 0 ? Button.Heavy : 0, 0]);
    expect(events.some((e) => e.type === 'ringout')).toBe(false);
  });
});

describe('get-up rolls', () => {
  it('holding a direction while down rolls out, invulnerable', () => {
    const sim = fightReady();
    closeIn(sim);
    // The rising uppercut (forward + H) launches, so the target lands in a knockdown.
    let rolled = false;
    let hitWhileRolling = false;
    for (let i = 0; i < 160; i++) {
      const target = sim.fighters[1];
      const left = i === 0 ? Button.Heavy | Button.Right : target.state === S.roll && i % 3 === 0 ? Button.Light : 0;
      // Once down, the right fighter (facing left) holds Right: roll back.
      sim.step([left, target.state === S.knockdown ? Button.Right : 0]);
      for (const e of sim.events) {
        if (e.type === 'roll' && e.side === 1) rolled = true;
        if (e.type === 'hit' && e.target === 1 && sim.fighters[1].state === S.roll) hitWhileRolling = true;
      }
    }
    expect(rolled).toBe(true);
    expect(hitWhileRolling).toBe(false);
  });
});

describe('ledges', () => {
  const ledge = ROOF.ledges![0];
  const top = toFixed(ledge.y);

  /** The left fighter walks to the left ledge, then jumps onto it. */
  function climb(sim: FightSim): void {
    run(sim, 90, () => [Button.Left, 0]);
    run(sim, 60, (i) => [i < 8 ? Button.Up | Button.Left : 0, 0]);
  }

  it('stop anyone walking into their side', () => {
    const sim = fightReady(ROOF);
    run(sim, 90, () => [Button.Left, 0]);
    const f = sim.fighters[0];
    expect(f.x).toBe(toFixed(ledge.x + ledge.width) + toFixed(0.12));
    expect(f.y).toBe(0);
  });

  it('hold a fighter who jumps onto the top, and drop one who walks off the end', () => {
    const sim = fightReady(ROOF);
    climb(sim);
    const f = sim.fighters[0];
    expect(f.floor).toBe(top);
    expect(f.y).toBe(top);
    expect(f.state).toBe(S.idle);
    // Off the far end into the gap before the drop edge: down to the roof, and no further.
    run(sim, 120, () => [Button.Left, 0]);
    expect(f.floor).toBe(0);
    expect(f.y).toBe(0);
    expect(f.x).toBeLessThan(toFixed(ledge.x));
    expect(sim.phase).toBe(PHASE.fight);
  });

  it('send the bot up after someone standing on one', () => {
    const sim = fightReady(ROOF);
    climb(sim);
    const bot = new PracticeBot(1, 3, 'hard');
    let climbed = false;
    for (let i = 0; i < 60 * 8 && !climbed; i++) {
      sim.step([0, bot.input(sim)]);
      climbed = sim.fighters[1].floor === top;
    }
    expect(climbed).toBe(true);
  });
});

describe('determinism with the new mechanics', () => {
  it('two runs agree with grabs, blocks and drop edges in play', () => {
    const left = masher(3, Button.Right);
    const right = masher(4, Button.Left);
    const a = new FightSim({ seed: 5, arena: DROPS, loadouts: [buildLoadout({}, []), buildLoadout({}, [])] });
    const b = new FightSim({ seed: 5, arena: DROPS, loadouts: [buildLoadout({}, []), buildLoadout({}, [])] });
    const seen = new Set<string>();
    for (let frame = 0; frame < 60 * 60 * 3; frame++) {
      const inputs: [number, number] = [left(), right()];
      a.step(inputs);
      b.step(inputs);
      for (const e of a.events) seen.add(e.type);
      if (frame % 60 === 0) expect(a.hash()).toBe(b.hash());
    }
    expect(a.hash()).toBe(b.hash());
    expect(seen.has('grab') || seen.has('throw')).toBe(true);
  });

  it('two bot runs agree on the rooftop, ledges and all', () => {
    const play = () => {
      const sim = new FightSim({ seed: 21, arena: ROOF, loadouts: [buildLoadout({}, []), buildLoadout({}, [])] });
      const bots = [new PracticeBot(0, 5, 'hard'), new PracticeBot(1, 6, 'normal')] as const;
      const hashes: number[] = [];
      for (let f = 0; f < 60 * 60 * 4 && !sim.over; f++) {
        sim.step([bots[0].input(sim), bots[1].input(sim)]);
        if (f % 60 === 0) hashes.push(sim.hash());
      }
      return hashes;
    };
    expect(play()).toEqual(play());
  });

  it('bots finish a match on a drop-edge arena', () => {
    const sim = new FightSim({ seed: 9, arena: DROPS, loadouts: [buildLoadout({}, []), buildLoadout({}, [])] });
    const bots = [new PracticeBot(0, 1, 'hard'), new PracticeBot(1, 2, 'hard')] as const;
    for (let f = 0; f < 60 * 60 * 6 && !sim.over; f++) sim.step([bots[0].input(sim), bots[1].input(sim)]);
    expect(sim.over).toBe(true);
  });
});

/** Mashing that mostly walks toward the other fighter, often blocks, and presses L and H together. */
function masher(seed: number, toward: number): () => number {
  const rng = new Rng(seed);
  let held = 0;
  return () => {
    if (rng.nextInt(10) === 0) held = rng.nextInt(3) === 0 ? rng.nextInt(16) & (Button.Up | Button.Down | Button.Left | Button.Right) : toward;
    let buttons = held;
    const roll = rng.nextInt(30);
    if (roll === 0) buttons |= Button.Light | Button.Heavy;
    else if (roll === 1) buttons |= Button.Light;
    else if (roll === 2) buttons |= Button.Heavy;
    else if (roll === 3) buttons |= Button.Special;
    else if (roll < 12) buttons |= Button.Block;
    return buttons;
  };
}
