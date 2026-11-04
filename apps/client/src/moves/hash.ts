import type { MoveFile, UnhashedMove } from '@sticxcape/shared';
import { sha256Hex } from './sha256.ts';

/**
 * The move hash from the Integration PRD, computed without crypto.subtle: SHA-256 over the
 * canonical JSON array [id, version, slot, name, frames, [first, last], limb, height].
 * Gives the same hex as computeMoveHash in the shared package.
 */
export function moveHash(move: UnhashedMove): string {
  return sha256Hex(
    JSON.stringify([move.id, move.version, move.slot, move.name, move.frames, [move.active[0], move.active[1]], move.limb, move.height]),
  );
}

export function withHashSync(move: UnhashedMove): MoveFile {
  return { ...move, hash: moveHash(move) };
}

/** A fresh UUID, with a fallback for browsers that hide crypto.randomUUID on plain http. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Insecure context: fall through.
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
