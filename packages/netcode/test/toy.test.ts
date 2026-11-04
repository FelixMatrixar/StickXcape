import { describe, expect, it, vi } from 'vitest';
import { Button, FRAME_MS, mirrorButtons, parseLoadout, verifyMoveHash, type MatchEndMessage } from '@sticxcape/shared';
import { createFakeRelay } from '../src/fake-relay.ts';
import type { MatchSession } from '../src/session.ts';
import { RelayClient } from '../src/relay-client.ts';
import { ToyMatch, toyBotInput, toyLoadout } from '../src/toy-match.ts';
import { ToySim } from '../src/toy-sim.ts';
import { linkedSessions } from './helpers.ts';

describe('toy loadout', () => {
  it('is a valid loadout whose precomputed hash is right', async () => {
    const loadout = toyLoadout();
    expect(parseLoadout(loadout)).toEqual(loadout);
    expect(await verifyMoveHash(loadout[0]!)).toBe(true);
  });
});

describe('ToySim', () => {
  it('gives the same state for the same seed and inputs', () => {
    const a = new ToySim(99);
    const b = new ToySim(99);
    const bot = toyBotInput(1);
    for (let frame = 0; frame < 600; frame++) {
      const inputs: [number, number] = [bot(a, 0), bot(a, 1)];
      a.step(inputs);
      b.step(inputs);
    }
    expect(a.hash()).toBe(b.hash());
    expect(a.health).not.toEqual([100, 100]);
    expect(new ToySim(98).hash()).not.toBe(new ToySim(99).hash());
  });
});

describe('ToyMatch', () => {
  const STEP = FRAME_MS + 0.001;

  /** Runs both sides frame by frame through the in-memory relay until both have a result (and so have reported it). */
  function play(options: ConstructorParameters<typeof ToyMatch>[1] = {}) {
    const { sessions, sent, deliver } = linkedSessions();
    const matches = sessions.map((session) => new ToyMatch(session, options));
    const desyncs: number[] = [];
    for (const session of sessions) session.onDesync((frame) => desyncs.push(frame));
    let t = 0;
    for (let i = 0; i < 5000 && !matches.every((m) => m.result !== undefined); i++) {
      for (const match of matches) match.update(t);
      deliver();
      t += STEP;
    }
    const ends = sent.map((messages) => messages.filter((m) => m.type === 'end'));
    return { matches, ends, desyncs };
  }

  it('plays to a knockout with both phones agreeing on the result', () => {
    const { matches, ends, desyncs } = play();
    const [left, right] = matches;
    expect(left!.result).not.toBeUndefined();
    expect(left!.result).toBe(right!.result);
    expect(left!.sim.over).toBe(true);
    expect(left!.sim.hash()).toBe(right!.sim.hash());
    expect(ends).toEqual([[{ type: 'end', winner: left!.result }], [{ type: 'end', winner: left!.result }]]);
    expect(desyncs).toEqual([]);
  });

  it('calls the match at the frame limit for whoever leads, or a draw', () => {
    const { matches } = play({ input: () => 0, maxFrames: 120 });
    expect(matches.map((m) => [m.result, m.sim.frame])).toEqual([
      [null, 120],
      [null, 120],
    ]);
  });

  it('reports a desync when the states differ', () => {
    let side = 0;
    const { desyncs } = play({ stateHash: (sim) => sim.hash() + side++ });
    expect(desyncs).toEqual([0, 0]);
  });
});

describe('fake relay', () => {
  it('runs the whole room flow offline against Echo', async () => {
    const client = new RelayClient(createFakeRelay({ seed: 5 }), { pingIntervalMs: 60_000 });
    try {
      const joined = await client.join('local', '  Ana ');
      expect(joined).toMatchObject({ player: 1, host: true });
      expect(joined.room.players.map((p) => p.nickname)).toEqual(['Ana', 'Echo']);

      const loadout = new Promise((resolve) => client.on('loadout', resolve));
      client.sendLoadout(toyLoadout());
      expect(await loadout).toEqual({ player: 2, moves: toyLoadout() });

      const started = new Promise<MatchSession>((resolve) => client.on('start', resolve));
      client.ready();
      const session = await started;
      expect(session).toMatchObject({ seed: 5, inputDelay: 3, fighters: [1, 2], localSide: 0 });

      for (let frame = 0; frame < 4; frame++) {
        session.pushLocalInput(frame === 0 ? Button.Left | Button.Light : 0);
        if (frame < 3) session.step();
      }
      await vi.waitFor(() => expect(session.canStep()).toBe(true));
      // Echo plays your own input back, mirrored.
      expect(session.step()).toEqual([Button.Left | Button.Light, mirrorButtons(Button.Left | Button.Light)]);

      const ended = new Promise<MatchEndMessage>((resolve) => client.on('end', resolve));
      session.finish(1);
      expect(await ended).toEqual({ type: 'end', winner: 1, reason: 'finished' });
      expect(client.session).toBeNull();
    } finally {
      client.close();
    }
  });

  it('finds Echo for a quick match at once, and leaves cleanly', async () => {
    const client = new RelayClient(createFakeRelay({ seed: 5 }), { pingIntervalMs: 60_000 });
    try {
      const queued = new Promise((resolve) => client.on('queued', resolve));
      const matched = new Promise((resolve) => client.on('matched', resolve));
      client.quickMatch('Ana');
      expect(client.searching).toBe(true);
      await queued;
      expect(await matched).toEqual({ id: 'echo-fake-relay0', nickname: 'Echo' });
      expect(client).toMatchObject({ searching: false, player: 1, opponent: { nickname: 'Echo' } });
      expect(client.room?.players.map((p) => p.nickname)).toEqual(['Ana', 'Echo']);

      client.leave();
      expect(client).toMatchObject({ player: null, room: null, opponent: null, searching: false });
    } finally {
      client.close();
    }
  });

  it('wants a loadout before ready', async () => {
    const client = new RelayClient(createFakeRelay(), { pingIntervalMs: 60_000 });
    await client.join('local', 'Ana');
    const error = new Promise((resolve) => client.on('error', resolve));
    client.ready();
    expect(await error).toMatchObject({ code: 'no_loadout' });
    const closed = new Promise((resolve) => client.on('close', resolve));
    client.close();
    expect(await closed).toBe('closed');
  });
});
