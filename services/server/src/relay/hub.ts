import type { FastifyBaseLogger } from 'fastify';
import {
  FRAME_MS,
  inputDelayForPing,
  type EndReason,
  type ErrorCode,
  type MoveFile,
  type RoomInfo,
  type StartMessage,
} from '@sticxcape/shared';
import type { RelayConfig } from '../config.ts';
import { newSeed } from '../lib/random.ts';
import type { Metrics } from '../metrics/metrics.ts';
import type { Room } from '../rooms/room-store.ts';
import type { Connection } from './connection.ts';

export interface HubContext {
  config: RelayConfig;
  metrics: Metrics;
  log: FastifyBaseLogger;
  now: () => number;
  /** Closes the whole room, as when a phone sends inputs far ahead of the match clock. */
  closeRoom: (hub: Hub) => void;
}

type Side = 0 | 1;

interface Match {
  fighters: [number, number];
  startFrame: number;
  inputDelay: number;
  startedAt: number;
  /** The next input frame expected from each fighter: inputs arrive in order with no gaps. */
  nextInput: [number, number];
  lastInputAt: [number, number];
  /** State hashes by frame, kept until both fighters have sent theirs. */
  hashes: Map<number, [number | null, number | null]>;
  /** The winner each fighter reported; undefined until they send end. */
  ends: [number | null | undefined, number | null | undefined];
  endTimer: NodeJS.Timeout | null;
}

const MAX_PENDING_HASHES = 32;

/**
 * One hub per room: the lobby, passing loadouts and inputs between the two fighters, and
 * keeping the match honest (input order, state hashes, agreed result). It never runs the fight.
 */
export class Hub {
  readonly room: Room;
  private readonly ctx: HubContext;
  private readonly conns = new Map<number, Connection>();
  /** Loadouts pass through in memory only and are never logged. */
  private readonly loadouts = new Map<number, MoveFile[]>();
  private readonly ready = new Set<number>();
  /** Fight order, winner stays on: queue[0] and queue[1] fight next. */
  private queue: number[] = [];
  /** The next two fighters as last announced; they have each other's loadouts. */
  private pairing: [number, number] | null = null;
  private match: Match | null = null;

  constructor(room: Room, ctx: HubContext) {
    this.room = room;
    this.ctx = ctx;
  }

  get isEmpty(): boolean {
    return this.conns.size === 0;
  }

  get inMatch(): boolean {
    return this.match !== null;
  }

  /** Adds a phone to the room. False when the room is full. */
  join(conn: Connection, nickname: string): boolean {
    const member = this.room.addMember(nickname);
    if (!member) return false;
    conn.hub = this;
    conn.player = member.player;
    conn.nickname = nickname;
    this.conns.set(member.player, conn);
    this.queue.push(member.player);
    conn.send({ type: 'joined', player: member.player, host: this.room.host === member.player, room: this.info() });
    this.ctx.log.info({ room: this.room.code, nickname, player: member.player }, 'player joined');
    this.updatePairing();
    this.broadcastRoom();
    return true;
  }

  leave(player: number): void {
    const conn = this.conns.get(player);
    if (!conn) return;
    this.conns.delete(player);
    this.loadouts.delete(player);
    this.ready.delete(player);
    this.queue = this.queue.filter((p) => p !== player);
    this.room.removeMember(player, this.ctx.now());
    this.ctx.log.info({ room: this.room.code, nickname: conn.nickname, player }, 'player left');

    const match = this.match;
    if (match && match.fighters.includes(player)) {
      this.endMatch('disconnect', match.fighters[0] === player ? match.fighters[1] : match.fighters[0]);
    } else {
      this.updatePairing();
      this.broadcastRoom();
    }
  }

  setLoadout(player: number, moves: MoveFile[]): void {
    if (this.match?.fighters.includes(player)) return this.error(player, 'match_in_progress', 'Loadouts are locked during a match');
    this.loadouts.set(player, moves);
    this.ready.delete(player);
    const opponent = this.pairedWith(player);
    if (opponent !== null) this.conns.get(opponent)?.send({ type: 'loadout', player, moves });
    this.broadcastRoom();
  }

  setArena(player: number, arenaId: string): void {
    if (this.room.host !== player) return this.error(player, 'not_host', 'Only the host picks the arena');
    if (this.match) return this.error(player, 'match_in_progress', 'The arena is locked during a match');
    this.room.arenaId = arenaId;
    // Changing the arena after someone readied would be a bait-and-switch, so both ready again.
    this.ready.clear();
    for (const [p, conn] of this.conns) if (p !== player) conn.send({ type: 'arena', arenaId });
    this.broadcastRoom();
  }

