import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AccountClient, connectWebSocket, RelayClient, ToyMatch, toyLoadout } from '@sticxcape/netcode';
import { decodeFrames, encodeFrames, FRAME_VALUES, withHash, type MoveFile } from '@sticxcape/shared';
import { createRoom, FakeClock, nextEvent, playOut, startMatch, startServer, testConfig, until, type TestServer } from './helpers.ts';
import { cookieFetch, SoftwarePasskeys } from './passkeys.ts';

const servers: TestServer[] = [];
const relays: RelayClient[] = [];

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const server of servers.splice(0)) await server.close();
});

async function serve(env: Record<string, string> = {}, deps: { now?: () => number; fetch?: typeof fetch } = {}) {
  const server = await startServer(testConfig({ DATABASE_FILE: ':memory:', LOG_LEVEL: 'silent', ...env }), deps);
  servers.push(server);
  return { server, origin: server.baseUrl.replace('127.0.0.1', 'localhost') };
}

/** A player who made an account with a passkey; `cookie` is their browser's sign-in cookie. */
async function signedIn(origin: string, name: string) {
  const fetch = cookieFetch();
  const client = new AccountClient({ baseUrl: origin, fetch, passkeys: new SoftwarePasskeys(origin) });
  const account = await client.createAccount(name);
  return { client, account, cookie: `sx_session=${fetch.cookies.get('sx_session')}` };
}

/** The relay as a signed-in page opens it: the socket's opening request carries the sign-in cookie. */
async function relayFor(server: TestServer, cookie: string | null = null): Promise<RelayClient> {
  class CookieSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, cookie ? { headers: { cookie } } : {});
    }
  }
  const relay = new RelayClient(await connectWebSocket(server.wsUrl, { WebSocket: CookieSocket as unknown as typeof globalThis.WebSocket }), { pingIntervalMs: 60_000 });
  relays.push(relay);
  return relay;
}

/** Two signed-in players searching; resolves once both are paired and in their room. */
async function pairUp(server: TestServer, origin: string, names: [string, string] = ['Ana', 'Bo']) {
  const ana = await signedIn(origin, names[0]);
  const bo = await signedIn(origin, names[1]);
  const anaRelay = await relayFor(server, ana.cookie);
  const boRelay = await relayFor(server, bo.cookie);
  const matched = Promise.all([nextEvent(anaRelay, 'matched'), nextEvent(boRelay, 'matched')]);
  const queued = nextEvent(anaRelay, 'queued');
  anaRelay.quickMatch(names[0]);
  await queued;
  boRelay.quickMatch(names[1]);
  const [anaSaw, boSaw] = await matched;
  await until(() => anaRelay.room?.players.length === 2 && boRelay.room?.players.length === 2);
  return { ana, bo, anaRelay, boRelay, anaSaw, boSaw };
}

/** A Meta reply for the nickname check: anything containing "rude" is blocked. */
function nicknameModerator() {
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { messages: { content: string }[] };
    const nickname = body.messages[1]!.content;
    asked.push(nickname);
    const content = JSON.stringify({ allowed: !nickname.includes('rude'), reason: 'test' });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  return { fetch, asked };
}

