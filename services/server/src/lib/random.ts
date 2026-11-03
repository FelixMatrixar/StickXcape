import { randomBytes } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@sticxcape/shared';

/** A new unguessable room code: 16 characters, 5 random bits each. */
export function newRoomCode(): string {
  let code = '';
  for (const byte of randomBytes(ROOM_CODE_LENGTH)) code += ROOM_CODE_ALPHABET.charAt(byte & 31);
  return code;
}

/** A random unsigned 32-bit seed for a match. */
export function newSeed(): number {
  return randomBytes(4).readUInt32LE(0);
}
