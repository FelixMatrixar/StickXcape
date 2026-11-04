import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RelayError, ServicesClient, ToyMatch, toyLoadout, type LockstepSession, type RelayClient } from '@sticxcape/netcode';
import { MAX_ROOM_PLAYERS, type ServerMessage } from '@sticxcape/shared';
import {
  connect,
  createRoom,
  FakeClock,
  joinRoom,
  nextEvent,
  playOut,
  rawSocket,
  startMatch,
  startServer,
  testConfig,
  until,
  type TestServer,
} from './helpers.ts';

let server: TestServer | undefined;
const clients: RelayClient[] = [];

async function serve(...args: Parameters<typeof startServer>): Promise<TestServer> {
  server = await startServer(...args);
  return server;
}

async function join(s: TestServer, code: string, nickname: string): Promise<RelayClient> {
  const client = await joinRoom(s, code, nickname);
  clients.push(client);
  return client;
}

/** Two players in a fresh room, each with the toy loadout sent. */
async function pairUp(s: TestServer): Promise<{ code: string; ana: RelayClient; bo: RelayClient }> {
  const code = await createRoom(s, 'Ana');
  const ana = await join(s, code, 'Ana');
  const bo = await join(s, code, 'Bo');
  ana.sendLoadout(toyLoadout());
  bo.sendLoadout(toyLoadout());
  return { code, ana, bo };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
  server = undefined;
});

describe('joining a room', () => {
  it('lets two phones join from a link and see each other (week 1 check)', async () => {
    const s = await serve();
    const { code, link } = await new ServicesClient({ baseUrl: s.baseUrl }).createRoom('Ana');
    expect(link).toBe(`${s.baseUrl}/r/${code}`);

    const ana = await connect(s);
    clients.push(ana);
    const joined = await ana.join(code.toUpperCase(), 'Ana');
    expect(joined).toMatchObject({ player: 1, host: true });

    const anaSeesBo = nextEvent(ana, 'room', (room) => room.players.length === 2);
    const bo = await join(s, code, '  Bo  ');
    expect(bo).toMatchObject({ player: 2, host: false });
    expect((await anaSeesBo).players).toEqual([
      { player: 1, nickname: 'Ana', host: true, ready: false, hasLoadout: false },
      { player: 2, nickname: 'Bo', host: false, ready: false, hasLoadout: false },
    ]);

    const summary = await fetch(`${s.baseUrl}/rooms/${code}`).then((res) => res.json());
    expect(summary).toEqual({
      exists: true,
      players: [
        { player: 1, nickname: 'Ana', host: true },
        { player: 2, nickname: 'Bo', host: false },
      ],
      arena: null,
      inMatch: false,
    });
    await until(() => ana.rtt !== null);
  });

  it('refuses unknown rooms, old clients and bad nicknames', async () => {
    const s = await serve();
    const code = await createRoom(s);
    const joinError = async (room: string, nickname: string, version?: number) => {
      const client = await connect(s);
      clients.push(client);
      return client.join(room, nickname, version).then(
        () => null,
        (err: unknown) => (err instanceof RelayError ? err.code : err),
      );
    };
    expect(await joinError('0000000000000000', 'Ana')).toBe('room_not_found');
    expect(await joinError('not a code', 'Ana')).toBe('room_not_found');
    expect(await joinError(code, 'Ana', 0)).toBe('version_mismatch');
    expect(await joinError(code, '   ')).toBe('bad_nickname');
    expect(await joinError(code, 'x'.repeat(17))).toBe('bad_nickname');

    // A bad nickname leaves the socket open, so the phone can try again.
    const client = await connect(s);
    clients.push(client);
    await expect(client.join(code, '‮')).rejects.toMatchObject({ code: 'bad_nickname' });
    await expect(client.join(code, 'Ana')).resolves.toMatchObject({ player: 1 });
    const again = nextEvent(client, 'error');
    client.transport.send({ type: 'join', room: code, nickname: 'Ana', clientVersion: 1 });
    expect(await again).toMatchObject({ code: 'already_joined' });
  });

  it('holds at most 8 players and hands the host on', async () => {
    const s = await serve();
    const code = await createRoom(s);
    const players: RelayClient[] = [];
    for (let i = 1; i <= MAX_ROOM_PLAYERS; i++) players.push(await join(s, code, `P${i}`));
    const ninth = await connect(s);
    clients.push(ninth);
    await expect(ninth.join(code, 'P9')).rejects.toMatchObject({ code: 'room_full' });

    const hostMoves = nextEvent(players[1]!, 'room', (room) => room.players.length === MAX_ROOM_PLAYERS - 1);
    players[0]!.close();
    const room = await hostMoves;
    expect(room.players.find((p) => p.host)?.player).toBe(2);
    expect(players[1]!.host).toBe(true);

    // The freed number goes to the next phone in.
    expect(await join(s, code, 'P9')).toMatchObject({ player: 1, host: false });
  });
});