describe('quick match', () => {
  it('pairs two signed-in strangers, takes only signed loadouts, and rates the result', async () => {
    const clock = new FakeClock();
    const { server, origin } = await serve({}, { now: clock.now });
    const { ana, bo, anaRelay, boRelay, anaSaw, boSaw } = await pairUp(server, origin);

    // Without a Meta key nicknames can't be checked, so strangers see a neutral name.
    expect(anaSaw).toEqual({ id: bo.account.id, nickname: 'Challenger' });
    expect(boSaw).toEqual({ id: ana.account.id, nickname: 'Challenger' });
    expect(anaRelay.opponent).toEqual(anaSaw);
    expect(anaRelay.searching).toBe(false);
    expect(server.services.relay.queueSize).toBe(0);

    const refused = nextEvent(anaRelay, 'error');
    anaRelay.sendLoadout(toyLoadout());
    expect(await refused).toMatchObject({ code: 'unsigned_move' });

    const anaMoves = await ana.client.signMoves(toyLoadout());
    expect(anaMoves[0]!.signature).toMatch(/^v1\.[\w-]{43}$/);
    const boGets = nextEvent(boRelay, 'loadout');
    anaRelay.sendLoadout(anaMoves);
    expect((await boGets).moves).toEqual(anaMoves);
    boRelay.sendLoadout(await bo.client.signMoves(toyLoadout()));

    const sessions = await startMatch(anaRelay, boRelay);
    const ends = Promise.all([nextEvent(anaRelay, 'end'), nextEvent(boRelay, 'end')]);
    await playOut(sessions.map((session) => new ToyMatch(session)), clock);
    const [end] = await ends;
    expect(end.reason).toBe('finished');

    const store = server.services.accounts!;
    const [anaRating, boRating] = [store.rating(ana.account.id)!, store.rating(bo.account.id)!];
    expect([anaRating.games, boRating.games]).toEqual([1, 1]);
    expect(anaRating.rating + boRating.rating).toBeCloseTo(2000);
    // Ana joined the room first, so she is player 1.
    if (end.winner === 1) expect(anaRating.rating).toBeGreaterThan(1000);
    if (end.winner === 2) expect(boRating.rating).toBeGreaterThan(1000);
    const { quickMatches } = server.services.metrics;
    expect([quickMatches.get({ outcome: 'paired' }), quickMatches.get({ outcome: 'rated' })]).toEqual([1, 1]);
  });

  it('keeps photo arenas out of quick match, since they are photos of real places', async () => {
    const { server, origin } = await serve();
    const { anaRelay, boRelay } = await pairUp(server, origin);
    const refused = nextEvent(anaRelay, 'error');
    anaRelay.setArena('7a1c0de0-0000-4000-8000-0000000000aa');
    expect(await refused).toMatchObject({ code: 'arena_friends_only' });
    const boHears = nextEvent(boRelay, 'arena');
    anaRelay.setArena('rooftop');
    expect(await boHears).toBe('rooftop');
  });

  it('counts leaving a quick match as a loss', async () => {
    const { server, origin } = await serve();
    const { ana, bo, anaRelay, boRelay } = await pairUp(server, origin);
    anaRelay.sendLoadout(await ana.client.signMoves(toyLoadout()));
    boRelay.sendLoadout(await bo.client.signMoves(toyLoadout()));
    await startMatch(anaRelay, boRelay);
    const ended = nextEvent(anaRelay, 'end');
    boRelay.close();
    expect(await ended).toMatchObject({ reason: 'disconnect', winner: 1 });
    const store = server.services.accounts!;
    expect(store.rating(ana.account.id)!.rating).toBeGreaterThan(1000);
    expect(store.rating(bo.account.id)!.rating).toBeLessThan(1000);
  });

  it('shows checked nicknames, and refuses ones Meta AI blocks', async () => {
    const meta = nicknameModerator();
    const { server, origin } = await serve({ MODEL_API_KEY: 'test-key' }, { fetch: meta.fetch });

    const rude = await signedIn(origin, 'Cy');
    const rudeRelay = await relayFor(server, rude.cookie);
    const blocked = nextEvent(rudeRelay, 'error');
    rudeRelay.quickMatch('a rude name');
    expect(await blocked).toMatchObject({ code: 'nickname_blocked' });
    expect(rudeRelay.searching).toBe(false);

    const { anaSaw, boSaw } = await pairUp(server, origin, ['Ana', 'Bo']);
    expect([anaSaw.nickname, boSaw.nickname]).toEqual(['Bo', 'Ana']);
    // Checked once each, in lower case so a name is cached however it is written.
    expect(meta.asked).toEqual(['Name: "a rude name"', 'Name: "ana"', 'Name: "bo"']);
  });

  it('never pairs players who blocked each other', async () => {
    const { server, origin } = await serve();
    const ana = await signedIn(origin, 'Ana');
    const bo = await signedIn(origin, 'Bo');
    const cy = await signedIn(origin, 'Cy');
    await bo.client.blockPlayer(ana.account.id);
    const [anaRelay, boRelay, cyRelay] = await Promise.all([relayFor(server, ana.cookie), relayFor(server, bo.cookie), relayFor(server, cy.cookie)]);

    // Ana queues first: requests on two sockets can reach the relay in either order.
    const anaQueued = nextEvent(anaRelay, 'queued');
    anaRelay.quickMatch('Ana');
    await anaQueued;
    const boQueued = nextEvent(boRelay, 'queued');
    boRelay.quickMatch('Bo');
    await boQueued;
    // The matchmaker runs every second; give it two goes.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(server.services.relay.queueSize).toBe(2);

    // Ana has waited longest, so she gets the next player who may play her.
    const anaMatched = nextEvent(anaRelay, 'matched');
    cyRelay.quickMatch('Cy');
    expect(await anaMatched).toMatchObject({ id: cy.account.id });
    expect(server.services.relay.queueSize).toBe(1);
    boRelay.cancelQuickMatch();
    await until(() => server.services.relay.queueSize === 0);
  });

  it('lets players leave the room and search again; the empty room goes', async () => {
    const { server, origin } = await serve();
    const { anaRelay, boRelay } = await pairUp(server, origin);
    expect(server.services.rooms.size).toBe(1);

    const alone = nextEvent(boRelay, 'room', (room) => room.players.length === 1);
    anaRelay.leave();
    expect(anaRelay.room).toBeNull();
    await alone;
    boRelay.leave();
    await until(() => server.services.rooms.size === 0);

    const queued = nextEvent(anaRelay, 'queued');
    anaRelay.quickMatch('Ana');
    await queued;
    expect(server.services.relay.queueSize).toBe(1);
  });

  it('needs a sign-in, a nickname, no room, and accounts on the server', async () => {
    const { server, origin } = await serve();
    const guest = await relayFor(server);
    let error = nextEvent(guest, 'error');
    guest.quickMatch('Guest');
    expect(await error).toMatchObject({ code: 'not_signed_in' });

    const ana = await signedIn(origin, 'Ana');
    const anaRelay = await relayFor(server, ana.cookie);
    error = nextEvent(anaRelay, 'error');
    anaRelay.quickMatch('   ');
    expect(await error).toMatchObject({ code: 'bad_nickname' });

    // Signing out on the page ends quick match on a socket that was already open.
    await ana.client.signOut();
    error = nextEvent(anaRelay, 'error');
    anaRelay.quickMatch('Ana');
    expect(await error).toMatchObject({ code: 'not_signed_in' });

    const bo = await signedIn(origin, 'Bo');
    const boRelay = await relayFor(server, bo.cookie);
    await boRelay.join(await createRoom(server, 'Bo'), 'Bo');
    error = nextEvent(boRelay, 'error');
    boRelay.quickMatch('Bo');
    expect(await error).toMatchObject({ code: 'already_joined' });

    const off = await startServer(testConfig());
    servers.push(off);
    const offRelay = await relayFor(off);
    error = nextEvent(offRelay, 'error');
    offRelay.quickMatch('Ana');
    expect(await error).toMatchObject({ code: 'quick_match_unavailable' });
  });
});

