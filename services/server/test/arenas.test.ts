import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { toyLoadout, type RelayClient } from '@sticxcape/netcode';
import { ARENA_FORMAT_VERSION, photoArenaLayer, type ArenaFile, type ArenaPalette } from '@sticxcape/shared';
import { createRoom, FakeClock, joinRoom, nextEvent, startMatch, startServer, testConfig, type TestServer } from './helpers.ts';

const servers: TestServer[] = [];
const clients: RelayClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function serve(env: Record<string, string> = {}, deps: { now?: () => number; fetch?: typeof fetch } = {}) {
  const server = await startServer(testConfig({ DATABASE_FILE: ':memory:', LOG_LEVEL: 'silent', ...env }), deps);
  servers.push(server);
  return server;
}

/** The start of a JPEG up to its frame header and first scan: enough for the server's size check. */
function jpeg(width = 1280, height = 720, filler = 2000): Uint8Array<ArrayBuffer> {
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...frame, 0xff, 0xda, 0x00, 0x02, ...new Array<number>(filler).fill(0x55), 0xff, 0xd9]);
}

const PALETTE: ArenaPalette = {
  sky: 'rgb(120, 130, 140)',
  skyLow: 'rgb(100, 104, 110)',
  floorTop: 'rgb(90, 80, 70)',
  floorBottom: 'rgb(50, 44, 38)',
  ledge: 'rgb(80, 70, 66)',
  ledgeTop: '#6a5f58',
};

function arena(overrides: Partial<ArenaFile> = {}): ArenaFile {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    version: ARENA_FORMAT_VERSION,
    name: 'Grandma Kitchen',
    layers: [photoArenaLayer(id)],
    floor: 1.2,
    width: 10,
    spawns: [3.6, 6.4],
    ledges: [{ x: 1, y: 0.75, width: 1.2 }],
    edges: { left: 'wall', right: 'drop' },
    ...overrides,
  };
}

/** Shares an arena the way the game does: a FormData with file, image and palette. */
function share(server: TestServer, file: unknown, options: { image?: Uint8Array<ArrayBuffer>; palette?: unknown; player?: string | null } = {}) {
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'arena.json');
  form.append('image', new Blob([options.image ?? jpeg()], { type: 'image/jpeg' }), 'arena.jpg');
  form.append('palette', JSON.stringify(options.palette ?? PALETTE));
  const player = options.player === undefined ? 'player-aaaa1111' : options.player;
  return fetch(`${server.baseUrl}/arenas`, { method: 'POST', body: form, headers: player ? { 'x-player-id': player } : {} });
}