  setReady(player: number): void {
    if (this.match) return this.error(player, 'match_in_progress', 'A match is already running');
    const pairing = this.pairing;
    if (!pairing || !pairing.includes(player)) return this.error(player, 'not_fighter', 'Wait for your turn to fight');
    if (!this.loadouts.has(player)) return this.error(player, 'no_loadout', 'Send a loadout before getting ready');
    this.ready.add(player);
    if (this.ready.has(pairing[0]) && this.ready.has(pairing[1])) this.startMatch(pairing);
    else this.broadcastRoom();
  }

  input(player: number, frame: number, buttons: number): void {
    const match = this.match;
    const side = this.sideOf(player);
    if (!match || side === null) return this.drop('not_in_match');
    if (frame !== match.nextInput[side]) return this.drop('out_of_order');

    const now = this.ctx.now();
    const clock = match.startFrame + Math.floor((now - match.startedAt) / FRAME_MS);
    if (frame > clock + match.inputDelay + this.ctx.config.aheadToleranceFrames) {
      this.ctx.log.warn({ room: this.room.code, nickname: this.nickname(player), frame, clock }, 'inputs far ahead of the match clock; closing the room');
      this.ctx.closeRoom(this);
      return;
    }
    match.nextInput[side] = frame + 1;
    match.lastInputAt[side] = now;
    this.conns.get(match.fighters[other(side)])?.sendText(`{"type":"input","frame":${frame},"buttons":${buttons}}`);
  }

  hash(player: number, frame: number, stateHash: number): void {
    const match = this.match;
    const side = this.sideOf(player);
    if (!match || side === null) return this.drop('not_in_match');
    this.conns.get(match.fighters[other(side)])?.send({ type: 'hash', frame, stateHash });

    let entry = match.hashes.get(frame);
    if (!entry) {
      if (match.hashes.size >= MAX_PENDING_HASHES) match.hashes.delete(match.hashes.keys().next().value!);
      entry = [null, null];
      match.hashes.set(frame, entry);
    }
    if (entry[side] !== null) return;
    entry[side] = stateHash;
    const theirs = entry[other(side)];
    if (theirs === null) return;
    match.hashes.delete(frame);
    if (theirs !== stateHash) {
      this.ctx.log.warn({ room: this.room.code, frame, fighters: match.fighters.map((p) => this.nickname(p)) }, 'state hashes differ; ending the match as a desync');
      this.endMatch('desync', null);
    }
  }

  end(player: number, winner: number | null): void {
    const match = this.match;
    const side = this.sideOf(player);
    if (!match || side === null) return;
    if (winner !== null && !match.fighters.includes(winner)) return this.drop('malformed');
    if (match.ends[side] !== undefined) return;
    match.ends[side] = winner;

    const theirs = match.ends[other(side)];
    if (theirs !== undefined) {
      // Both phones ran the same fight, so they must agree on the winner.
      if (theirs === winner) this.endMatch('finished', winner);
      else this.endMatch('desync', null);
      return;
    }
    match.endTimer = setTimeout(() => {
      if (this.match === match) this.endMatch('finished', winner);
    }, this.ctx.config.endConfirmMs);
  }

  /** Ends the match when a fighter has sent no input for too long, such as a backgrounded phone. */
  checkIdle(now: number): void {
    const match = this.match;
    if (!match) return;
    const limit = this.ctx.config.matchIdleTimeoutMs;
    const idle = match.lastInputAt.map((at) => now - at > limit);
    if (idle[0] && idle[1]) this.endMatch('disconnect', null);
    else if (idle[0]) this.endMatch('disconnect', match.fighters[1]);
    else if (idle[1]) this.endMatch('disconnect', match.fighters[0]);
  }

  /** Tells every phone why the room is closing, ends any match and disconnects everyone. */
  close(code: ErrorCode, message: string): void {
    if (this.match) this.endMatch('room_closed', null);
    for (const conn of this.conns.values()) {
      conn.hub = null;
      conn.player = null;
      conn.sendError(code, message);
      conn.close(1008, code);
    }
    this.conns.clear();
  }