describe('the lobby', () => {
  it('passes loadouts to the opponent and checks who may ready', async () => {
    const s = await serve();
    const code = await createRoom(s);
    const ana = await join(s, code, 'Ana');
    const bo = await join(s, code, 'Bo');
    const cy = await join(s, code, 'Cy');

    const notJoined = await connect(s);
    clients.push(notJoined);
    const notJoinedError = nextEvent(notJoined, 'error');
    notJoined.ready();
    expect(await notJoinedError).toMatchObject({ code: 'not_joined' });

    const noLoadout = nextEvent(ana, 'error');
    ana.ready();
    expect(await noLoadout).toMatchObject({ code: 'no_loadout' });

    const boGetsLoadout = nextEvent(bo, 'loadout');
    ana.sendLoadout(toyLoadout());
    expect(await boGetsLoadout).toEqual({ player: 1, moves: toyLoadout() });
    expect(cy.loadouts.size).toBe(0);

    const notFighter = nextEvent(cy, 'error');
    cy.sendLoadout(toyLoadout());
    cy.ready();
    expect(await notFighter).toMatchObject({ code: 'not_fighter' });

    const anaReady = nextEvent(bo, 'room', (room) => room.players[0]!.ready);
    ana.ready();
    expect((await anaReady).players.map((p) => [p.player, p.ready, p.hasLoadout])).toEqual([
      [1, true, true],
      [2, false, false],
      [3, false, true],
    ]);
  });

  it('lets only the host pick the arena, and an arena change resets ready', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);

    const notHost = nextEvent(bo, 'error');
    bo.setArena('dojo');
    expect(await notHost).toMatchObject({ code: 'not_host' });

    const ready = nextEvent(bo, 'room', (room) => room.players[1]!.ready);
    bo.ready();
    await ready;
    const arena = nextEvent(bo, 'arena');
    const reset = nextEvent(bo, 'room', (room) => room.arenaId === 'rooftop');
    ana.setArena('rooftop');
    expect(await arena).toBe('rooftop');
    expect((await reset).players.every((p) => !p.ready)).toBe(true);
  });
});