/** A stand-in for Meta that blocks names containing "rude" and flags backdrops that hold a 0x66 byte. */
function moderator() {
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { response_format: { json_schema: { name: string } }; messages: { content: unknown }[] };
    const user = body.messages[1]!.content;
    const verdict =
      body.response_format.json_schema.name === 'name_check'
        ? { allowed: !String(user).includes('rude'), reason: 'test' }
        : { safe: !JSON.stringify(user).includes(Buffer.from([0x66, 0x66, 0x66]).toString('base64')), reason: 'a face is visible' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return fetch;
}

describe('shared photo arenas', () => {
  it('shares an arena under its own id, and friends open it from the link', async () => {
    const server = await serve();
    const file = arena();
    const image = jpeg();
    const shared = await share(server, file, { image });
    expect(shared.status).toBe(201);
    expect(await shared.json()).toEqual({ id: file.id, link: `${server.baseUrl}/a/${file.id}` });

    const opened = await fetch(`${server.baseUrl}/arenas/${file.id}`);
    expect(await opened.json()).toEqual({ file, imageUrl: `${server.baseUrl}/arenas/${file.id}/image`, palette: PALETTE });
    const backdrop = await fetch(`${server.baseUrl}/arenas/${file.id}/image`);
    expect(backdrop.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await backdrop.arrayBuffer())).toEqual(image);
    const again = await fetch(`${server.baseUrl}/arenas/${file.id}/image`, { headers: { 'if-none-match': backdrop.headers.get('etag')! } });
    expect(again.status).toBe(304);

    // The link opens the web app, which then asks for the arena.
    const page = await fetch(`${server.baseUrl}/a/${file.id}`);
    expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect(server.services.metrics.arenaShares.get({ outcome: 'shared' })).toBe(1);
  });

  it('answers a repeat share at once, and keeps an id to whoever shared it first', async () => {
    const server = await serve();
    const file = arena();
    expect((await share(server, file)).status).toBe(201);
    const retry = await share(server, file);
    expect([retry.status, ((await retry.json()) as { id: string }).id]).toEqual([200, file.id]);
    const other = await share(server, { ...file, name: 'Not Mine' }, { player: 'player-bbbb2222' });
    expect([other.status, ((await other.json()) as { error: string }).error]).toEqual([409, 'arena_taken']);
  });

  it('refuses uploads that are malformed, too big, the wrong kind of image, or that point at other art', async () => {
    const server = await serve();
    const refused = async (response: Promise<Response>) => {
      const reply = await response;
      return [reply.status, ((await reply.json()) as { error: string }).error];
    };
    expect(await refused(share(server, arena(), { player: null }))).toEqual([400, 'no_player_id']);
    expect(await refused(fetch(`${server.baseUrl}/arenas`, { method: 'POST', headers: { 'x-player-id': 'player-aaaa1111', 'content-type': 'application/json' }, body: '{}' }))).toEqual([
      400,
      'bad_arena',
    ]);
    const id = randomUUID();
    expect(await refused(share(server, arena({ id, layers: ['https://tracker.example/pixel.png'] })))).toEqual([400, 'bad_arena']);
    expect(await refused(share(server, arena({ id, layers: [photoArenaLayer(randomUUID())] })))).toEqual([400, 'bad_arena']);
    expect(await refused(share(server, { ...arena(), floor: 'low' }))).toEqual([400, 'bad_arena']);
    expect(await refused(share(server, arena(), { palette: { ...PALETTE, sky: 'url(https://tracker.example)' } }))).toEqual([400, 'bad_arena']);
    expect(await refused(share(server, arena(), { palette: { ...PALETTE, sky: 'rgb(300, 0, 0)' } }))).toEqual([400, 'bad_arena']);
    expect(await refused(share(server, arena(), { image: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }))).toEqual([400, 'bad_image']);
    expect(await refused(share(server, arena(), { image: jpeg(4000, 3000) }))).toEqual([400, 'bad_image']);
    expect(await refused(share(server, arena(), { image: jpeg(100, 60) }))).toEqual([400, 'bad_image']);
    // Too big: the server answers 413 straight away and may close the socket while the upload is still going.
    const oversized = await share(server, arena(), { image: jpeg(1280, 720, 1_600_000) }).then(
      (reply) => reply.status,
      () => 'closed',
    );
    expect([413, 'closed']).toContain(oversized);
    expect(server.services.metrics.arenaShares.sum()).toBe(0);
  });

  it('lets only the phone that shared an arena take it down', async () => {
    const server = await serve();
    const file = arena();
    await share(server, file);
    const remove = (player: string | null) =>
      fetch(`${server.baseUrl}/arenas/${file.id}`, { method: 'DELETE', headers: player ? { 'x-player-id': player } : {} });
    expect((await remove('player-bbbb2222')).status).toBe(404);
    expect((await remove(null)).status).toBe(404);
    expect((await remove('player-aaaa1111')).status).toBe(204);
    expect((await fetch(`${server.baseUrl}/arenas/${file.id}`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/arenas/${file.id}/image`)).status).toBe(404);
    expect((await remove('player-aaaa1111')).status).toBe(404);
  });

  it("has Muse Spark check the name and look over the backdrop before it's shared", async () => {
    const server = await serve({ MODEL_API_KEY: 'test-key' }, { fetch: moderator() });
    const rude = await share(server, arena({ name: 'A Rude Place' }));
    expect([rude.status, ((await rude.json()) as { error: string }).error]).toEqual([400, 'name_blocked']);

    const face = await share(server, arena(), { image: new Uint8Array([...jpeg(), 0x66, 0x66, 0x66, 0x66]) });
    expect(face.status).toBe(400);
    expect(await face.json()).toEqual({ error: 'image_blocked', message: "This backdrop can't be shared: a face is visible" });

    expect((await share(server, arena())).status).toBe(201);
    const { arenaShares } = server.services.metrics;
    expect([arenaShares.get({ outcome: 'name_blocked' }), arenaShares.get({ outcome: 'image_blocked' }), arenaShares.get({ outcome: 'shared' })]).toEqual([1, 1, 1]);
  });

  it('shares nothing unchecked in production', async () => {
    const server = await serve({ NODE_ENV: 'production' });
    const reply = await share(server, arena());
    expect([reply.status, ((await reply.json()) as { error: string }).error]).toEqual([503, 'check_unavailable']);
  });

  it('limits shares per network and per phone', async () => {
    const server = await serve();
    for (let i = 0; i < 10; i++) expect((await share(server, arena())).status).toBe(201);
    expect((await share(server, arena())).status).toBe(429);
  });

  it('is off without a database', async () => {
    const off = await startServer(testConfig());
    servers.push(off);
    expect((await share(off, arena())).status).toBe(503);
    expect((await fetch(`${off.baseUrl}/arenas/${randomUUID()}`)).status).toBe(503);
  });
});

describe('photo arenas in friend rooms', () => {
  async function room(server: TestServer) {
    const code = await createRoom(server, 'Ana');
    const ana = await joinRoom(server, code, 'Ana');
    const bo = await joinRoom(server, code, 'Bo');
    clients.push(ana, bo);
    ana.sendLoadout(toyLoadout());
    bo.sendLoadout(toyLoadout());
    return { ana, bo };
  }

  it('lets the host pick a shared photo arena, and refuses one that only their phone has', async () => {
    const server = await serve();
    const { ana, bo } = await room(server);
    const file = arena();

    const refused = nextEvent(ana, 'error');
    ana.setArena(file.id);
    expect(await refused).toMatchObject({ code: 'arena_not_shared' });

    await share(server, file);
    const boHears = nextEvent(bo, 'arena');
    ana.setArena(file.id);
    expect(await boHears).toBe(file.id);
    const [anaSession] = await startMatch(ana, bo);
    expect(anaSession.arenaId).toBe(file.id);
  });

  it('keeps built-in arenas as they were', async () => {
    const server = await serve();
    const { ana, bo } = await room(server);
    const boHears = nextEvent(bo, 'arena');
    ana.setArena('dojo');
    expect(await boHears).toBe('dojo');
  });

  it('goes back to the default arena when a picked photo arena is deleted before the match', async () => {
    const server = await serve();
    const { ana, bo } = await room(server);
    const file = arena();
    await share(server, file);
    const picked = nextEvent(bo, 'arena');
    ana.setArena(file.id);
    await picked;
    await fetch(`${server.baseUrl}/arenas/${file.id}`, { method: 'DELETE', headers: { 'x-player-id': 'player-aaaa1111' } });

    const errors = Promise.all([nextEvent(ana, 'error'), nextEvent(bo, 'error')]);
    const fallback = nextEvent(bo, 'room', (info) => info.arenaId === null);
    ana.ready();
    bo.ready();
    for (const error of await errors) expect(error).toMatchObject({ code: 'arena_not_shared', message: expect.stringMatching(/default arena/) });
    expect((await fallback).players.every((p) => !p.ready)).toBe(true);
    expect(server.services.relay.matchCount).toBe(0);
  });
});

describe('reports from friend rooms', () => {
  const report = (server: TestServer, body: unknown, player = 'player-aaaa1111') =>
    fetch(`${server.baseUrl}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-player-id': player }, body: JSON.stringify(body) });
  const REPORT = { nickname: 'Bo', reason: 'name', room: '0123456789abcdef', at: '2026-11-05T09:00:00.000Z' };

  it('stores a report by nickname, as the results screen sends it', async () => {
    const server = await serve();
    expect((await report(server, REPORT)).status).toBe(202);
    expect((await report(server, { ...REPORT, room: null, reason: 'moves' })).status).toBe(202);
    expect(server.services.metrics.roomReports.get()).toBe(2);
  });

  it('refuses malformed reports, and more than 20 a day from one phone', async () => {
    const clock = new FakeClock();
    const server = await serve({}, { now: clock.now });
    for (const bad of [{ ...REPORT, reason: 'abuse' }, { ...REPORT, nickname: '' }, { ...REPORT, at: 'yesterday' }, { ...REPORT, room: '../etc' }]) {
      expect((await report(server, bad)).status).toBe(400);
    }
    for (let i = 0; i < 20; i++) expect((await report(server, REPORT)).status).toBe(202);
    expect((await report(server, REPORT)).status).toBe(429);
    expect((await report(server, REPORT, 'player-bbbb2222')).status).toBe(202);
    clock.advance(24 * 60 * 60 * 1000 + 1);
    expect((await report(server, REPORT)).status).toBe(202);
  });

  it('asks the phone to send it again later when reports are off', async () => {
    const off = await startServer(testConfig());
    servers.push(off);
    expect((await report(off, REPORT)).status).toBe(503);
  });
});
