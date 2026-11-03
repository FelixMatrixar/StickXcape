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

export type ClientMessage =
  | JoinMessage
  | LoadoutMessage
  | ArenaMessage
  | ReadyMessage
  | InputMessage
  | HashMessage
  | EndMessage
  | PingMessage
  | PongMessage;

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
      return { type: 'ready' };
    case 'end':
      return m.winner === null || isInt(m.winner, 1, MAX_ROOM_PLAYERS) ? { type: 'end', winner: m.winner } : null;
    default:
      return null;
  }
}

const SERVER_MESSAGE_TYPES = new Set<string>(['joined', 'room', 'loadout', 'arena', 'start', 'input', 'hash', 'end', 'ping', 'pong', 'error']);

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
