import { isArenaId } from './arena.ts';
import { isButtons } from './buttons.ts';
import { MAX_ROOM_PLAYERS } from './constants.ts';
import { parseLoadout, type MoveFile } from './move.ts';
import { isInt, isNum, isRecord } from './validate.ts';

/** Room messages travel over one WebSocket per phone, as JSON text in the MVP. */

export const MAX_FRAME = 0x7fffffff;

export const ERROR_CODES = [
  'room_not_found',
  'room_full',
  'version_mismatch',
  'bad_nickname',
  'not_joined',
  'already_joined',
  'not_host',
  'not_fighter',
  'match_in_progress',
  'no_loadout',
  'rate_limited',
  'input_ahead',
  'idle_timeout',
  'server_shutdown',
  // Quick match (launch).
  'not_signed_in',
  'nickname_blocked',
  'unsigned_move',
  'quick_match_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const END_REASONS = ['finished', 'desync', 'disconnect', 'room_closed'] as const;
export type EndReason = (typeof END_REASONS)[number];

export interface RoomPlayerInfo {
  player: number;
  nickname: string;
  host: boolean;
  ready: boolean;
  hasLoadout: boolean;
}

export interface RoomInfo {
  code: string;
  players: RoomPlayerInfo[];
  arenaId: string | null;
  /** Fight order, winner stays on: queue[0] and queue[1] fight next. */
  queue: number[];
  /** The two fighters while a match runs, otherwise null. */
  fighters: [number, number] | null;
}

// Phone to relay.

export interface JoinMessage {
  type: 'join';
  room: string;
  nickname: string;
  clientVersion: number;
}
export interface LoadoutMessage {
  type: 'loadout';
  moves: MoveFile[];
}
export interface ArenaMessage {
  type: 'arena';
  arenaId: string;
}
export interface ReadyMessage {
  type: 'ready';
  /** True when this phone can play with rollback netcode. The relay uses it only when both fighters can. */
  rollback?: boolean;
}
/** Buttons for one frame. The relay passes it straight to the other fighter. */
export interface InputMessage {
  type: 'input';
  frame: number;
  buttons: number;
}
/** Unsigned 32-bit hash of the state after simulating `frame`; sent every 60 frames. */
export interface HashMessage {
  type: 'hash';
  frame: number;
  stateHash: number;
}
/** The winner's player number, or null for a draw. */
export interface EndMessage {
  type: 'end';
  winner: number | null;
}
export interface PingMessage {
  type: 'ping';
  time: number;
}
export interface PongMessage {
  type: 'pong';
  time: number;
}
/**
 * Rollback matches only: how many frames late the opponent's inputs reach this phone, averaged
 * over the last half second. The relay passes it to the opponent; comparing the two tells which
 * phone runs ahead, and that phone slows down a little.
 */
export interface SyncMessage {
  type: 'sync';
  lateness: number;
}

/** A sync message's lateness is at most this many frames either way. */
export const MAX_SYNC_LATENESS = 600;

/**
 * Quick match (launch, MP-7): look for a stranger of similar skill and ping. Needs a signed-in
 * account (the relay reads the sign-in cookie when the socket opens) and no room. The relay
 * answers queued, then joined and matched once it pairs two players in a new two-player room.
 */
export interface QuickMatchMessage {
  type: 'quickmatch';
  nickname: string;
}
/** Stops looking for a quick match. */
export interface CancelMatchMessage {
  type: 'cancelmatch';
}
/** Leaves the current room but keeps the connection, for another quick match or room. */
export interface LeaveMessage {
  type: 'leave';
}

export type ClientMessage =
  | JoinMessage
  | LoadoutMessage
  | ArenaMessage
  | ReadyMessage
  | InputMessage
  | HashMessage
  | EndMessage
  | PingMessage
  | PongMessage
  | SyncMessage
  | QuickMatchMessage
  | CancelMatchMessage
  | LeaveMessage;

// Relay to phone.

export interface JoinedMessage {
  type: 'joined';
  player: number;
  host: boolean;
  room: RoomInfo;
}
export interface RoomMessage {
  type: 'room';
  room: RoomInfo;
}
export interface PlayerLoadoutMessage {
  type: 'loadout';
  player: number;
  moves: MoveFile[];
}
/** Both fighters begin on `startFrame`. `fighters[0]` is the left side, `fighters[1]` the right. */
export interface StartMessage {
  type: 'start';
  seed: number;
  inputDelay: number;
  startFrame: number;
  fighters: [number, number];
  arenaId: string | null;
  /**
   * Frames a phone may play on a guess of the opponent's input before it must wait (rollback
   * netcode). 0, or missing from an older relay, means input delay only: wait for every input.
   */
  rollback?: number;
}
export interface MatchEndMessage {
  type: 'end';
  winner: number | null;
  reason: EndReason;
}
export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}
/** In the quick match queue, looking for an opponent. */
export interface QueuedMessage {
  type: 'queued';
}
/**
 * Paired with a stranger; sent right after joined puts this phone in the new room. `id` is the
 * opponent's account id, for blocking or reporting them. Their nickname is shown only once Meta
 * AI has checked it; otherwise it reads Challenger.
 */
