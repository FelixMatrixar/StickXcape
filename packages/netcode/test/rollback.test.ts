import { describe, expect, it } from 'vitest';
import {
  Button,
  FRAME_MS,
  MAX_ROLLBACK_FRAMES,
  Rng,
  ROLLBACK_INPUT_DELAY,
  type ClientMessage,
  type StartMessage,
} from '@sticxcape/shared';
import { createFakeRelay } from '../src/fake-relay.ts';
import { RelayClient } from '../src/relay-client.ts';
import { RollbackDriver, type RollbackHooks } from '../src/rollback-driver.ts';
import { MatchSession } from '../src/session.ts';
import { ToyMatch, toyLoadout, type ToyMatchOptions } from '../src/toy-match.ts';
import { ToySim } from '../src/toy-sim.ts';
import { linkedSessions } from './helpers.ts';

const ROLLBACK_START: StartMessage = {
  type: 'start',
  seed: 4321,
  inputDelay: ROLLBACK_INPUT_DELAY,
  startFrame: 0,
  fighters: [1, 2],
  arenaId: null,
  rollback: MAX_ROLLBACK_FRAMES,
};
// A hair over one frame, so floating-point rounding never leaves an update just short of a step.
const STEP = FRAME_MS + 0.001;
const frames = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** Hooks that record what the driver asks for; the "state" is the number of frames played. */
function recorder() {
  const calls: [number, [number, number], boolean][] = [];
  const loads: number[] = [];
  let state = 0;
  const hooks: RollbackHooks<number> = {
    sampleInput: () => 0,
    simulate: (inputs, frame, replay) => {
      calls.push([frame, inputs, replay]);
      state = frame + 1;
    },
    save: () => state,
    load: (saved) => {
      loads.push(saved);
      state = saved;
    },
    stateHash: () => state,
  };
  return { calls, loads, hooks };
}

describe('RollbackDriver', () => {
  it('plays up to 8 frames on a guess, then waits for the opponent', () => {
    const { sessions } = linkedSessions(ROLLBACK_START);
    const [left] = sessions;
    const { calls, hooks } = recorder();
    const driver = new RollbackDriver(left, hooks);
    let t = 0;
    for (let i = 0; i < 30; i++) {
      driver.update(t);
      t += STEP;
    }
    // Frames 0 and 1 come before anyone's first input; 2 to 9 are guesses; then it waits.
    expect(calls.map(([frame]) => frame)).toEqual(frames(0, 10));
    expect(driver.stalled).toBe(true);
    expect(left.stalledFor()).toBeGreaterThan(0);
    expect(left.confirmedFrame).toBe(1);

    // Two inputs arrive: two more frames may go, and the waiting time held back plays them now.
    left.receive({ type: 'input', frame: 2, buttons: 0 });
    left.receive({ type: 'input', frame: 3, buttons: 0 });
    expect(driver.update(t)).toBe(2);
    expect(driver.stalled).toBe(false);
  });

  it('rewinds to the first wrong guess and replays every frame since, with the real input', () => {
    const { sessions } = linkedSessions(ROLLBACK_START);
    const [left] = sessions;
    const { calls, loads, hooks } = recorder();
    const driver = new RollbackDriver(left, hooks);
    let t = 0;
    for (let i = 0; i < 6; i++) {
      driver.update(t);
      t += STEP;
    }
    expect(calls.map(([frame]) => frame)).toEqual(frames(0, 6));

    left.receive({ type: 'input', frame: 2, buttons: 0 }); // guessed right: nothing to redo
    left.receive({ type: 'input', frame: 3, buttons: Button.Light }); // guessed wrong
    calls.length = 0;
    driver.update(t);

    // Back to the state before frame 3, then 3 to 5 again; frame 6 is new, guessing they still hold Light.
    expect(loads).toEqual([3]);
    expect(calls).toEqual([
      [3, [0, Button.Light], true],
      [4, [0, Button.Light], true],
      [5, [0, Button.Light], true],
      [6, [0, Button.Light], false],
    ]);
    expect(driver.stats).toMatchObject({ frames: 7, rollbacks: 1, replayedFrames: 3, deepest: 3 });

    // The guess for 4 to 6 is now right, so their inputs arriving changes nothing.
    for (const frame of [4, 5, 6]) left.receive({ type: 'input', frame, buttons: Button.Light });
    calls.length = 0;
    driver.update(t + STEP);
    expect(calls).toEqual([[7, [0, Button.Light], false]]);
    expect(driver.stats.rollbacks).toBe(1);
  });

  it('sends a state hash only once its frame is final', () => {
    const { sessions, sent } = linkedSessions(ROLLBACK_START);
    const [left] = sessions;
    const driver = new RollbackDriver(left, recorder().hooks);
    const hashFrames = () => sent[0].flatMap((m) => (m.type === 'hash' ? [m.frame] : []));
    let t = 0;
    let next = ROLLBACK_START.inputDelay;
    for (let i = 0; i < 63; i++) {
      driver.update(t);
      t += STEP;
      // The opponent's inputs arrive 5 frames late.
      while (next <= left.frame - 5) left.receive({ type: 'input', frame: next++, buttons: 0 });
    }
    expect(left.frame).toBe(63);
    expect(left.confirmedFrame).toBe(58);
    expect(hashFrames()).toEqual([0]);

    for (; next <= 60; next++) left.receive({ type: 'input', frame: next, buttons: 0 });
    driver.update(t);
    expect(hashFrames()).toEqual([0, 60]);
    // The hash is of the state after frame 60, recomputed by any replay before it was sent.
    expect(sent[0].find((m) => m.type === 'hash' && m.frame === 60)).toEqual({ type: 'hash', frame: 60, stateHash: 61 });
  });

  it('drops inputs and saves that no rewind can reach', () => {
    const { sessions } = linkedSessions(ROLLBACK_START);
    const [left] = sessions;
    const saves: number[] = [];
    const hooks = recorder().hooks;
    const driver = new RollbackDriver(left, { ...hooks, save: () => saves.push(left.frame) });
    let t = 0;
    for (let i = 0; i < 200; i++) {
      driver.update(t);
      t += STEP;
      left.receive({ type: 'input', frame: left.frame - 3, buttons: 0 });
    }
    // Inputs arrive every frame, 3 frames late: each frame is saved once, and only while it is a guess.
    expect(saves.length).toBeLessThanOrEqual(200);
    const internals = left as unknown as { local: Map<number, number>; remote: Map<number, number>; guesses: Map<number, number> };
    expect(internals.remote.size).toBeLessThanOrEqual(1);
    expect(internals.guesses.size).toBeLessThanOrEqual(4);
    expect(internals.local.size).toBeLessThanOrEqual(MAX_ROLLBACK_FRAMES + ROLLBACK_START.inputDelay);
  });
});

