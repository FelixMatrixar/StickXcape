import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url, type MoveFile } from '@sticxcape/shared';

const PREFIX = 'v1.';
const DOMAIN = 'sticxcape-move-v1|';

/**
 * Signs moves the server has checked (MP-8), so quick match can take a loadout on trust: a
 * signature covers the move's hash, and the hash covers everything that decides how the move
 * plays. The key lives with the accounts, so signatures outlast restarts. Only the server
 * checks them, so a keyed hash (HMAC-SHA256) is enough.
 */
export class MoveSigner {
  private readonly key: Uint8Array;

  constructor(key: Uint8Array) {
    this.key = key;
  }

  sign(move: MoveFile): MoveFile {
    return { ...move, signature: PREFIX + encodeBase64Url(this.mac(move.hash)) };
  }

  /** True when the server signed this exact move: the signature matches, and so does the hash. */
  verify(move: MoveFile): boolean {
    const signature = move.signature;
    if (!signature?.startsWith(PREFIX)) return false;
    const given = decodeBase64Url(signature.slice(PREFIX.length));
    const expected = this.mac(move.hash);
    if (!given || given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    // A copied hash on altered frames must not pass, so the hash is checked against the contents.
    return moveHashSync(move) === move.hash;
  }

  private mac(hash: string): Uint8Array {
    return createHmac('sha256', this.key).update(DOMAIN + hash).digest();
  }
}

/** computeMoveHash from the shared package, synchronously, for the relay's message handler. */
export function moveHashSync(move: MoveFile): string {
  const canonical = JSON.stringify([move.id, move.version, move.slot, move.name, move.frames, [move.active[0], move.active[1]], move.limb, move.height]);
  return createHash('sha256').update(canonical).digest('hex');
}