export interface MatchedMessage {
  type: 'matched';
  opponent: { id: string; nickname: string };
}

export type ServerMessage =
  | JoinedMessage
  | RoomMessage
  | PlayerLoadoutMessage
  | ArenaMessage
  | StartMessage
  | InputMessage
  | HashMessage
  | MatchEndMessage
  | PingMessage
  | PongMessage
  | SyncMessage
  | QueuedMessage
  | MatchedMessage
  | ErrorMessage;

/**
 * Parses and checks one message from a phone. Returns null for anything malformed, which the
 * relay drops. Join is only shape-checked here so the relay can answer a bad nickname or room.
 */
export function parseClientMessage(data: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const m = parsed;
  switch (m.type) {
    case 'input':
      return isInt(m.frame, 0, MAX_FRAME) && isButtons(m.buttons) ? { type: 'input', frame: m.frame, buttons: m.buttons } : null;
    case 'hash':
      return isInt(m.frame, 0, MAX_FRAME) && isInt(m.stateHash, 0, 0xffffffff)
        ? { type: 'hash', frame: m.frame, stateHash: m.stateHash }
        : null;
    case 'ping':
    case 'pong':
      return isNum(m.time, 0, Number.MAX_SAFE_INTEGER) ? { type: m.type, time: m.time } : null;
    case 'join':
      return typeof m.room === 'string' &&
        m.room.length <= 64 &&
        typeof m.nickname === 'string' &&
        m.nickname.length <= 256 &&
        isInt(m.clientVersion, 0, 1_000_000_000)
        ? { type: 'join', room: m.room, nickname: m.nickname, clientVersion: m.clientVersion }
        : null;
    case 'loadout': {
      const moves = parseLoadout(m.moves);
      return moves ? { type: 'loadout', moves } : null;
    }
    case 'arena':
      return isArenaId(m.arenaId) ? { type: 'arena', arenaId: m.arenaId } : null;
    case 'ready':
      return m.rollback === true ? { type: 'ready', rollback: true } : { type: 'ready' };
    case 'sync':
      return isNum(m.lateness, -MAX_SYNC_LATENESS, MAX_SYNC_LATENESS) ? { type: 'sync', lateness: m.lateness } : null;
    case 'quickmatch':
      return typeof m.nickname === 'string' && m.nickname.length <= 256 ? { type: 'quickmatch', nickname: m.nickname } : null;
    case 'cancelmatch':
    case 'leave':
      return { type: m.type };
    case 'end':
      return m.winner === null || isInt(m.winner, 1, MAX_ROOM_PLAYERS) ? { type: 'end', winner: m.winner } : null;
    default:
      return null;
  }
}

const SERVER_MESSAGE_TYPES = new Set<string>([
  'joined',
  'room',
  'loadout',
  'arena',
  'start',
  'input',
  'hash',
  'end',
  'ping',
  'pong',
  'sync',
  'queued',
  'matched',
  'error',
]);

/** Parses one message from the relay. The relay is trusted, so only the type is checked. */
export function parseServerMessage(data: string): ServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) && typeof parsed.type === 'string' && SERVER_MESSAGE_TYPES.has(parsed.type)
      ? (parsed as unknown as ServerMessage)
      : null;
  } catch {
    return null;
  }
}
