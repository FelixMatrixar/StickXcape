import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { cleanText, isRoomCode, NICKNAME_MAX_LENGTH, parseClientMessage, type ClientMessage, type JoinMessage } from '@sticxcape/shared';
import type { RelayConfig } from '../config.ts';
import { TokenBucket } from '../lib/limits.ts';
import type { Metrics } from '../metrics/metrics.ts';
import type { RoomStore } from '../rooms/room-store.ts';
import { Connection } from './connection.ts';
import { Hub, type HubContext } from './hub.ts';

export interface RelayOptions {
  config: RelayConfig;
  minClientVersion: number;
  rooms: RoomStore;
  metrics: Metrics;
  log: FastifyBaseLogger;
  now: () => number;
}

/** A phone sending more malformed messages than this is disconnected. */
const MAX_MALFORMED = 50;
/** Time one input in this many through the relay, for the forward-delay metric. */
const FORWARD_SAMPLE_EVERY = 16;

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
  private inputs = 0;

  constructor(options: RelayOptions) {
    this.options = options;
    this.hubContext = {
      config: options.config,
      metrics: options.metrics,
      log: options.log,
      now: options.now,
      closeRoom: (hub) => this.closeRoom(hub),
    };
    this.timer = setInterval(() => this.tick(), options.config.pingIntervalMs);
    this.timer.unref();
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

  accept(ws: WebSocket, ip: string): void {
    const { config, now } = this.options;
    const open = this.perIp.get(ip) ?? 0;
    if (open >= config.maxConnectionsPerIp) {
      ws.close(1008, 'too many connections');
      return;
    }
    this.perIp.set(ip, open + 1);
    const time = now();
    const conn = new Connection(ws, ip, new TokenBucket(config.messagesPerSecond, config.messageBurst, time), time);
    this.connections.add(conn);
    ws.on('message', (data, isBinary) => this.onMessage(conn, data, isBinary));
    ws.once('close', () => this.onClose(conn));
    // Ping straight away so the first round trip is known before anyone gets ready.
    conn.send({ type: 'ping', time });
  }

  /** Tells every phone the server is going away and closes their sockets. */
  shutdown(): void {
    clearInterval(this.timer);
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
    this.connections.delete(conn);
    const open = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (open > 0) this.perIp.set(conn.ip, open);
    else this.perIp.delete(conn.ip);

    const hub = conn.hub;
    const player = conn.player;
    if (!hub || player === null) return;
    conn.hub = null;
    conn.player = null;
    hub.leave(player);
    if (hub.isEmpty) this.hubs.delete(hub.room.code);
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
