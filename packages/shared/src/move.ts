import { decodeBase64, encodeBase64 } from './base64.ts';
import { MOVE_FORMAT_VERSION } from './constants.ts';
import { cleanText, isInt, isRecord, oneOf } from './validate.ts';

export const MOVE_SLOTS = ['light', 'heavy', 'low', 'special', 'defense', 'taunt', 'victory'] as const;
export type MoveSlot = (typeof MOVE_SLOTS)[number];

/** How many moves of each slot a loadout may hold. */
export const LOADOUT_SLOT_LIMITS: Readonly<Record<MoveSlot, number>> = {
  light: 2,
  heavy: 2,
  low: 1,
  special: 1,
  defense: 1,
  taunt: 1,
  victory: 1,
};
export const LOADOUT_MAX_MOVES = Object.values(LOADOUT_SLOT_LIMITS).reduce((sum, n) => sum + n, 0);

export const STRIKE_HEIGHTS = ['high', 'mid', 'low'] as const;
export type StrikeHeight = (typeof STRIKE_HEIGHTS)[number];

/** The 17 joints of the standard stick man, in the order their angles appear in each frame. */
export const JOINTS = [
  'head',
  'neck',
  'pelvis',
  'leftShoulder',
  'leftElbow',
  'leftWrist',
  'rightShoulder',
  'rightElbow',
  'rightWrist',
  'leftHip',
  'leftKnee',
  'leftAnkle',
  'leftToe',
  'rightHip',
  'rightKnee',
  'rightAnkle',
  'rightToe',
] as const;
export type JointName = (typeof JOINTS)[number];

/**
 * Each frame is 19 signed 16-bit values: the root (pelvis) x and y in millimetres, then one
 * angle per joint in JOINTS order, in binary angle units (65536 per turn). 60 frames a second.
 */
export const FRAME_VALUES = 2 + JOINTS.length;
export const MOVE_MAX_FRAMES = 240;
export const MOVE_NAME_MAX_LENGTH = 32;
const FRAMES_MAX_CHARS = Math.ceil((MOVE_MAX_FRAMES * FRAME_VALUES * 2) / 3) * 4;

/** Move file, version 1 (Integration PRD). */
export interface MoveFile {
  id: string;
  version: typeof MOVE_FORMAT_VERSION;
  slot: MoveSlot;
  name: string;
  /** Base64 of little-endian int16 values, FRAME_VALUES per frame. */
  frames: string;
  /** First and last frame in which the striking limb can hit. */
  active: [first: number, last: number];
  limb: JointName;
  height: StrikeHeight;
  /** SHA-256 (hex) of the fields above; see computeMoveHash. */
  hash: string;
  /** Added by the server at launch. */
  signature?: string;
}

export type UnhashedMove = Omit<MoveFile, 'hash' | 'signature'>;

export function encodeFrames(values: Int16Array): string {
  const bytes = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return encodeBase64(bytes);
}

/** Decodes a move's frames; null when the base64 is bad or not a whole number of frames. */
export function decodeFrames(frames: string): Int16Array | null {
  const bytes = decodeBase64(frames);
  if (!bytes || bytes.length === 0 || bytes.length % (FRAME_VALUES * 2) !== 0) return null;
  const values = new Int16Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
  return values;
}

/**
 * SHA-256 over the canonical JSON array [id, version, slot, name, frames, [first, last], limb, height],
 * as lowercase hex. Both phones compare it before a match.
 */
export async function computeMoveHash(move: UnhashedMove): Promise<string> {
  const canonical = JSON.stringify([
    move.id,
    move.version,
    move.slot,
    move.name,
    move.frames,
    [move.active[0], move.active[1]],
    move.limb,
    move.height,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Adds the hash to a finished move. */
export async function withHash(move: UnhashedMove): Promise<MoveFile> {
  return { ...move, hash: await computeMoveHash(move) };
}

export async function verifyMoveHash(move: MoveFile): Promise<boolean> {
  return (await computeMoveHash(move)) === move.hash;
}

/** The name a move gets when Meta AI can't name it, such as "Heavy 2". */
export function defaultMoveName(slot: MoveSlot, index = 1): string {
  return `${slot.charAt(0).toUpperCase()}${slot.slice(1)} ${index}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Checks a move file's structure and returns a copy holding only the contract's fields, or null.
 * Hashed fields are never altered, so a name must already be clean text.
 */
export function parseMoveFile(value: unknown): MoveFile | null {
  if (!isRecord(value)) return null;
  const { id, version, slot, name, frames, active, limb, height, hash, signature } = value;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  if (version !== MOVE_FORMAT_VERSION || !oneOf(MOVE_SLOTS, slot)) return null;
  if (typeof name !== 'string' || cleanText(name, MOVE_NAME_MAX_LENGTH) !== name) return null;
  if (typeof frames !== 'string' || frames.length > FRAMES_MAX_CHARS) return null;
  const values = decodeFrames(frames);
  if (!values) return null;
  const frameCount = values.length / FRAME_VALUES;
  if (frameCount > MOVE_MAX_FRAMES) return null;
  if (!Array.isArray(active) || active.length !== 2) return null;
  const [first, last] = active as unknown[];
  if (!isInt(first, 0, frameCount - 1) || !isInt(last, first, frameCount - 1)) return null;
  if (!oneOf(JOINTS, limb) || !oneOf(STRIKE_HEIGHTS, height)) return null;
  if (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)) return null;
  if (signature !== undefined && (typeof signature !== 'string' || signature.length > 512)) return null;

  const move: MoveFile = { id, version: MOVE_FORMAT_VERSION, slot, name, frames, active: [first, last], limb, height, hash };
  if (signature !== undefined) move.signature = signature;
  return move;
}

/** A loadout is 1 to 9 moves with unique ids and at most LOADOUT_SLOT_LIMITS of each slot. */
export function parseLoadout(value: unknown): MoveFile[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > LOADOUT_MAX_MOVES) return null;
  const moves: MoveFile[] = [];
  const ids = new Set<string>();
  const perSlot = new Map<MoveSlot, number>();
  for (const item of value) {
    const move = parseMoveFile(item);
    if (!move || ids.has(move.id)) return null;
    const count = (perSlot.get(move.slot) ?? 0) + 1;
    if (count > LOADOUT_SLOT_LIMITS[move.slot]) return null;
    ids.add(move.id);
    perSlot.set(move.slot, count);
    moves.push(move);
  }
  return moves;
}