describe('matches', () => {
  it('plays toy matches to the end with matching hashes, and rematches', async () => {
    const clock = new FakeClock();
    const s = await serve(testConfig(), { now: clock.now });
    const { code, ana, bo } = await pairUp(s);

    for (let round = 1; round <= 3; round++) {
      const sessions = await startMatch(ana, bo);
      if (round === 1) {
        expect(sessions[0]).toMatchObject({ inputDelay: 3, startFrame: 0, fighters: [1, 2], arenaId: null });
        expect(sessions[0].seed).toBe(sessions[1].seed);
        expect(s.services.relay.matchCount).toBe(1);
        expect(await fetch(`${s.baseUrl}/rooms/${code}`).then((res) => res.json())).toMatchObject({ inMatch: true });
      }
      const ends = Promise.all([nextEvent(ana, 'end'), nextEvent(bo, 'end')]);
      const matches = sessions.map((session) => new ToyMatch(session));
      await playOut(matches, clock);
      const [anaEnd, boEnd] = await ends;

      expect(anaEnd).toEqual(boEnd);
      expect(anaEnd).toEqual({ type: 'end', winner: matches[0]!.result, reason: 'finished' });
      expect(matches[0]!.sim.frame).toBeGreaterThan(60);
      expect(matches[0]!.sim.hash()).toBe(matches[1]!.sim.hash());
      expect(sessions.map((session) => session.desyncFrame)).toEqual([null, null]);
    }

    const { metrics } = s.services;
    expect(metrics.matchesStarted.get()).toBe(3);
    expect(metrics.matchesEnded.get({ reason: 'finished' })).toBe(3);
    expect(metrics.matchesEnded.sum()).toBe(3);
    // Inputs still in flight when a match ends are dropped as not_in_match; nothing else should be.
    expect(metrics.relayDropped.sum() - metrics.relayDropped.get({ reason: 'not_in_match' })).toBe(0);
    expect(s.services.relay.matchCount).toBe(0);
  });

  it('keeps the winner on and swaps loadouts for the next pair', async () => {
    const s = await serve();
    const code = await createRoom(s);
    const ana = await join(s, code, 'Ana');
    const bo = await join(s, code, 'Bo');
    const cy = await join(s, code, 'Cy');
    for (const client of [ana, bo, cy]) client.sendLoadout(toyLoadout());

    const [anaSession, boSession] = await startMatch(ana, bo);
    const cyGetsAna = nextEvent(cy, 'loadout', (l) => l.player === 1);
    const anaGetsCy = nextEvent(ana, 'loadout', (l) => l.player === 3);
    const nextUp = nextEvent(cy, 'room', (room) => room.fighters === null && room.queue[1] === 3);
    const ended = nextEvent(bo, 'end');
    anaSession.finish(1);
    boSession.finish(1);

    expect(await ended).toEqual({ type: 'end', winner: 1, reason: 'finished' });
    expect((await nextUp).queue).toEqual([1, 3, 2]);
    await cyGetsAna;
    await anaGetsCy;

    const notFighter = nextEvent(bo, 'error');
    bo.ready();
    expect(await notFighter).toMatchObject({ code: 'not_fighter' });
    const [, cySession] = await startMatch(ana, cy);
    expect(cySession.fighters).toEqual([1, 3]);
  });

  it('locks loadouts, the arena and ready during a match', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    await startMatch(ana, bo);
    for (const act of [() => ana.sendLoadout(toyLoadout()), () => ana.setArena('dojo'), () => ana.ready()]) {
      const error = nextEvent(ana, 'error');
      act();
      expect(await error).toMatchObject({ code: 'match_in_progress' });
    }
  });

  it('ends the match as a desync when state hashes differ', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    const [anaSession, boSession] = await startMatch(ana, bo);
    const ends = Promise.all([nextEvent(ana, 'end'), nextEvent(bo, 'end')]);
    const seen = new Promise((resolve) => anaSession.onDesync(resolve));
    anaSession.submitHash(0, 111);
    boSession.submitHash(0, 222);
    expect(await ends).toEqual([
      { type: 'end', winner: null, reason: 'desync' },
      { type: 'end', winner: null, reason: 'desync' },
    ]);
    expect(await seen).toBe(0);
    expect(s.services.metrics.matchesEnded.get({ reason: 'desync' })).toBe(1);
  });

  it('ends the match as a desync when the phones disagree on the winner', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    const [anaSession, boSession] = await startMatch(ana, bo);
    const ended = nextEvent(ana, 'end');
    anaSession.finish(1);
    boSession.finish(2);
    expect(await ended).toEqual({ type: 'end', winner: null, reason: 'desync' });
  });

  it('takes one phone at its word when the other never reports', async () => {
    const config = testConfig();
    config.relay.endConfirmMs = 50;
    const s = await serve(config);
    const { ana, bo } = await pairUp(s);
    const [, boSession] = await startMatch(ana, bo);
    const ended = nextEvent(ana, 'end');
    boSession.finish(2);
    expect(await ended).toEqual({ type: 'end', winner: 2, reason: 'finished' });
  });

  it('gives the match to the phone that stays when the other leaves', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    await startMatch(ana, bo);
    const ended = nextEvent(ana, 'end');
    const alone = nextEvent(ana, 'room', (room) => room.players.length === 1);
    bo.close();
    expect(await ended).toEqual({ type: 'end', winner: 1, reason: 'disconnect' });
    expect((await alone).fighters).toBeNull();
  });

  it('ends a match where nobody sends inputs', async () => {
    const config = testConfig();
    config.relay.pingIntervalMs = 20;
    config.relay.matchIdleTimeoutMs = 100;
    const s = await serve(config);
    const { ana, bo } = await pairUp(s);
    await startMatch(ana, bo);
    const ended = nextEvent(ana, 'end');
    expect(await ended).toEqual({ type: 'end', winner: null, reason: 'disconnect' });
  });
});

