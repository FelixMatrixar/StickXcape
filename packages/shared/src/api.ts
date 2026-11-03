import { LOADOUT_MAX_MOVES, MOVE_NAME_MAX_LENGTH, MOVE_SLOTS, JOINTS, STRIKE_HEIGHTS } from './move.ts';
import type { JointName, MoveSlot, StrikeHeight } from './move.ts';
import { cleanText, isInt, isNum, isRecord, oneOf } from './validate.ts';

/** HTTP API (Integration PRD). Every call is JSON over HTTPS. */

/**
 * Phones send a random id they keep in storage, so AI rate limits apply per player
 * before accounts exist. Without it the server falls back to the IP address.
 */
export const PLAYER_ID_HEADER = 'x-player-id';
export const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface ApiError {
  error: string;
  message: string;
}

/** POST /rooms */
export interface CreateRoomRequest {
  nickname: string;
}
export interface CreateRoomResponse {
  code: string;
  link: string;
}

/** GET /rooms/{code} */
export interface RoomSummary {
  exists: true;
  players: { player: number; nickname: string; host: boolean }[];
  arena: string | null;
  inMatch: boolean;
}

/** GET /version */
export interface VersionResponse {
  minClientVersion: number;
  serverVersion: string;
}

/** POST /ai/move-name. Keyframes are 3 small drawings of the stick man as PNG or WebP data URLs. */
export interface MoveNameRequest {
  slot: MoveSlot;
  limb: JointName;
  height: StrikeHeight;
  /** Peak speed of the striking limb, in metres per second. */
  peakSpeed: number;
  keyframes: string[];
}
export interface MoveNameResponse {
  name: string;
  description: string;
}

export const KEYFRAME_COUNT = 3;
/** Longest accepted keyframe data URL, about 70 KB of image. */
export const KEYFRAME_MAX_CHARS = 96_000;
const KEYFRAME_PATTERN = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** POST /ai/match-tips: one player's per-move stats from a finished match. */
export interface MoveStats {
  name: string;
  slot: MoveSlot;
  height?: StrikeHeight;
  uses: number;
  hits: number;
  blocks: number;
  parries: number;
  misses: number;
}
export interface MatchTipsRequest {
  moves: MoveStats[];
  damageDealt: number;
  damageTaken: number;
  result?: 'win' | 'loss' | 'draw';
}
export interface MatchTipsResponse {
  tips: [string, string];
}

export const TIP_MAX_WORDS = 19;

export function parseMoveNameRequest(value: unknown): MoveNameRequest | null {
  if (!isRecord(value)) return null;
  const { slot, limb, height, peakSpeed, keyframes } = value;
  if (!oneOf(MOVE_SLOTS, slot) || !oneOf(JOINTS, limb) || !oneOf(STRIKE_HEIGHTS, height)) return null;
  if (!isNum(peakSpeed, 0, 100)) return null;
  if (!Array.isArray(keyframes) || keyframes.length !== KEYFRAME_COUNT) return null;
  const images: string[] = [];
  for (const image of keyframes) {
    if (typeof image !== 'string' || image.length > KEYFRAME_MAX_CHARS || !KEYFRAME_PATTERN.test(image)) return null;
    images.push(image);
  }
  return { slot, limb, height, peakSpeed, keyframes: images };
}

const COUNT_MAX = 10_000;

export function parseMatchTipsRequest(value: unknown): MatchTipsRequest | null {
  if (!isRecord(value)) return null;
  const { moves, damageDealt, damageTaken, result } = value;
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > LOADOUT_MAX_MOVES) return null;
  if (!isNum(damageDealt, 0, 100_000) || !isNum(damageTaken, 0, 100_000)) return null;
  if (result !== undefined && result !== 'win' && result !== 'loss' && result !== 'draw') return null;
  const stats: MoveStats[] = [];
  for (const move of moves) {
    if (!isRecord(move)) return null;
    const name = cleanText(move.name, MOVE_NAME_MAX_LENGTH);
    const { slot, height, uses, hits, blocks, parries, misses } = move;
    if (name === null || !oneOf(MOVE_SLOTS, slot)) return null;
    if (height !== undefined && !oneOf(STRIKE_HEIGHTS, height)) return null;
    if (![uses, hits, blocks, parries, misses].every((n) => isInt(n, 0, COUNT_MAX))) return null;
    const stat: MoveStats = {
      name,
      slot,
      uses: uses as number,
      hits: hits as number,
      blocks: blocks as number,
      parries: parries as number,
      misses: misses as number,
    };
    if (height !== undefined) stat.height = height;
    stats.push(stat);
  }
  const request: MatchTipsRequest = { moves: stats, damageDealt, damageTaken };
  if (result !== undefined) request.result = result;
  return request;
}
