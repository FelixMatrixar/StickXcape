import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  cleanText,
  isPhotoArenaId,
  isRoomCode,
  NICKNAME_MAX_LENGTH,
  parseClientMessage,
  type ClientMessage,
  type EndReason,
  type ErrorCode,
  type JoinMessage,
} from '@sticxcape/shared';
import type { MoveSigner } from '../accounts/signing.ts';
import type { AccountStore } from '../accounts/store.ts';
import type { AiGateway } from '../ai/gateway.ts';
import type { RelayConfig } from '../config.ts';
import { TokenBucket } from '../lib/limits.ts';
import type { Metrics } from '../metrics/metrics.ts';
import type { RoomStore } from '../rooms/room-store.ts';
import { Connection } from './connection.ts';
import { Hub, type HubContext, type Side } from './hub.ts';
import { Matchmaker, type Seeker } from './matchmaker.ts';

export interface RelayOptions {
  config: RelayConfig;
  minClientVersion: number;
  rooms: RoomStore;
  metrics: Metrics;
  log: FastifyBaseLogger;
  now: () => number;
  /** Quick match needs accounts and move signing; without them it is refused. */
  accounts: AccountStore | null;
  signer: MoveSigner | null;
  /** Checks nicknames before strangers see them. */
  ai: AiGateway;
}

/** A phone sending more malformed messages than this is disconnected. */
const MAX_MALFORMED = 50;
/** Time one input in this many through the relay, for the forward-delay metric. */
const FORWARD_SAMPLE_EVERY = 16;
/** How often the quick match queue looks for pairs; its windows widen with each second waited. */
const MATCHMAKING_INTERVAL_MS = 1000;
/** What strangers see when a nickname couldn't be checked. */
const NEUTRAL_NICKNAME = 'Challenger';

/**
 * The relay: accepts phones' WebSockets, keeps them honest (malformed messages, rate cap,
 * idle phones) and hands each message to its room's hub.
 */
export class Relay {
  private readonly options: RelayOptions;
  private readonly hubs = new Map<string, Hub>();
  private readonly connections = new Set<Connection>();
  private readonly perIp = new Map<string, number>();
  private readonly hubContext: HubContext;
  private readonly timer: NodeJS.Timeout;
  private readonly matchmaker = new Matchmaker();
  private readonly matchTimer: NodeJS.Timeout;
  private inputs = 0;

