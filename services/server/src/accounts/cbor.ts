/**
 * The part of CBOR (RFC 8949) that passkeys use: integers, byte and text strings, arrays, maps
 * and simple values, all of definite length. Anything else is refused, as are lengths running
 * past the input, so a hostile passkey answer can't make the server allocate or loop much.
 */

export type CborValue = number | Uint8Array | string | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 16;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes the item starting at `offset`; returns it and the offset just after it. */
export function decodeCbor(bytes: Uint8Array, offset = 0): { value: CborValue; end: number } {
  const state = { bytes, offset };
  const value = readItem(state, 0);
  return { value, end: state.offset };
}

/** Decodes input that holds exactly one item. */
export function decodeCborExact(bytes: Uint8Array): CborValue {
  const { value, end } = decodeCbor(bytes);
  if (end !== bytes.length) throw new CborError('Trailing bytes after the CBOR item');
  return value;
}

interface State {
  bytes: Uint8Array;
  offset: number;
}

function readItem(state: State, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('CBOR nested too deeply');
  const initial = readByte(state);
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    throw new CborError('Unsupported CBOR simple value or float');
  }
  const argument = readArgument(state, info);
  switch (major) {
    case 0:
      return argument;
    case 1:
      return -1 - argument;
    case 2:
      return readBytes(state, argument).slice();
    case 3:
      try {
        return utf8.decode(readBytes(state, argument));
      } catch {
        throw new CborError('CBOR text is not valid UTF-8');
      }
    case 4: {
      // Every item takes at least one byte, so a longer count is a lie.
      if (argument > state.bytes.length - state.offset) throw new CborError('CBOR array runs past the end');
      const items: CborValue[] = [];
      for (let i = 0; i < argument; i++) items.push(readItem(state, depth + 1));
      return items;
    }
    case 5: {
      if (argument * 2 > state.bytes.length - state.offset) throw new CborError('CBOR map runs past the end');
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < argument; i++) {
        const key = readItem(state, depth + 1);
        if (typeof key !== 'number' && typeof key !== 'string') throw new CborError('CBOR map keys must be integers or text');
        if (map.has(key)) throw new CborError('Duplicate CBOR map key');
        map.set(key, readItem(state, depth + 1));
      }
      return map;
    }
    default:
      throw new CborError('CBOR tags are not supported');
  }
}

function readArgument(state: State, info: number): number {
  if (info < 24) return info;
  if (info === 24) return readByte(state);
  if (info === 25) return (readByte(state) << 8) | readByte(state);
  if (info === 26) {
    const bytes = readBytes(state, 4);
    return ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
  }
  if (info === 27) {
    const bytes = readBytes(state, 8);
    const high = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
    const low = ((bytes[4]! << 24) >>> 0) + (bytes[5]! << 16) + (bytes[6]! << 8) + bytes[7]!;
    const value = high * 2 ** 32 + low;
    if (!Number.isSafeInteger(value)) throw new CborError('CBOR integer too large');
    return value;
  }
  throw new CborError('Indefinite or reserved CBOR length');
}

function readByte(state: State): number {
  if (state.offset >= state.bytes.length) throw new CborError('CBOR ends early');
  return state.bytes[state.offset++]!;
}

function readBytes(state: State, length: number): Uint8Array {
  if (length > state.bytes.length - state.offset) throw new CborError('CBOR string runs past the end');
  const out = state.bytes.subarray(state.offset, state.offset + length);
  state.offset += length;
  return out;
}