  info(): RoomInfo {
    return {
      code: this.room.code,
      players: [...this.room.members.values()]
        .sort((a, b) => a.player - b.player)
        .map(({ player, nickname }) => ({
          player,
          nickname,
          host: player === this.room.host,
          ready: this.ready.has(player),
          hasLoadout: this.loadouts.has(player),
        })),
      arenaId: this.room.arenaId,
      queue: [...this.queue],
      fighters: this.match ? [this.match.fighters[0], this.match.fighters[1]] : null,
    };
  }

  private startMatch([a, b]: [number, number]): void {
    const connA = this.conns.get(a);
    const connB = this.conns.get(b);
    if (!connA || !connB) return;
    const { defaultRttMs } = this.ctx.config;
    const pingMs = (connA.rtt() ?? defaultRttMs) + (connB.rtt() ?? defaultRttMs);
    const inputDelay = inputDelayForPing(pingMs);
    const now = this.ctx.now();
    const startFrame = 0;
    this.match = {
      fighters: [a, b],
      startFrame,
      inputDelay,
      startedAt: now,
      nextInput: [startFrame + inputDelay, startFrame + inputDelay],
      lastInputAt: [now, now],
      hashes: new Map(),
      ends: [undefined, undefined],
      endTimer: null,
    };
    this.room.inMatch = true;
    const start: StartMessage = { type: 'start', seed: newSeed(), inputDelay, startFrame, fighters: [a, b], arenaId: this.room.arenaId };
    connA.send(start);
    connB.send(start);
    this.ctx.metrics.matchesStarted.inc();
    this.ctx.log.info({ room: this.room.code, fighters: [connA.nickname, connB.nickname], pingMs, inputDelay }, 'match started');
    this.broadcastRoom();
  }

  private endMatch(reason: EndReason, winner: number | null): void {
    const match = this.match;
    if (!match) return;
    if (match.endTimer) clearTimeout(match.endTimer);
    this.match = null;
    this.room.inMatch = false;
    for (const player of match.fighters) {
      this.ready.delete(player);
      this.conns.get(player)?.send({ type: 'end', winner, reason });
    }
    // Winner stays on: the loser goes to the back of the queue; after a draw the challenger does.
    // A desync is nobody's fault, so the order stays.
    if (reason === 'finished' || reason === 'disconnect') {
      const loser = winner === match.fighters[1] ? match.fighters[0] : match.fighters[1];
      if (this.queue.includes(loser)) this.queue = [...this.queue.filter((p) => p !== loser), loser];
    }
    this.ctx.metrics.matchesEnded.inc({ reason });
    this.ctx.log.info({ room: this.room.code, reason, winner: winner === null ? null : this.nickname(winner) }, 'match ended');
    this.updatePairing();
    this.broadcastRoom();
  }

  /** When the next two fighters change, each gets the other's loadout. */
  private updatePairing(): void {
    const next: [number, number] | null = this.queue.length >= 2 ? [this.queue[0]!, this.queue[1]!] : null;
    const previous = this.pairing;
    this.pairing = next;
    if (next && previous && next.includes(previous[0]) && next.includes(previous[1])) return;
    // A new opponent is a fresh decision to fight, so ready flags reset.
    this.ready.clear();
    if (!next) return;
    for (const [me, them] of [
      [next[0], next[1]],
      [next[1], next[0]],
    ] as const) {
      const moves = this.loadouts.get(them);
      if (moves) this.conns.get(me)?.send({ type: 'loadout', player: them, moves });
    }
  }

  private broadcastRoom(): void {
    const text = JSON.stringify({ type: 'room', room: this.info() });
    for (const conn of this.conns.values()) conn.sendText(text);
  }

  private pairedWith(player: number): number | null {
    if (!this.pairing) return null;
    if (this.pairing[0] === player) return this.pairing[1];
    if (this.pairing[1] === player) return this.pairing[0];
    return null;
  }

  private sideOf(player: number): Side | null {
    if (!this.match) return null;
    if (this.match.fighters[0] === player) return 0;
    if (this.match.fighters[1] === player) return 1;
    return null;
  }

  private nickname(player: number): string | undefined {
    return this.room.members.get(player)?.nickname;
  }

  private error(player: number, code: ErrorCode, message: string): void {
    this.conns.get(player)?.sendError(code, message);
  }

  private drop(reason: string): void {
    this.ctx.metrics.relayDropped.inc({ reason });
  }
}

function other(side: Side): Side {
  return side === 0 ? 1 : 0;
}