  constructor(options: RelayOptions) {
    this.options = options;
    this.hubContext = {
      config: options.config,
      metrics: options.metrics,
      log: options.log,
      now: options.now,
      closeRoom: (hub) => this.closeRoom(hub),
      verifyMove: (move) => options.signer?.verify(move) ?? false,
      quickMatchEnded: (accounts, winnerSide, reason) => this.rateQuickMatch(accounts, winnerSide, reason),
      arenaProblem: (arenaId, quick) => this.arenaProblem(arenaId, quick),
    };
    this.timer = setInterval(() => this.tick(), options.config.pingIntervalMs);
    this.timer.unref();
    this.matchTimer = setInterval(() => this.matchmake(), MATCHMAKING_INTERVAL_MS);
    this.matchTimer.unref();
    options.rooms.onRemove((room) => {
      const hub = this.hubs.get(room.code);
      if (hub) {
        hub.close('room_not_found', 'This room has closed');
        this.hubs.delete(room.code);
      }
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get matchCount(): number {
    let count = 0;
    for (const hub of this.hubs.values()) if (hub.inMatch) count += 1;
    return count;
  }

  /** Players waiting for a quick match. */
  get queueSize(): number {
    return this.matchmaker.size;
  }

  /** `signedIn` is the account behind the page's sign-in cookie, read when the socket opened. */
  accept(ws: WebSocket, ip: string, signedIn: { account: { id: string; name: string }; token: string } | null = null): void {
    const { config, now } = this.options;
    const open = this.perIp.get(ip) ?? 0;
    if (open >= config.maxConnectionsPerIp) {
      ws.close(1008, 'too many connections');
      return;
    }
    this.perIp.set(ip, open + 1);
    const time = now();
    const conn = new Connection(ws, ip, new TokenBucket(config.messagesPerSecond, config.messageBurst, time), time);
    if (signedIn) {
      conn.account = { id: signedIn.account.id, name: signedIn.account.name };
      conn.sessionToken = signedIn.token;
    }
    this.connections.add(conn);
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.once('close', () => this.onClose(conn));
    // Ping straight away so the first round trip is known before anyone gets ready.
    conn.send({ type: 'ping', time });
  }

  /** Tells every phone the server is going away and closes their sockets. */
  shutdown(): void {
    clearInterval(this.timer);
    clearInterval(this.matchTimer);
    for (const conn of this.connections) {
      conn.sendError('server_shutdown', 'The server is restarting; reload to reconnect');
      conn.close(1001, 'server_shutdown');
    }
  }

  private onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    const startedAt = performance.now();
    const now = this.options.now();
    conn.lastSeen = now;
    if (!conn.bucket.take(now)) {
      this.drop('rate_limit');
      conn.rateDrops += 1;
      if (conn.rateDrops > this.options.config.messagesPerSecond) {
        conn.sendError('rate_limited', 'Too many messages');
        conn.close(1008, 'rate_limited');
      }
      return;
    }
    const message = isBinary ? null : parseClientMessage(rawText(data));
    if (!message) {
      this.drop('malformed');
      conn.malformed += 1;
      if (conn.malformed > MAX_MALFORMED) conn.close(1008, 'malformed');
      return;
    }
    this.handle(conn, message, now);
    if (message.type === 'input' && ++this.inputs % FORWARD_SAMPLE_EVERY === 0) {
      const ms = performance.now() - startedAt;
      this.options.metrics.relayForward.observe(ms / 1000);
      this.options.metrics.samples.forwardMs.push(ms);
    }
  }

  private handle(conn: Connection, message: ClientMessage, now: number): void {
    if (message.type === 'ping') return conn.send({ type: 'pong', time: message.time });
    if (message.type === 'pong') return this.recordPong(conn, message.time, now);
    if (message.type === 'join') return this.join(conn, message);
    if (message.type === 'quickmatch') return void this.seekQuickMatch(conn, message.nickname);
    if (message.type === 'cancelmatch') return this.stopSeeking(conn);
    if (message.type === 'leave') return this.leaveRoom(conn);

    const hub = conn.hub;
    const player = conn.player;
    if (!hub || player === null) return conn.sendError('not_joined', 'Join a room first');
    switch (message.type) {
      case 'loadout':
        return hub.setLoadout(player, message.moves);
      case 'arena':
        return hub.setArena(player, message.arenaId);
      case 'ready':
        conn.rollback = message.rollback === true;
        return hub.setReady(player);
      case 'input':
        return hub.input(player, message.frame, message.buttons);
      case 'hash':
        return hub.hash(player, message.frame, message.stateHash);
      case 'sync':
        return hub.sync(player, message.lateness);
      case 'end':
        return hub.end(player, message.winner);
    }
  }

  private join(conn: Connection, message: JoinMessage): void {
    if (conn.hub) return conn.sendError('already_joined', 'Already in a room');
    this.stopSeeking(conn);
    if (message.clientVersion < this.options.minClientVersion) {
      conn.sendError('version_mismatch', 'This version of SticXcape is out of date; reload the page');
      return conn.close(1000, 'version_mismatch');
    }
    const nickname = cleanText(message.nickname, NICKNAME_MAX_LENGTH);
    if (nickname === null) return conn.sendError('bad_nickname', `Nickname must be 1 to ${NICKNAME_MAX_LENGTH} characters`);

    const code = message.room.toLowerCase();
    const room = isRoomCode(code) ? this.options.rooms.get(code) : undefined;
    if (!room) {
      conn.sendError('room_not_found', 'Room not found or expired');
      return conn.close(1000, 'room_not_found');
    }
    let hub = this.hubs.get(code);
    if (!hub) {
      hub = new Hub(room, this.hubContext);
      this.hubs.set(code, hub);
    }
    if (!hub.join(conn, nickname)) {
      conn.sendError('room_full', 'This room is full');
      conn.close(1000, 'room_full');
    }
  }

  private recordPong(conn: Connection, time: number, now: number): void {
    const rtt = now - time;
    if (rtt < 0 || rtt > 10_000) return;
    conn.addRtt(rtt);
    this.options.metrics.relayRtt.observe(rtt / 1000);
    this.options.metrics.samples.rttMs.push(rtt);
    conn.hub?.rttMeasured();
  }

  private onClose(conn: Connection): void {
    conn.closed = true;
    this.connections.delete(conn);
    const open = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (open > 0) this.perIp.set(conn.ip, open);
    else this.perIp.delete(conn.ip);
    this.leaveRoom(conn);
  }

  /** Leaves the room (and the quick match queue) but keeps the socket. */
  private leaveRoom(conn: Connection): void {
    this.stopSeeking(conn);
    const hub = conn.hub;
    const player = conn.player;
    if (!hub || player === null) return;
    conn.hub = null;
    conn.player = null;
    hub.leave(player);
    if (!hub.isEmpty) return;
    this.hubs.delete(hub.room.code);
    // Nobody can come back to a quick match room: there is no link to it.
    if (hub.room.quick) this.options.rooms.delete(hub.room.code);
  }

  // Quick match (MP-7).

  /**
   * Puts a signed-in player in the quick match queue, once Meta AI has checked their nickname.
   * A blocked nickname is refused; one that couldn't be checked shows as Challenger.
   */
  private async seekQuickMatch(conn: Connection, rawNickname: string): Promise<void> {
    const { accounts, signer, ai } = this.options;
    if (!accounts || !signer) return conn.sendError('quick_match_unavailable', 'Quick match needs accounts, which are off on this server');
    if (conn.hub) return conn.sendError('already_joined', 'Leave the room before looking for a quick match');
    if (conn.seeking) return;
    // The sign-in may have ended (signed out, or the account deleted) since the socket opened.
    const session = conn.sessionToken ? accounts.findSession(conn.sessionToken) : undefined;
    if (!session) return conn.sendError('not_signed_in', 'Sign in with your passkey to play strangers');
    const nickname = cleanText(rawNickname, NICKNAME_MAX_LENGTH);
    if (nickname === null) return conn.sendError('bad_nickname', `Nickname must be 1 to ${NICKNAME_MAX_LENGTH} characters`);

    conn.seeking = true;
    const verdict = await ai.checkName(nickname, { playerKey: session.account.id, ip: conn.ip });
    // Cancelled, joined a room or gone while the check ran.
    if (!conn.seeking || conn.closed || conn.hub) return;
    if (verdict === 'blocked') {
      conn.seeking = false;
      return conn.sendError('nickname_blocked', "That nickname can't be shown to strangers; pick another");
    }
    const rating = accounts.rating(session.account.id);
    if (!rating) {
      conn.seeking = false;
      return conn.sendError('not_signed_in', 'Sign in with your passkey to play strangers');
    }
    this.matchmaker.add({
      conn,
      accountId: session.account.id,
      nickname: verdict === 'allowed' ? nickname : NEUTRAL_NICKNAME,
      rating: rating.rating,
      since: this.options.now(),
      blocked: accounts.blockedEitherWay(session.account.id),
    });
    conn.send({ type: 'queued' });
    this.matchmake();
  }

  private stopSeeking(conn: Connection): void {
    conn.seeking = false;
    this.matchmaker.remove(conn);
  }

  private matchmake(): void {
    if (this.matchmaker.size < 2) return;
    for (const pair of this.matchmaker.takePairs(this.options.now())) this.startQuickMatch(pair);
  }

  /** Puts a pair in a new two-player room; from there it plays like any room, with signed loadouts and rated results. */
  private startQuickMatch([a, b]: [Seeker, Seeker]): void {
    a.conn.seeking = b.conn.seeking = false;
    const room = this.options.rooms.create(a.nickname);
    if (!room) {
      for (const { conn } of [a, b]) conn.sendError('quick_match_unavailable', 'The server is full; try again soon');
      return;
    }
    room.quick = true;
    room.maxPlayers = 2;
    const hub = new Hub(room, this.hubContext);
    this.hubs.set(room.code, hub);
    for (const [me, them] of [
      [a, b],
      [b, a],
    ] as const) {
      hub.join(me.conn, me.nickname);
      me.conn.send({ type: 'matched', opponent: { id: them.accountId, nickname: them.nickname } });
    }
    this.options.metrics.quickMatches.inc({ outcome: 'paired' });
    this.options.log.info(
      { room: room.code, ratings: [Math.round(a.rating), Math.round(b.rating)], pingMs: Math.round((a.conn.rtt() ?? 0) + (b.conn.rtt() ?? 0)) },
      'quick match paired',
    );
  }

  /**
   * Built-in arenas are on every phone. A photo arena must be shared, so every phone in the room
   * loads the same copy from GET /arenas/{id} (a shared arena never changes), and it stays out of
   * quick match: it is a photo of somewhere real, for friends only (AR-7).
   */
  private arenaProblem(arenaId: string, quick: boolean): { code: ErrorCode; message: string } | null {
    if (!isPhotoArenaId(arenaId)) return null;
    if (quick) return { code: 'arena_friends_only', message: 'Photo arenas are for friends; quick match uses the built-in arenas' };
    if (!this.options.accounts?.sharedArenaOwner(arenaId)) return { code: 'arena_not_shared', message: 'Share that arena first, so the other phones can load it' };
    return null;
  }

  /** Finished matches move both ratings; so does leaving one, which loses it. Desyncs and closed rooms don't count. */
  private rateQuickMatch(accounts: [string | null, string | null], winnerSide: Side | null, reason: EndReason): void {
    const [left, right] = accounts;
    const store = this.options.accounts;
    if (!store || !left || !right) return;
    if (reason !== 'finished' && !(reason === 'disconnect' && winnerSide !== null)) return;
    if (store.recordQuickMatch(left, right, winnerSide === null ? null : accounts[winnerSide], reason)) {
      this.options.metrics.quickMatches.inc({ outcome: 'rated' });
    }
  }

  private closeRoom(hub: Hub): void {
    this.hubs.delete(hub.room.code);
    hub.close('input_ahead', 'A phone sent inputs far ahead of the match, so the room was closed');
    this.options.rooms.delete(hub.room.code);
  }

  private tick(): void {
    const now = this.options.now();
    for (const conn of this.connections) {
      if (now - conn.lastSeen > this.options.config.idleTimeoutMs) {
        conn.sendError('idle_timeout', 'No messages for too long');
        conn.ws.terminate();
        continue;
      }
      conn.rateDrops = 0;
      conn.send({ type: 'ping', time: now });
    }
    for (const hub of this.hubs.values()) hub.checkIdle(now);
  }

  private drop(reason: string): void {
    this.options.metrics.relayDropped.inc({ reason });
  }
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
