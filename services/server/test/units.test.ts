import { describe, expect, it } from 'vitest';
import { isRoomCode } from '@sticxcape/shared';
import { loadConfig } from '../src/config.ts';
import { DailyQuota, LruCache, RollingSamples, TokenBucket, WindowLimiter } from '../src/lib/limits.ts';
import { newRoomCode, newSeed } from '../src/lib/random.ts';
import { RoomStore, type Room } from '../src/rooms/room-store.ts';
import { FakeClock } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

describe('RoomStore', () => {
  function store(clock: FakeClock, maxRooms = 10, codes?: string[]) {
    const removed: string[] = [];
    const rooms = new RoomStore({ maxRooms, emptyTtlMs: HOUR, now: clock.now, ...(codes ? { newCode: () => codes.shift()! } : {}) });
    rooms.onRemove((room) => removed.push(room.code));
    return { rooms, removed };
  }

  it('makes unguessable codes and never reuses a live one', () => {
    const clock = new FakeClock();
    const { rooms } = store(clock, 10, ['aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    expect(rooms.create('Ana')!.code).toBe('aaaaaaaaaaaaaaaa');
    expect(rooms.create('Bo')!.code).toBe('bbbbbbbbbbbbbbbb');
    for (let i = 0; i < 100; i++) expect(isRoomCode(newRoomCode())).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, newRoomCode)).size).toBe(1000);
    expect(Number.isInteger(newSeed()) && newSeed() >= 0 && newSeed() <= 0xffffffff).toBe(true);
  });

  it('numbers players from 1, lets the first host and hands hosting to the lowest number', () => {
    const clock = new FakeClock();
    const room: Room = store(clock).rooms.create('Ana')!;
    expect(['Ana', 'Bo', 'Cy'].map((n) => room.addMember(n)!.player)).toEqual([1, 2, 3]);
    expect(room.host).toBe(1);
    room.removeMember(2, clock.now());
    expect(room.addMember('Di')!.player).toBe(2);
    room.removeMember(1, clock.now());
    expect(room.host).toBe(2);
    expect(room.summary().players).toEqual([
      { player: 2, nickname: 'Di', host: true },
      { player: 3, nickname: 'Cy', host: false },
    ]);
    for (let i = 0; i < 6; i++) room.addMember(`P${i}`);
    expect(room.isFull).toBe(true);
    expect(room.addMember('Late')).toBeNull();
  });

  it('expires rooms an hour after they empty', () => {
    const clock = new FakeClock();
    const { rooms, removed } = store(clock);
    const room = rooms.create('Ana')!;
    room.addMember('Ana');
    clock.advance(2 * HOUR);
    expect(rooms.get(room.code)).toBe(room);

    room.removeMember(1, clock.now());
    clock.advance(HOUR - 1);
    expect(rooms.sweep()).toBe(0);
    clock.advance(1);
    expect(rooms.get(room.code)).toBeUndefined();
    expect(removed).toEqual([room.code]);
    expect(rooms.size).toBe(0);
  });

  it('clears out expired rooms before refusing new ones', () => {
    const clock = new FakeClock();
    const { rooms } = store(clock, 2);
    rooms.create('Ana');
    rooms.create('Bo');
    expect(rooms.create('Cy')).toBeNull();
    clock.advance(HOUR);
    expect(rooms.create('Cy')).not.toBeNull();
    expect(rooms.size).toBe(1);
  });
});

