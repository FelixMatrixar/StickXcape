import { NICKNAME_MAX_LENGTH } from './constants.ts';
import { parseMoveFile, type MoveFile } from './move.ts';
import { cleanText, isNum, isRecord } from './validate.ts';

/**
 * Accounts and the cloud move library (launch, MP-9). Players sign in with a passkey; nobody has
 * to, since guests keep playing with the moves on their phone. Every route is under /account.
 */
export const ACCOUNT_PATH = '/account';

/** A cloud library holds at most this many moves by default, idle stances included. */
export const LIBRARY_MAX_MOVES = 200;
export const MOVE_DESCRIPTION_MAX_LENGTH = 200;
/** Loadout places are short lowercase keys such as light1 or victory, each naming a move id. */
export const LOADOUT_PLACE_PATTERN = /^[a-z][a-z0-9]{0,15}$/;
export const LOADOUT_MAX_PLACES = 16;

export interface AccountInfo {
  id: string;
  /** The nickname given when the passkey was made; passkey managers show it next to SticXcape. */
  name: string;
  createdAt: number;
}

/** GET /account: who is signed in on this browser, and whether this server can use passkeys at all. */
export interface AccountResponse {
  account: AccountInfo | null;
  /** False when accounts are off, or the page isn't on HTTPS with a domain name (or localhost). */
  passkeys: boolean;
}

/** A move in the cloud library, kept the way the phone's own library keeps it. */
export interface CloudMove {
  move: MoveFile;
  /** An idle stance is kept with the moves but never offered as a fighting move. */
  kind: 'move' | 'idle';
  description: string | null;
  /** How clean the capture was, 0 to 1. */
  quality: number | null;
  createdAt: number;
  /** Set by the server whenever it stores the move. */
  updatedAt: number;
}

/** What the phone sends to store a move: everything but updatedAt. */
export type CloudMoveInput = Omit<CloudMove, 'updatedAt'>;

/** Loadout place (such as light1) to move id. Places without a move use the default moveset. */
export type LoadoutSelection = Record<string, string>;

/** GET /account/library */
export interface LibraryResponse {
  moves: CloudMove[];
  loadout: LoadoutSelection;
}

/** PUT /account/library/moves/{id} */
export interface SaveMoveResponse {
  updatedAt: number;
}

/**
 * POST /account/moves/sign: the server re-checks moves (MOVE_RULES) and signs them. Quick match
 * takes only signed moves, so sign the whole loadout, default moves included, before queueing.
 */
export interface SignMovesRequest {
  moves: MoveFile[];
}
export interface SignMovesResponse {
  moves: MoveFile[];
}
export const SIGN_MAX_MOVES = 16;

/** Reasons a player can be reported for: an offensive name, an offensive move or taunt, cheating, something else. */
export const REPORT_REASONS = ['name', 'moves', 'cheating', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_NOTE_MAX_LENGTH = 300;

/**
 * POST /reports: a report from a friend room's results screen, where players have only a
 * nickname. Sent with the phone's X-Player-Id; phones keep reports that fail and send them later.
 */
export interface RoomReport {
  nickname: string;
  reason: ReportReason;
  /** The room code the match was played in, when there was one. */
  room: string | null;
  /** When the phone made the report (ISO 8601); it may arrive later. */
  at: string;
}

export function parseRoomReport(value: unknown): RoomReport | null {
  if (!isRecord(value)) return null;
  const nickname = cleanText(value.nickname, NICKNAME_MAX_LENGTH);
  const { reason, room, at } = value;
  if (nickname === null || typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) return null;
  if (room !== null && room !== undefined && (typeof room !== 'string' || !/^[0-9a-z]{1,64}$/i.test(room))) return null;
  if (typeof at !== 'string' || at.length > 40 || Number.isNaN(Date.parse(at))) return null;
  return { nickname, reason: reason as ReportReason, room: typeof room === 'string' ? room.toLowerCase() : null, at };
}

/** POST /account/reports */
export interface ReportRequest {
  /** The opponent's id from the quick match's matched message. */
  player: string;
  reason: ReportReason;
  note?: string;
}

/** GET /account/blocks: players this account never gets matched with again. */
export interface BlockedPlayer {
  id: string;
  name: string;
  blockedAt: number;
}

/** Account ids are 16 base64url characters. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

// Passkeys. Binary fields travel as base64url strings, as in WebAuthn's own JSON forms.

/** Options for navigator.credentials.create, from POST /account/passkey/register/options. */
export interface PasskeyCreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' };
  excludeCredentials: { type: 'public-key'; id: string }[];
}