describe('input delay', () => {
  it('pings fighters a few more times before a first match, and starts a rematch at once', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    const samples = s.services.metrics.samples.rttMs;
    // Each phone has answered only the ping it got on connecting.
    const before = samples.count;
    const [anaSession, boSession] = await startMatch(ana, bo);
    expect(samples.count - before).toBeGreaterThanOrEqual(8);

    const ended = nextEvent(ana, 'end');
    anaSession.finish(1);
    boSession.finish(1);
    await ended;
    const beforeRematch = samples.count;
    await startMatch(ana, bo);
    expect(samples.count - beforeRematch).toBeLessThan(4);
  });

  it('keeps one slow reply from setting the input delay for the whole match', async () => {
    const s = await serve();
    const code = await createRoom(s, 'Ana');
    const ana = await join(s, code, 'Ana');
    ana.sendLoadout(toyLoadout());

    // Bo's phone answers its first ping 300 ms late, as a phone busy loading might, then promptly.
    const bo = await rawSocket(s);
    await until(() => bo.messages.some((m) => m.type === 'ping'));
    const first = bo.messages.find((m) => m.type === 'ping') as Extract<ServerMessage, { type: 'ping' }>;
    setTimeout(() => bo.send({ type: 'pong', time: first.time }), 300);
    bo.ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'ping') bo.send({ type: 'pong', time: message.time });
    });
    bo.send({ type: 'join', room: code, nickname: 'Bo', clientVersion: 1 });
    bo.send({ type: 'loadout', moves: toyLoadout() });
    await until(() => (s.services.metrics.samples.rttMs.percentile(100) ?? 0) >= 250);

    const started = nextEvent(ana, 'start');
    ana.ready();
    bo.send({ type: 'ready' });
    // With only the slow sample, the round trip would read 300 ms and the delay 6 frames.
    expect((await started).inputDelay).toBe(3);
    await until(() => bo.messages.some((m) => m.type === 'start'));
    expect(bo.messages.find((m) => m.type === 'start')).toMatchObject({ inputDelay: 3 });
  });

  it('calls off a start that is waiting on pings when a fighter leaves', async () => {
    const config = testConfig();
    config.relay.startPingSpacingMs = 100;
    const s = await serve(config);
    const code = await createRoom(s);
    const ana = await join(s, code, 'Ana');
    const bo = await join(s, code, 'Bo');
    const cy = await join(s, code, 'Cy');
    for (const client of [ana, bo, cy]) client.sendLoadout(toyLoadout());
    const anaStarts: LockstepSession[] = [];
    ana.on('start', (session) => anaStarts.push(session));

    const nextPair = nextEvent(ana, 'room', (room) => room.queue.join() === '1,3');
    ana.ready();
    bo.ready();
    bo.close();
    await nextPair;

    const [anaSession] = await startMatch(ana, cy);
    expect(anaSession.fighters).toEqual([1, 3]);
    expect(anaStarts).toHaveLength(1);
  });
});

