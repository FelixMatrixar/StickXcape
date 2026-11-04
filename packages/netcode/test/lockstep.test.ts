import { describe, expect, it } from 'vitest';
import { Button, FRAME_MS } from '@sticxcape/shared';
import { LockstepDriver } from '../src/driver.ts';
import { MatchSession } from '../src/session.ts';
import { linkedSessions, START } from './helpers.ts';

describe('MatchSession with input delay', () => {
  it('runs the first inputDelay frames on neutral input, then waits for the opponent', () => {
    const { sessions, sent, deliver } = linkedSessions();
    const [left, right] = sessions;

    for (let frame = 0; frame < 3; frame++) {
      expect(left.needsLocalInput()).toBe(true);
      left.pushLocalInput(frame === 0 ? Button.Right : 0);
      expect(left.needsLocalInput()).toBe(false);
      expect(left.step()).toEqual([0, 0]);
    }
    expect(sent[0][0]).toEqual({ type: 'input', frame: 3, buttons: Button.Right });
    expect(left.frame).toBe(3);
    expect(left.canStep()).toBe(false);
    expect(() => left.step()).toThrow(/frame 3/);

    right.pushLocalInput(Button.Light);
    deliver();
    expect(left.canStep()).toBe(true);
    // Always in fighter order: left, then right, on both phones.
    expect(left.step()).toEqual([Button.Right, Button.Light]);
    for (let frame = 0; frame < 3; frame++) right.step();
    right.pushLocalInput(0);
    right.pushLocalInput(0);
    expect(right.step()).toEqual([Button.Right, Button.Light]);
  });

  it('sends cleaned buttons', () => {
    const { sessions, sent } = linkedSessions();
    sessions[0].pushLocalInput(Button.Left | Button.Right | Button.Heavy);
    expect(sent[0][0]).toEqual({ type: 'input', frame: 3, buttons: Button.Heavy });
  });

  it('ignores stray and repeated inputs from the relay', () => {
    const { sessions } = linkedSessions();
    const [left] = sessions;
    for (let frame = 0; frame < 3; frame++) {
      left.pushLocalInput(0);
      left.step();
    }
    left.pushLocalInput(0);
    left.receive({ type: 'input', frame: 9, buttons: Button.Up });
    expect(left.canStep()).toBe(false);
    left.receive({ type: 'input', frame: 3, buttons: Button.Down });
    left.receive({ type: 'input', frame: 3, buttons: Button.Up });
    expect(left.step()).toEqual([0, Button.Down]);
  });

  it('hashes only on hash frames and reports the first desync once', () => {
    const { sessions, sent, deliver } = linkedSessions();
    const [left, right] = sessions;
    const desyncs: number[][] = [[], []];
    left.onDesync((frame) => desyncs[0]!.push(frame));
    right.onDesync((frame) => desyncs[1]!.push(frame));

    left.submitHash(1, 5);
    expect(sent[0]).toEqual([]);
    left.submitHash(0, -1);
    left.submitHash(0, 7);
    expect(sent[0]).toEqual([{ type: 'hash', frame: 0, stateHash: 0xffffffff }]);

    right.submitHash(0, 0xffffffff);
    deliver();
    expect(desyncs).toEqual([[], []]);

    left.submitHash(60, 1);
    right.submitHash(60, 2);
    left.submitHash(120, 1);
    right.submitHash(120, 2);
    deliver();
    expect(desyncs).toEqual([[60], [60]]);
    expect(left.desyncFrame).toBe(60);
  });

  it('ends on the relay end message and goes quiet', () => {
    const { sessions, sent } = linkedSessions();
    const [left] = sessions;
    const ends: unknown[] = [];
    left.onEnd((end) => ends.push(end));
    left.finish(1);
    expect(sent[0]).toEqual([{ type: 'end', winner: 1 }]);

    left.receive({ type: 'end', winner: 1, reason: 'finished' });
    left.receive({ type: 'end', winner: 2, reason: 'desync' });
    expect(ends).toEqual([{ type: 'end', winner: 1, reason: 'finished' }]);
    expect(left).toMatchObject({ ended: true, endReason: 'finished', winner: 1 });
    expect(left.needsLocalInput()).toBe(false);
    expect(left.canStep()).toBe(false);
    left.finish(2);
    left.pushLocalInput(Button.Up);
    expect(sent[0]).toHaveLength(1);
  });

  it('knows its side and its opponent', () => {
    const { sessions } = linkedSessions({ ...START, fighters: [5, 2] });
    expect(sessions.map((s) => [s.localPlayer, s.localSide, s.opponent])).toEqual([
      [5, 0, 2],
      [2, 1, 5],
    ]);
    expect(() => new MatchSession({ localPlayer: 3, start: START, send: () => {} })).toThrow(/not fighting/);
  });
});

describe('LockstepDriver', () => {
  // A hair over one frame, so floating-point rounding never leaves an update just short of a step.
  const STEP = FRAME_MS + 0.001;
  const hooks = (simulated: number[], hashed: number[]) => ({
    sampleInput: () => 0,
    simulate: (_inputs: [number, number], frame: number) => void simulated.push(frame),
    stateHash: () => {
      hashed.push(simulated.at(-1)!);
      return 42;
    },
  });

  it('steps at 60 Hz, hashes every 60 frames and catches up at most 4 frames per update', () => {
    const { sessions } = linkedSessions();
    const [left] = sessions;
    for (let frame = 3; frame < 400; frame++) left.receive({ type: 'input', frame, buttons: 0 });
    const simulated: number[] = [];
    const hashed: number[] = [];
    const driver = new LockstepDriver(left, hooks(simulated, hashed));

    let t = 1000;
    for (let i = 0; i < 70; i++) {
      expect(driver.update(t)).toBe(1);
      t += STEP;
    }
    expect(simulated).toEqual(Array.from({ length: 70 }, (_, i) => i));
    expect(hashed).toEqual([0, 60]);

    // A 200 ms hitch: 12 frames are owed, caught up 4 at a time.
    t += 200;
    const batches = [driver.update(t), driver.update(t), driver.update(t), driver.update(t)];
    expect(batches[0]).toBe(4);
    expect(Math.max(...batches)).toBeLessThanOrEqual(4);
    expect(simulated.length - 70).toBeGreaterThanOrEqual(11);
    expect(simulated.length - 70).toBeLessThanOrEqual(13);
  });

  it('never banks time while waiting for the opponent', () => {
    const { sessions } = linkedSessions();
    const [left] = sessions;
    const simulated: number[] = [];
    const driver = new LockstepDriver(left, hooks(simulated, []));

    let t = 0;
    for (let i = 0; i < 3; i++) {
      driver.update(t);
      t += STEP;
    }
    expect(simulated).toEqual([0, 1, 2]);
    t += 1000;
    expect(driver.update(t)).toBe(0);
    expect(driver.stalled).toBe(true);

    for (let frame = 3; frame < 40; frame++) left.receive({ type: 'input', frame, buttons: 0 });
    expect(driver.update(t + STEP)).toBeLessThanOrEqual(2);
    expect(driver.stalled).toBe(false);
  });
});