interface NetworkOptions {
  /** Delay each way between the phones, in ms. */
  oneWayMs: number;
  /** Each message's delay varies by up to this many ms either way; order is kept. */
  jitterMs?: number;
  /** The right phone starts this many ms after the left, as when the start message reaches it later. */
  skewMs?: number;
  match?: ToyMatchOptions;
  /** Stop after this long, in ms of simulated time. */
  limitMs?: number;
}

/**
 * Two phones playing a rollback toy match over a simulated network, on a fake clock that
 * ticks every 4 ms like the bot script. Runs until both phones have reported a result.
 */
function playOverNetwork(options: NetworkOptions) {
  const { oneWayMs, jitterMs = 0, skewMs = 0, limitMs = 120_000 } = options;
  const rng = new Rng(77);
  let now = 0;
  type InFlight = { at: number; message: ClientMessage }[];
  const inFlight: [InFlight, InFlight] = [[], []];
  const sent: [ClientMessage[], ClientMessage[]] = [[], []];
  /** Each phone's confirmed frame at the moment it reported the result. */
  const confirmedAtEnd: number[] = [];
  const sessions: MatchSession[] = [];
  for (const side of [0, 1] as const) {
    sessions.push(
      new MatchSession({
        localPlayer: ROLLBACK_START.fighters[side],
        start: ROLLBACK_START,
        now: () => now - (side === 1 ? skewMs : 0),
        send: (message) => {
          sent[side].push(message);
          if (message.type === 'end') confirmedAtEnd[side] = sessions[side]!.confirmedFrame;
          const jitter = jitterMs > 0 ? rng.nextInt(2 * jitterMs + 1) - jitterMs : 0;
          const last = inFlight[side].at(-1)?.at ?? 0;
          inFlight[side].push({ at: Math.max(last, now + Math.max(0, oneWayMs + jitter)), message });
        },
      }),
    );
  }
  const matches = sessions.map((session) => new ToyMatch(session, options.match));
  const desyncs: number[] = [];
  for (const session of sessions) session.onDesync((frame) => desyncs.push(frame));
  const stalledMs: [number, number] = [0, 0];
  /** The left phone's frame minus the right's, every tick once both are running. */
  const lead: { t: number; frames: number }[] = [];

  const TICK_MS = 4;
  for (; now < limitMs; now += TICK_MS) {
    for (const side of [0, 1] as const) {
      const queue = inFlight[side];
      while (queue.length > 0 && queue[0]!.at <= now) {
        const { message } = queue.shift()!;
        if (message.type === 'input' || message.type === 'hash' || message.type === 'sync') sessions[side === 0 ? 1 : 0]!.receive(message);
      }
    }
    matches[0]!.update(now);
    if (now >= skewMs) {
      matches[1]!.update(now - skewMs);
      lead.push({ t: now, frames: sessions[0]!.frame - sessions[1]!.frame });
    }
    for (const side of [0, 1] as const) if (matches[side]!.stalled) stalledMs[side] += TICK_MS;
    if (sent.every((messages) => messages.some((m) => m.type === 'end'))) break;
  }
  const ends = sent.map((messages) => messages.filter((m) => m.type === 'end'));
  return { matches, sessions, sent, ends, desyncs, confirmedAtEnd, stalledMs, lead, elapsedMs: now };
}

