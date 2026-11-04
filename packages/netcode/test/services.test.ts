import { describe, expect, it, vi } from 'vitest';
import { PLAYER_ID_HEADER, type MatchTipsRequest, type MoveNameRequest } from '@sticxcape/shared';
import { ApiRequestError, CannedAiService, HttpAiService, playerId, ServicesClient } from '../src/services.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MOVE: MoveNameRequest = { slot: 'heavy', limb: 'rightWrist', height: 'high', peakSpeed: 8, keyframes: ['a', 'b', 'c'] };
const STATS: MatchTipsRequest = {
  moves: [{ name: 'Haymaker', slot: 'heavy', uses: 5, hits: 1, blocks: 1, parries: 3, misses: 0 }],
  damageDealt: 12,
  damageTaken: 40,
};

describe('ServicesClient', () => {
  it('creates and looks up rooms over JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/rooms') ? json(201, { code: 'c0de', link: 'https://play.example/r/c0de' }) : json(404, { error: 'not_found', message: 'Room not found or expired' }),
    );
    const services = new ServicesClient({ baseUrl: 'https://play.example/', fetch });
    expect(services.relayUrl).toBe('wss://play.example/ws');
    expect(await services.createRoom('Ana')).toEqual({ code: 'c0de', link: 'https://play.example/r/c0de' });
    expect(fetch.mock.calls[0]).toEqual([
      'https://play.example/rooms',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nickname":"Ana"}' },
    ]);
    expect(await services.getRoom('missing')).toBeNull();
  });

  it('turns error replies into ApiRequestError', async () => {
    const services = new ServicesClient({ baseUrl: 'http://localhost:8080', fetch: async () => json(429, { error: 'too_many_rooms', message: 'Slow down' }) });
    expect(services.relayUrl).toBe('ws://localhost:8080/ws');
    const error = await services.createRoom('Ana').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, error: 'too_many_rooms', message: 'Slow down' });
  });
});

describe('HttpAiService', () => {
  it('returns the Meta AI name and sends the player id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { name: 'Thunder Fist', description: 'A big right hand.' }));
    const ai = new HttpAiService({ baseUrl: 'https://play.example', fetch, playerId: 'player-0001' });
    expect(await ai.suggestMoveName(MOVE)).toEqual({ name: 'Thunder Fist', description: 'A big right hand.', source: 'ai' });
    const init = fetch.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)[PLAYER_ID_HEADER]).toBe('player-0001');
    expect(JSON.parse(init.body as string)).toEqual(MOVE);
  });

  it('falls back to the default name on any failure', async () => {
    const replies: (() => Promise<Response>)[] = [
      async () => json(503, { error: 'ai_unavailable' }),
      async () => json(429, { error: 'rate_limited' }),
      async () => {
        throw new TypeError('network down');
      },
      async () => new Response('<html>', { status: 200 }),
    ];
    for (const reply of replies) {
      const ai = new HttpAiService({ baseUrl: 'https://play.example', fetch: reply, playerId: 'player-0001' });
      expect(await ai.suggestMoveName(MOVE, 2)).toEqual({ name: 'Heavy 2', description: null, source: 'default' });
    }
  });

  it('gives up after its time budget', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const ai = new HttpAiService({ baseUrl: 'https://play.example', fetch, playerId: 'player-0001', timeoutMs: 30 });
    expect(await ai.suggestMoveName(MOVE)).toMatchObject({ name: 'Heavy 1', source: 'default' });
    expect(await ai.getMatchTips(STATS)).toEqual([]);
  });

  it('shows exactly 2 tips or none', async () => {
    const two = new HttpAiService({ baseUrl: '', fetch: async () => json(200, { tips: ['One.', 'Two.'] }), playerId: 'player-0001' });
    expect(await two.getMatchTips(STATS)).toEqual(['One.', 'Two.']);
    const three = new HttpAiService({ baseUrl: '', fetch: async () => json(200, { tips: ['One.', 'Two.', 'Three.'] }), playerId: 'player-0001' });
    expect(await three.getMatchTips(STATS)).toEqual([]);
  });
});

describe('CannedAiService', () => {
  it('names moves and gives 2 tips offline', async () => {
    const ai = new CannedAiService();
    expect(await ai.suggestMoveName(MOVE, 2)).toMatchObject({ name: 'Thunder Fist 2', source: 'ai' });
    const tips = await ai.getMatchTips(STATS);
    expect(tips).toHaveLength(2);
    expect(tips[0]).toMatch(/Haymaker was parried 3 times/);
  });
});

describe('playerId', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
  }

  it('keeps one id per browser', () => {
    const storage = memoryStorage();
    const id = playerId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(playerId(storage)).toBe(id);
  });

  it('replaces a bad saved id and survives blocked storage', () => {
    const storage = memoryStorage({ 'sticxcape.playerId': 'bad id!' });
    const id = playerId(storage);
    expect(id).not.toBe('bad id!');
    expect(storage.values.get('sticxcape.playerId')).toBe(id);

    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(playerId(blocked)).toMatch(/^[0-9a-f-]{36}$/);
    expect(playerId(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