describe('relay hygiene', () => {
  it('drops inputs out of order or outside a match', async () => {
    const s = await serve();
    const { ana, bo } = await pairUp(s);
    ana.transport.send({ type: 'input', frame: 3, buttons: 0 });
    await until(() => s.services.metrics.relayDropped.get({ reason: 'not_in_match' }) === 1);
    await startMatch(ana, bo);
    ana.transport.send({ type: 'input', frame: 7, buttons: 0 });
    await until(() => s.services.metrics.relayDropped.get({ reason: 'out_of_order' }) === 1);
  });

  it('closes the room when a phone sends inputs far ahead of the match clock', async () => {
    const clock = new FakeClock();
    const config = testConfig();
    config.relay.aheadToleranceFrames = 5;
    const s = await serve(config, { now: clock.now });
    const { code, ana, bo } = await pairUp(s);
    const [anaSession] = await startMatch(ana, bo);

    const roomClosed = nextEvent(bo, 'end');
    const errors = Promise.all([nextEvent(ana, 'error'), nextEvent(bo, 'error')]);
    const closed = Promise.all([nextEvent(ana, 'close'), nextEvent(bo, 'close')]);
    for (let frame = anaSession.inputDelay; frame < 20; frame++) ana.transport.send({ type: 'input', frame, buttons: 0 });

    expect(await roomClosed).toMatchObject({ reason: 'room_closed' });
    expect((await errors).map((e) => e.code)).toEqual(['input_ahead', 'input_ahead']);
    expect(await closed).toEqual(['input_ahead', 'input_ahead']);
    expect((await fetch(`${s.baseUrl}/rooms/${code}`)).status).toBe(404);
  });

  it('counts malformed messages and disconnects a phone that keeps sending them', async () => {
    const s = await serve();
    const socket = await rawSocket(s);
    for (let i = 0; i < 10; i++) socket.send(i % 2 ? 'not json' : { type: 'input', frame: 'soon' });
    socket.ws.send(Buffer.from([1, 2, 3]));
    await until(() => s.services.metrics.relayDropped.get({ reason: 'malformed' }) === 11);
    socket.send({ type: 'ping', time: 5 });
    await until(() => socket.messages.some((m) => m.type === 'pong'));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);

    for (let i = 0; i < 40; i++) socket.send('{');
    expect(await socket.closed).toEqual({ code: 1008, reason: 'malformed' });
  });

  it('cuts off a phone that floods the relay', async () => {
    const s = await serve();
    const socket = await rawSocket(s);
    for (let i = 0; i < 200; i++) socket.send({ type: 'ping', time: i });
    expect(await socket.closed).toEqual({ code: 1008, reason: 'rate_limited' });
    expect(socket.messages.some((m) => m.type === 'error' && m.code === 'rate_limited')).toBe(true);
    expect(s.services.metrics.relayDropped.get({ reason: 'rate_limit' })).toBeGreaterThan(75);
  });

  it('caps sockets per IP address', async () => {
    const config = testConfig();
    config.relay.maxConnectionsPerIp = 2;
    const s = await serve(config);
    const first = await rawSocket(s);
    await rawSocket(s);
    const third = await rawSocket(s);
    expect(await third.closed).toEqual({ code: 1008, reason: 'too many connections' });

    first.ws.close();
    await first.closed;
    await until(() => s.services.relay.connectionCount === 1);
    const fourth = await rawSocket(s);
    await until(() => fourth.messages.length > 0);
    expect(fourth.messages[0]).toMatchObject({ type: 'ping' });
  });

  it('disconnects a phone that goes silent', async () => {
    const config = testConfig();
    config.relay.pingIntervalMs = 20;
    config.relay.idleTimeoutMs = 100;
    const s = await serve(config);
    const socket = await rawSocket(s);
    const { code } = await socket.closed;
    expect(code).toBe(1006);
    expect(socket.messages.filter((m) => m.type === 'error')).toEqual([{ type: 'error', code: 'idle_timeout', message: 'No messages for too long' }]);
  });

  it('turns away pages from other sites', async () => {
    const config = testConfig();
    config.allowedOrigins = ['https://play.example'];
    const s = await serve(config);
    const refused = new WebSocket(s.wsUrl, { origin: 'https://evil.example' });
    refused.on('error', () => {});
    const status = await new Promise<number>((resolve) =>
      refused.once('unexpected-response', (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      }),
    );
    expect(status).toBe(403);

    const allowed = await rawSocket(s, { origin: 'https://play.example' });
    allowed.ws.close();
    const native = await rawSocket(s);
    native.ws.close();
  });
});

describe('closing', () => {
  it('tells phones when their room is removed', async () => {
    const s = await serve();
    const { code, ana, bo } = await pairUp(s);
    const errors = Promise.all([nextEvent(ana, 'error'), nextEvent(bo, 'error')]);
    const closed = nextEvent(ana, 'close');
    s.services.rooms.delete(code);
    expect((await errors).map((e) => e.code)).toEqual(['room_not_found', 'room_not_found']);
    expect(await closed).toBe('room_not_found');
  });

  it('tells phones the server is restarting', async () => {
    const s = await serve();
    const { ana } = await pairUp(s);
    const error = nextEvent(ana, 'error');
    const closed = nextEvent(ana, 'close');
    await s.close();
    expect(await error).toMatchObject({ code: 'server_shutdown' });
    expect(await closed).toBe('server_shutdown');
  });
});
