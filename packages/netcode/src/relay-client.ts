import { CLIENT_VERSION, type ErrorCode, type MatchEndMessage, type MoveFile, type RoomInfo, type ServerMessage } from '@sticxcape/shared';
import { LockstepSession } from './lockstep.ts';
import type { RelayTransport } from './transport.ts';

/** An error the relay sent, such as room_not_found or version_mismatch (reload the page). */
export class RelayError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

export interface JoinResult {
  player: number;
  host: boolean;
  room: RoomInfo;
}

export interface RelayClientEvents {
  room: RoomInfo;
  loadout: { player: number; moves: MoveFile[] };
  arena: string;
  start: LockstepSession;
  end: MatchEndMessage;
  error: RelayError;
  close: string;
}

export interface RelayClientOptions {
  pingIntervalMs?: number;
  now?: () => number;
}

const RTT_SAMPLES = 5;

/**
 * The phone's side of a friend room: join, swap loadouts, pick the arena, get ready, and get a
 * LockstepSession for each match. It answers the relay's pings and measures its own round trip.
 */
export class RelayClient {
  readonly transport: RelayTransport;
  player: number | null = null;
  host = false;
  room: RoomInfo | null = null;
  /** The latest loadout received from each other player. */
  readonly loadouts = new Map<number, MoveFile[]>();
  /** The match in progress, if any. */
  session: LockstepSession | null = null;
  closed = false;

  private readonly now: () => number;
  private readonly listeners: { [E in keyof RelayClientEvents]?: ((value: RelayClientEvents[E]) => void)[] } = {};
  private readonly rtts: number[] = [];
  private pendingJoin: { resolve: (result: JoinResult) => void; reject: (error: Error) => void } | null = null;
  private readonly pingTimer: ReturnType<typeof setInterval>;

  constructor(transport: RelayTransport, options: RelayClientOptions = {}) {
    this.transport = transport;
    this.now = options.now ?? (() => performance.now());
    transport.onMessage((message) => this.handle(message));
    transport.onClose((reason) => {
      this.closed = true;
      clearInterval(this.pingTimer);
      this.pendingJoin?.reject(new Error(`Connection closed: ${reason}`));
      this.pendingJoin = null;
      this.emit('close', reason);
    });
    this.pingTimer = setInterval(() => this.ping(), options.pingIntervalMs ?? 2000);
  }

  /** Round trip to the relay in ms (median of recent pings), or null before the first answer. */
  get rtt(): number | null {
    if (this.rtts.length === 0) return null;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }

  /** Listens for an event; returns a function that stops listening. */
  on<E extends keyof RelayClientEvents>(event: E, listener: (value: RelayClientEvents[E]) => void): () => void {
    const list = (this.listeners[event] ??= []) as ((value: RelayClientEvents[E]) => void)[];
    list.push(listener);
    return () => {
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Joins a room by its code. Rejects with a RelayError such as room_not_found, room_full or version_mismatch. */
  join(room: string, nickname: string, clientVersion = CLIENT_VERSION): Promise<JoinResult> {
    if (this.pendingJoin || this.player !== null) return Promise.reject(new Error('Already joining or in a room'));
    return new Promise((resolve, reject) => {
      this.pendingJoin = { resolve, reject };
      this.transport.send({ type: 'join', room, nickname, clientVersion });
      this.ping();
    });
  }

  sendLoadout(moves: MoveFile[]): void {
    this.transport.send({ type: 'loadout', moves });
  }

  /** Host only. */
  setArena(arenaId: string): void {
    this.transport.send({ type: 'arena', arenaId });
  }

  ready(): void {
    this.transport.send({ type: 'ready' });
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.transport.close();
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case 'joined':
        this.player = message.player;
        this.host = message.host;
        this.room = message.room;
        this.pendingJoin?.resolve({ player: message.player, host: message.host, room: message.room });
        this.pendingJoin = null;
        return;
      case 'room':
        this.room = message.room;
        this.host = message.room.players.some((p) => p.player === this.player && p.host);
        for (const player of this.loadouts.keys()) {
          if (!message.room.players.some((p) => p.player === player)) this.loadouts.delete(player);
        }
        return this.emit('room', message.room);
      case 'loadout':
        this.loadouts.set(message.player, message.moves);
        return this.emit('loadout', { player: message.player, moves: message.moves });
      case 'arena':
        return this.emit('arena', message.arenaId);
      case 'start': {
        if (this.player === null) return;
        const session = new LockstepSession({ localPlayer: this.player, start: message, send: (m) => this.transport.send(m), now: this.now });
        this.session = session;
        return this.emit('start', session);
      }
      case 'input':
      case 'hash':
        return this.session?.receive(message);
      case 'end':
        this.session?.receive(message);
        this.session = null;
        return this.emit('end', message);
      case 'ping':
        return this.transport.send({ type: 'pong', time: message.time });
      case 'pong': {
        const rtt = this.now() - message.time;
        if (rtt >= 0) {
          this.rtts.push(rtt);
          if (this.rtts.length > RTT_SAMPLES) this.rtts.shift();
        }
        return;
      }
      case 'error': {
        const error = new RelayError(message.code, message.message);
        if (this.pendingJoin) {
          this.pendingJoin.reject(error);
          this.pendingJoin = null;
          return;
        }
        return this.emit('error', error);
      }
    }
  }

  private ping(): void {
    if (!this.closed) this.transport.send({ type: 'ping', time: this.now() });
  }

  private emit<E extends keyof RelayClientEvents>(event: E, value: RelayClientEvents[E]): void {
    for (const listener of this.listeners[event] ?? []) listener(value);
  }
}