describe('limits', () => {
  it('TokenBucket allows a burst, then the steady rate', () => {
    const bucket = new TokenBucket(10, 3, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(0))).toEqual([true, true, true, false]);
    expect(bucket.take(50)).toBe(false);
    expect(bucket.take(100)).toBe(true);
    expect(bucket.take(10_000)).toBe(true);
    expect([1, 2, 3].map(() => bucket.take(10_000))).toEqual([true, true, false]);
  });

  it('WindowLimiter counts per key in fixed windows', () => {
    const limiter = new WindowLimiter(2, 1000);
    expect([limiter.take('a', 0), limiter.take('a', 10), limiter.take('a', 20), limiter.take('b', 20)]).toEqual([true, true, false, true]);
    expect(limiter.take('a', 1000)).toBe(true);
    limiter.prune(5000);
    expect(limiter.take('a', 5000)).toBe(true);
  });

  it('DailyQuota resets at midnight UTC and refunds failures', () => {
    const quota = new DailyQuota(2, 3);
    const day = Date.UTC(2026, 10, 3);
    expect([quota.take('a', day), quota.take('a', day + 1), quota.take('a', day + 2)]).toEqual([true, true, false]);
    quota.refund('a');
    expect(quota.take('a', day + 3)).toBe(true);
    expect([quota.take('b', day), quota.take('c', day), quota.take('d', day)]).toEqual([true, true, false]);
    expect(quota.take('a', day + 24 * HOUR)).toBe(true);
    expect(quota.take('d', day + 24 * HOUR)).toBe(true);
  });

  it('LruCache drops the least recent entry and expired ones', () => {
    const cache = new LruCache<number>(2, 1000);
    cache.set('a', 1, 0);
    cache.set('b', 2, 0);
    expect(cache.get('a', 10)).toBe(1);
    cache.set('c', 3, 10);
    expect([cache.get('a', 10), cache.get('b', 10), cache.get('c', 10)]).toEqual([1, undefined, 3]);
    expect(cache.get('a', 1000)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('RollingSamples keeps the latest values for percentiles', () => {
    const samples = new RollingSamples(4);
    expect(samples.percentile(50)).toBeNull();
    for (const v of [100, 1, 2, 3, 4]) samples.push(v);
    expect(samples.count).toBe(4);
    expect([samples.percentile(0), samples.percentile(50), samples.percentile(100)]).toEqual([1, 3, 4]);
  });
});

describe('loadConfig', () => {
  it('has working defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ env: 'development', host: '0.0.0.0', port: 8080, publicUrl: null, trustProxy: 0, allowedOrigins: [], tls: null });
    expect(config.ai).toMatchObject({ apiKey: null, model: 'muse-spark-1.1', reasoningEffort: 'minimal', timeoutMs: 4500, moveNamesPerDay: 30, matchTipsPerDay: 60 });
    expect(config.labRoot).not.toBeNull();
  });

  it('reads and checks settings', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '3000',
      PUBLIC_URL: 'https://play.example/some/path',
      MODEL_API_BASE_URL: 'https://api.example/v1///',
      LAB: 'off',
      METRICS_PORT: '9091',
      AI_MODEL: 'muse-spark-1.3',
      AI_REASONING_EFFORT: 'low',
    });
    expect(config).toMatchObject({ env: 'production', port: 3000, publicUrl: 'https://play.example', allowedOrigins: ['https://play.example'], labRoot: null });
    expect(config.ai).toMatchObject({ baseUrl: 'https://api.example/v1', model: 'muse-spark-1.3', reasoningEffort: 'low' });
    expect(config.monitoring.metricsPort).toBe(9091);
    expect(loadConfig({ ALLOWED_ORIGINS: 'https://a.example/x, http://b.example:8080' }).allowedOrigins).toEqual(['https://a.example', 'http://b.example:8080']);
  });

  it('refuses bad settings with a clear message', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow('PORT must be a whole number from 0 to 65535');
    expect(() => loadConfig({ TRUST_PROXY: '11' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ TLS_CERT_FILE: 'cert.pem' })).toThrow(/TLS_CERT_FILE and TLS_KEY_FILE/);
    expect(() => loadConfig({ PUBLIC_URL: 'play.example' })).toThrow(/PUBLIC_URL must be a URL/);
    expect(() => loadConfig({ PUBLIC_URL: 'ftp://play.example' })).toThrow(/http or https/);
    expect(() => loadConfig({ LAB: 'maybe' })).toThrow('LAB must be true or false');
    // Muse Spark answers "none" with HTTP 400, so it would turn every AI call into a fallback.
    expect(() => loadConfig({ AI_REASONING_EFFORT: 'none' })).toThrow('AI_REASONING_EFFORT must be one of: minimal, low, medium, high, xhigh, max');
  });
});
