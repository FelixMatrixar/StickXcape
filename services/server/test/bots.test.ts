import { afterEach, describe, expect, it } from 'vitest';
import { runBotMatches } from '../scripts/bot-matches.ts';
import { startServer, type TestServer } from './helpers.ts';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('bot matches', () => {
  it('play real-time matches through the relay over a slow, jittery network', async () => {
    server = await startServer();
    const report = await runBotMatches({ url: server.baseUrl, rooms: 3, matches: 2, latencyMs: 120, jitterMs: 10, maxFrames: 90 });

    expect(report.errors).toEqual([]);
    expect(report.matches).toBe(6);
    expect(report.reasons).toEqual({ finished: 6, desync: 0, disconnect: 0, room_closed: 0 });
    // 120 ms between the phones, plus a little for localhost, is over 80 ms, so the delay grows past 3 frames.
    expect(Math.min(...report.inputDelays)).toBeGreaterThan(3);
    expect(report.rttMs).toHaveLength(6);
    expect(Math.min(...report.rttMs)).toBeGreaterThanOrEqual(40);
    expect(server.services.metrics.matchesEnded.get({ reason: 'finished' })).toBe(6);
    expect(report.rollbackMatches).toBe(0);
  });

  it('play rollback matches over the same network with 2 frames of input delay, correcting late inputs', async () => {
    server = await startServer();
    const report = await runBotMatches({ url: server.baseUrl, rooms: 3, matches: 2, latencyMs: 120, jitterMs: 10, maxFrames: 90, rollback: true });

    expect(report.errors).toEqual([]);
    expect(report.reasons).toEqual({ finished: 6, desync: 0, disconnect: 0, room_closed: 0 });
    expect(report.rollbackMatches).toBe(6);
    expect(report.inputDelays).toEqual([2, 2, 2, 2, 2, 2]);
    // 60 ms each way is about 4 frames, against 2 of input delay: the bots guess, and sometimes guess wrong.
    expect(report.rollback.rollbacks).toBeGreaterThan(0);
    expect(report.rollback.deepest).toBeLessThanOrEqual(8);
    expect(report.stallShare).toBeLessThan(0.05);
    expect(server.services.metrics.matchesStarted.get({ netcode: 'rollback' })).toBe(6);
  });
});