/** Plays the inputs both phones sent through a fresh ToySim, with no guessing at all. */
function cleanReplay(sent: ClientMessage[][], untilFrame: number): ToySim {
  const logs = sent.map((messages) => new Map(messages.flatMap((m) => (m.type === 'input' ? [[m.frame, m.buttons] as const] : []))));
  const sim = new ToySim(ROLLBACK_START.seed);
  for (let frame = 0; frame < untilFrame; frame++) sim.step([logs[0]!.get(frame) ?? 0, logs[1]!.get(frame) ?? 0]);
  return sim;
}

describe('rollback toy matches over a simulated network', () => {
  it('play to the same result as a clean run of the same inputs, 100 ms between the phones', () => {
    const { matches, sent, ends, desyncs, confirmedAtEnd, stalledMs, elapsedMs } = playOverNetwork({ oneWayMs: 50, jitterMs: 10 });
    const [left, right] = matches as [ToyMatch, ToyMatch];

    expect(ends[0]).toEqual(ends[1]);
    expect(ends[0]).toEqual([{ type: 'end', winner: left.result }]);
    expect(desyncs).toEqual([]);
    expect(left.sim.over).toBe(true);
    // Every guess was corrected: both phones hold exactly the fight a clean run gives.
    expect(left.sim.hash()).toBe(right.sim.hash());
    expect(cleanReplay(sent, left.sim.frame).hash()).toBe(left.sim.hash());

    // 50 ms is 3 frames each way against 2 of input delay, so the phones guessed and corrected,
    // never more than 8 frames back, and almost never waited.
    for (const match of matches) {
      expect(match.rollbackStats!.rollbacks).toBeGreaterThan(0);
      expect(match.rollbackStats!.deepest).toBeLessThanOrEqual(MAX_ROLLBACK_FRAMES);
    }
    expect(Math.max(...stalledMs) / elapsedMs).toBeLessThan(0.01);
    // The result went to the relay only once the deciding frame was final.
    for (const side of [0, 1]) expect(confirmedAtEnd[side]).toBeGreaterThanOrEqual(matches[side]!.sim.frame - 1);
  });

  it('stays smooth at 250 ms between the phones, rewinding at most 8 frames', () => {
    const { matches, sent, ends, desyncs, stalledMs, elapsedMs } = playOverNetwork({ oneWayMs: 125, jitterMs: 8 });
    expect(ends[0]).toEqual(ends[1]);
    expect(desyncs).toEqual([]);
    expect(cleanReplay(sent, matches[0]!.sim.frame).hash()).toBe(matches[1]!.sim.hash());
    for (const match of matches) {
      expect(match.rollbackStats!.deepest).toBeGreaterThanOrEqual(6);
      expect(match.rollbackStats!.deepest).toBeLessThanOrEqual(MAX_ROLLBACK_FRAMES);
    }
    expect(Math.max(...stalledMs) / elapsedMs).toBeLessThan(0.05);
  });

  it('slows the phone that started first until both play the same frame at the same time', () => {
    // No buttons and a long fight: only the clocks matter here.
    const { matches, lead } = playOverNetwork({ oneWayMs: 40, skewMs: 100, match: { input: () => 0, maxFrames: 600 } });
    const average = (from: number, to: number) => {
      const window = lead.filter((sample) => sample.t >= from && sample.t < to);
      return window.reduce((sum, sample) => sum + sample.frames, 0) / window.length;
    };
    // The right phone started 100 ms (6 frames) later.
    expect(average(150, 450)).toBeGreaterThan(5);
    expect(Math.abs(average(4000, 9000))).toBeLessThan(1.5);
    expect(matches[0]!.rollbackStats!.slowedFrames).toBeGreaterThan(4);
    expect(matches[1]!.rollbackStats!.slowedFrames).toBeLessThan(1);
  });
});

describe('asking for rollback', () => {
  it('goes out with ready, and the fake relay starts a rollback match', async () => {
    const transport = createFakeRelay({ seed: 3 });
    const sentByClient: ClientMessage[] = [];
    const send = transport.send.bind(transport);
    transport.send = (message) => {
      sentByClient.push(message);
      send(message);
    };
    const client = new RelayClient(transport, { pingIntervalMs: 60_000, rollback: true });
    try {
      await client.join('local', 'Ana');
      client.sendLoadout(toyLoadout());
      const started = new Promise<MatchSession>((resolve) => client.on('start', resolve));
      client.ready();
      const session = await started;
      expect(sentByClient.find((m) => m.type === 'ready')).toEqual({ type: 'ready', rollback: true });
      expect(session).toMatchObject({ rollback: MAX_ROLLBACK_FRAMES, inputDelay: ROLLBACK_INPUT_DELAY });
    } finally {
      client.close();
    }
  });

  it('is off unless the game asks', async () => {
    const client = new RelayClient(createFakeRelay({ seed: 3 }), { pingIntervalMs: 60_000 });
    try {
      await client.join('local', 'Ana');
      client.sendLoadout(toyLoadout());
      const started = new Promise<MatchSession>((resolve) => client.on('start', resolve));
      client.ready();
      expect(await started).toMatchObject({ rollback: 0, inputDelay: 3 });
    } finally {
      client.close();
    }
  });
});