/** Options for navigator.credentials.get, from POST /account/passkey/login/options. */
export interface PasskeyRequestOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required';
  allowCredentials: { type: 'public-key'; id: string }[];
}

/** The new passkey, for POST /account/passkey/register. */
export interface PasskeyRegistration {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

/** The passkey's signature, for POST /account/passkey/login. */
export interface PasskeyAssertion {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
}

/** The options step's reply: the ceremony id goes back with the passkey's answer. */
export interface PasskeyCeremony<O> {
  ceremony: string;
  options: O;
}

/** A nickname for a new account; null when it isn't 1 to 16 characters of clean text. */
export function parseAccountName(value: unknown): string | null {
  return cleanText(value, NICKNAME_MAX_LENGTH);
}

/**
 * Checks a move sent to the cloud library. The move file's own hash is checked separately (it is
 * async); a description is tidied, and anything else malformed returns null.
 */
export function parseCloudMove(value: unknown): CloudMoveInput | null {
  if (!isRecord(value)) return null;
  const move = parseMoveFile(value.move);
  if (!move) return null;
  const kind = value.kind ?? 'move';
  if (kind !== 'move' && kind !== 'idle') return null;
  let description: string | null = null;
  if (value.description !== null && value.description !== undefined) {
    description = cleanText(value.description, MOVE_DESCRIPTION_MAX_LENGTH);
    if (description === null) return null;
  }
  const quality = value.quality ?? null;
  if (quality !== null && !isNum(quality, 0, 1)) return null;
  const createdAt = value.createdAt;
  if (!isNum(createdAt, 0, 8.64e15)) return null;
  return { move, kind, description, quality, createdAt };
}

/** Shape-checks a new passkey from the browser. The server checks what it says (webauthn.ts). */
export function parsePasskeyRegistration(value: unknown): PasskeyRegistration | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.type !== 'public-key' || !isRecord(value.response)) return null;
  const { clientDataJSON, attestationObject, transports } = value.response;
  if (typeof clientDataJSON !== 'string' || typeof attestationObject !== 'string') return null;
  if (transports !== undefined && (!Array.isArray(transports) || transports.length > 8 || !transports.every((t) => typeof t === 'string'))) return null;
  const response: PasskeyRegistration['response'] = { clientDataJSON, attestationObject };
  if (transports !== undefined) response.transports = transports as string[];
  return { id: value.id, type: 'public-key', response };
}

/** Shape-checks a passkey's signature from the browser. */
export function parsePasskeyAssertion(value: unknown): PasskeyAssertion | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.type !== 'public-key' || !isRecord(value.response)) return null;
  const { clientDataJSON, authenticatorData, signature, userHandle } = value.response;
  if (typeof clientDataJSON !== 'string' || typeof authenticatorData !== 'string' || typeof signature !== 'string') return null;
  if (userHandle !== null && userHandle !== undefined && typeof userHandle !== 'string') return null;
  return { id: value.id, type: 'public-key', response: { clientDataJSON, authenticatorData, signature, userHandle: userHandle ?? null } };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks a loadout selection: up to 16 places, each naming a move id. */
export function parseLoadoutSelection(value: unknown): LoadoutSelection | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > LOADOUT_MAX_PLACES) return null;
  const selection: LoadoutSelection = {};
  for (const [place, id] of entries) {
    if (!LOADOUT_PLACE_PATTERN.test(place) || typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
    selection[place] = id;
  }
  return selection;
}
