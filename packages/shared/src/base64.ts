/** Standard base64 with padding, identical in browsers and Node (no atob or Buffer differences). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function encodeBase64(bytes: Uint8Array): string {
  const chars: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    chars.push(ALPHABET.charAt(n >>> 18), ALPHABET.charAt((n >>> 12) & 63), ALPHABET.charAt((n >>> 6) & 63), ALPHABET.charAt(n & 63));
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    chars.push(ALPHABET.charAt(n >>> 18), ALPHABET.charAt((n >>> 12) & 63));
    chars.push(rest === 2 ? ALPHABET.charAt((n >>> 6) & 63) : '=', '=');
  }
  return chars.join('');
}

/** Decodes strict base64; returns null for bad characters, length or padding. */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const a = sextet(text, i);
    const b = sextet(text, i + 1);
    const c = last && padding === 2 ? 0 : sextet(text, i + 2);
    const d = last && padding >= 1 ? 0 : sextet(text, i + 3);
    if ((a | b | c | d) < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >>> 16;
    if (o < out.length) out[o++] = (n >>> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** Base64url without padding, as WebAuthn uses for ids, challenges and binary fields in JSON. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url, with or without padding; returns null for anything else. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (/[+/=]/.test(text.replace(/=+$/, ''))) return null;
  const standard = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (standard.length % 4 === 1) return null;
  return decodeBase64(standard + '='.repeat((4 - (standard.length % 4)) % 4));
}

function sextet(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code < 128 ? LOOKUP[code]! : -1;
}
