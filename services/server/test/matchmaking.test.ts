import { describe, expect, it } from 'vitest';
import { computeMoveHash, decodeFrames, encodeFrames, FRAME_VALUES, type MoveFile } from '@sticxcape/shared';
import { toyLoadout } from '@sticxcape/netcode';
import { MoveSigner, moveHashSync } from '../src/accounts/signing.ts';
import type { Connection } from '../src/relay/connection.ts';
import { Matchmaker, pingWindow, ratingWindow, type Seeker } from '../src/relay/matchmaker.ts';

let next = 0;

/** A seeker whose connection measured `rttMs` to the relay. */
function seeker(rating: number, options: { since?: number; rttMs?: number; blocked?: string[]; account?: string } = {}): Seeker {
  const conn = { rtt: () => options.rttMs ?? 20 } as unknown as Connection;
  next += 1;
  return {
    conn,
    accountId: options.account ?? `account-${next}`.padEnd(16, '0'),
    nickname: `P${next}`,
    rating,
    since: options.since ?? 0,
    blocked: new Set(options.blocked ?? []),
  };
}

const ids = (pairs: [Seeker, Seeker][]) => pairs.map(([a, b]) => [a.nickname, b.nickname]);

describe('Matchmaker', () => {
  it('widens the rating and ping windows the longer someone waits, until anyone will do', () => {
    expect([ratingWindow(0), ratingWindow(10), ratingWindow(29), ratingWindow(30)]).toEqual([100, 350, 825, Infinity]);
    expect([pingWindow(0), pingWindow(10), pingWindow(30)]).toEqual([100, 250, Infinity]);
  });

  it('pairs the closest rating within the window, longest wait first', () => {
    const matchmaker = new Matchmaker();
    const a = seeker(1000, { since: 0 });
    const b = seeker(1400, { since: 1000 });
    const c = seeker(1060, { since: 2000 });
    const d = seeker(1030, { since: 3000 });
    for (const s of [a, b, c, d]) matchmaker.add(s);

    // a waited longest and takes d (30 points away) over c (60); b is 400 away from everyone.
    expect(ids(matchmaker.takePairs(3000))).toEqual([[a.nickname, d.nickname]]);
    expect(matchmaker.size).toBe(2);
    // b and c are 340 apart: b's window reaches that after it has waited 9.6 s.
    expect(matchmaker.takePairs(10_000)).toEqual([]);
    expect(ids(matchmaker.takePairs(11_000))).toEqual([[b.nickname, c.nickname]]);
    expect(matchmaker.size).toBe(0);
  });

  it('keeps ping between the phones under 100 ms at first', () => {
    const matchmaker = new Matchmaker();
    const far = seeker(1000, { rttMs: 90 });
    const near = seeker(1000, { rttMs: 40, since: 500 });
    matchmaker.add(far);
    matchmaker.add(near);
    // 130 ms between them is over 100 ms until the window reaches it after 2 s.
    expect(matchmaker.takePairs(1000)).toEqual([]);
    expect(matchmaker.takePairs(2100)).toHaveLength(1);
  });

  it('never pairs blocked players or one account with itself', () => {
    const matchmaker = new Matchmaker();
    const a = seeker(1000, { account: 'AAAAAAAAAAAAAAAA' });
    const b = seeker(1000, { account: 'BBBBBBBBBBBBBBBB', blocked: ['AAAAAAAAAAAAAAAA'] });
    const a2 = seeker(1000, { account: 'AAAAAAAAAAAAAAAA' });
    for (const s of [a, b, a2]) matchmaker.add(s);
    expect(matchmaker.takePairs(60_000)).toEqual([]);
    expect(matchmaker.remove(a.conn)).toBe(true);
    expect(matchmaker.remove(a.conn)).toBe(false);
    expect(matchmaker.has(b.conn)).toBe(true);
  });
});

describe('MoveSigner', () => {
  const move = toyLoadout()[0]!;
  const signer = new MoveSigner(new Uint8Array(32).fill(7));

  it('signs the hash of a move, which covers everything that decides how it plays', async () => {
    expect(moveHashSync(move)).toBe(await computeMoveHash(move));
    const signed = signer.sign(move);
    expect(signer.verify(signed)).toBe(true);
    expect(new MoveSigner(new Uint8Array(32).fill(8)).verify(signed)).toBe(false);
  });

  it('refuses unsigned moves, garbled signatures and altered frames under a copied hash', () => {
    const signed = signer.sign(move);
    expect(signer.verify(move)).toBe(false);
    expect(signer.verify({ ...signed, signature: 'v1.AAAA' })).toBe(false);
    expect(signer.verify({ ...signed, signature: signed.signature!.replace('v1.', 'v2.') })).toBe(false);
    const values = decodeFrames(move.frames)!;
    values[FRAME_VALUES + 2] = values[FRAME_VALUES + 2]! + 100;
    const altered: MoveFile = { ...signed, frames: encodeFrames(values) };
    expect(signer.verify(altered)).toBe(false);
  });
});