describe('signing, blocks and reports', () => {
  it('signs only moves that keep the rules and match their hash', async () => {
    const { origin } = await serve();
    const { client } = await signedIn(origin, 'Ana');
    const move = toyLoadout()[0]!;

    // A body that jumps 2 m in one frame.
    const values = decodeFrames(move.frames)!;
    values[5 * FRAME_VALUES] = values[5 * FRAME_VALUES]! + 2000;
    const teleport = await withHash({ ...move, frames: encodeFrames(values) });
    await expect(client.signMoves([teleport])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Toy Jab.*faster than 45 m\/s/) });
    await expect(client.signMoves([{ ...move, name: 'Edited' }])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/hash/) });
    await expect(client.signMoves(Array.from({ length: 17 }, () => move))).rejects.toMatchObject({ status: 400 });
    await expect(client.signMoves([])).rejects.toMatchObject({ status: 400 });

    const [signed] = await client.signMoves([move]);
    expect({ ...signed, signature: undefined }).toEqual({ ...move, signature: undefined });
    await expect(new AccountClient({ baseUrl: origin, fetch: cookieFetch() }).signMoves([move])).rejects.toMatchObject({ status: 401 });
  });

  it('keeps a list of blocked players', async () => {
    const { origin } = await serve();
    const ana = await signedIn(origin, 'Ana');
    const bo = await signedIn(origin, 'Bo');
    await ana.client.blockPlayer(bo.account.id);
    await ana.client.blockPlayer(bo.account.id);
    expect(await ana.client.blockedPlayers()).toEqual([{ id: bo.account.id, name: 'Bo', blockedAt: expect.any(Number) }]);
    await expect(ana.client.blockPlayer(ana.account.id)).rejects.toMatchObject({ status: 404 });
    await expect(ana.client.blockPlayer('AAAAAAAAAAAAAAAA')).rejects.toMatchObject({ status: 404 });
    await expect(ana.client.blockPlayer('not an id')).rejects.toMatchObject({ status: 400 });
    await ana.client.unblockPlayer(bo.account.id);
    expect(await ana.client.blockedPlayers()).toEqual([]);
    await expect(ana.client.unblockPlayer(bo.account.id)).rejects.toMatchObject({ status: 404 });
  });

  it('stores reports, up to 20 a day from one player', async () => {
    const clock = new FakeClock();
    const { origin } = await serve({}, { now: clock.now });
    const ana = await signedIn(origin, 'Ana');
    const bo = await signedIn(origin, 'Bo');
    await ana.client.reportPlayer(bo.account.id, 'name', 'Their name is a slur');
    await expect(ana.client.reportPlayer(bo.account.id, 'spam' as 'other')).rejects.toMatchObject({ status: 400, error: 'bad_reason' });
    await expect(ana.client.reportPlayer(bo.account.id, 'other', 'x'.repeat(301))).rejects.toMatchObject({ status: 400, error: 'bad_note' });
    await expect(ana.client.reportPlayer(ana.account.id, 'other')).rejects.toMatchObject({ status: 404 });
    for (let i = 1; i < 20; i++) await ana.client.reportPlayer(bo.account.id, 'moves');
    await expect(ana.client.reportPlayer(bo.account.id, 'cheating')).rejects.toMatchObject({ status: 429 });
    clock.advance(24 * 60 * 60 * 1000 + 1);
    await ana.client.reportPlayer(bo.account.id, 'cheating');
  });
});

describe('friend rooms', () => {
  it('still take unsigned loadouts', async () => {
    const { server } = await serve();
    const code = await createRoom(server, 'Ana');
    const ana = await relayFor(server);
    const bo = await relayFor(server);
    await ana.join(code, 'Ana');
    await bo.join(code, 'Bo');
    const boGets = nextEvent(bo, 'loadout');
    ana.sendLoadout(toyLoadout() as MoveFile[]);
    expect((await boGets).moves).toEqual(toyLoadout());
  });
});
