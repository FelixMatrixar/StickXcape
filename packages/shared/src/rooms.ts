/** Room codes: 16 characters of Crockford base32 (no i, l, o or u), so 80 random bits. */
export const ROOM_CODE_LENGTH = 16;
export const ROOM_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ROOM_CODE_PATTERN = /^[0-9a-hjkmnp-tv-z]{16}$/;

/** Invite links look like https://host/r/{code}; the web app reads the code from the path. */
export const ROOM_LINK_PATH = '/r/';

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value);
}

export function roomLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}${ROOM_LINK_PATH}${code}`;
}

/** The room code in an invite link's path, such as "/r/abc...", or null. */
export function roomCodeFromPath(pathname: string): string | null {
  const match = /^\/r\/([0-9A-Za-z]+)\/?$/.exec(pathname);
  const code = match?.[1]?.toLowerCase();
  return code !== undefined && isRoomCode(code) ? code : null;
}
