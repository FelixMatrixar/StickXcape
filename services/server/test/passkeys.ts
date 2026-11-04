import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { PasskeyAuthenticator } from '@sticxcape/netcode';
import {
  decodeBase64Url,
  encodeBase64Url,
  type PasskeyAssertion,
  type PasskeyCreationOptions,
  type PasskeyRegistration,
  type PasskeyRequestOptions,
} from '@sticxcape/shared';

export type Cbor = number | string | Uint8Array | boolean | null | Cbor[] | Map<Cbor, Cbor>;

/** Encodes CBOR the way authenticators do (definite lengths, shortest form). */
export function encodeCbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const write = (item: Cbor): void => {
    if (typeof item === 'number') out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) out.push(...head(2, item.length), ...item);
    else if (item === true) out.push(0xf5);
    else if (item === false) out.push(0xf4);
    else if (item === null) out.push(0xf6);
    else if (Array.isArray(item)) {
      out.push(...head(4, item.length));
      for (const element of item) write(element);
    } else {
      out.push(...head(5, item.size));
      for (const [key, element] of item) {
        write(key);
        write(element);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  if (length < 0x100000000) return [(major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  throw new Error('Too large for this test encoder');
}

export type PasskeyAlgorithm = -7 | -8 | -257;

export interface SoftwarePasskey {
  id: Uint8Array;
  algorithm: PasskeyAlgorithm;
  privateKey: KeyObject;
  /** The COSE public key, as sent at sign-up. */
  publicKey: Uint8Array;
  rpId: string;
  userHandle: string;
  signCount: number;
}

/** Parts of a passkey answer a test can change, to check that the server notices. */
export interface AnswerChanges {
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  /** Signs this instead of the real data. */
  breakSignature?: boolean;
  userHandle?: string | null;
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

/**
 * A passkey authenticator in software, as a phone's would be: it makes key pairs, keeps them per
 * site, and signs challenges. ES256 by default; EdDSA and RS256 on request. Synced passkeys
 * always report a signature counter of 0, so counting is off unless asked for.
 */
export class SoftwarePasskeys implements PasskeyAuthenticator {
  readonly saved: SoftwarePasskey[] = [];
  /** The page origin the "browser" reports in clientDataJSON. */
  origin: string;
  algorithm: PasskeyAlgorithm;
  counting: boolean;

  constructor(origin: string, options: { algorithm?: PasskeyAlgorithm; counting?: boolean } = {}) {
    this.origin = origin;
    this.algorithm = options.algorithm ?? -7;
    this.counting = options.counting ?? false;
  }

  async create(options: PasskeyCreationOptions): Promise<PasskeyRegistration> {
    return this.register(options);
  }

  register(options: PasskeyCreationOptions, changes: AnswerChanges = {}): PasskeyRegistration {
    if (!options.pubKeyCredParams.some((p) => p.alg === this.algorithm)) throw new Error('The site does not accept this algorithm');
    const { privateKey, cose } = makeKey(this.algorithm);
    const passkey: SoftwarePasskey = {
      id: new Uint8Array(randomBytes(16)),
      algorithm: this.algorithm,
      privateKey,
      publicKey: cose,
      rpId: options.rp.id,
      userHandle: options.user.id,
      signCount: 0,
    };
    const rpId = changes.rpId ?? options.rp.id;
    const flags = changes.flags ?? UP | UV | AT;
    const authData = concat(sha256(rpId), [flags], u32(passkey.signCount), new Uint8Array(16), u16(passkey.id.length), passkey.id, cose);
    const clientData = this.clientData(changes.type ?? 'webauthn.create', options.challenge, changes.origin);
    const attestation = encodeCbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.saved.push(passkey);
    return {
      id: encodeBase64Url(passkey.id),
      type: 'public-key',
      response: { clientDataJSON: encodeBase64Url(clientData), attestationObject: encodeBase64Url(attestation), transports: ['internal', 'hybrid'] },
    };
  }

  async get(options: PasskeyRequestOptions): Promise<PasskeyAssertion> {
    const passkey = this.saved.filter((p) => p.rpId === options.rpId).at(-1);
    if (!passkey) throw new Error('NotAllowedError: no passkey for this site');
    return this.answer(passkey, options.challenge, {});
  }

  /** Signs `challenge` with `passkey`, with any parts changed. */
  answer(passkey: SoftwarePasskey, challenge: string, changes: AnswerChanges): PasskeyAssertion {
    if (this.counting) passkey.signCount += 1;
    const authData = concat(sha256(changes.rpId ?? passkey.rpId), [changes.flags ?? UP | UV], u32(passkey.signCount));
    const clientData = this.clientData(changes.type ?? 'webauthn.get', challenge, changes.origin);
    const signed = concat(authData, sha256(clientData));
    const signature = signWith(passkey, changes.breakSignature ? concat(signed, [0]) : signed);
    return {
      id: encodeBase64Url(passkey.id),
      type: 'public-key',
      response: {
        clientDataJSON: encodeBase64Url(clientData),
        authenticatorData: encodeBase64Url(authData),
        signature: encodeBase64Url(signature),
        userHandle: changes.userHandle === undefined ? passkey.userHandle : changes.userHandle,
      },
    };
  }

  private clientData(type: string, challenge: string, origin = this.origin): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
}

function makeKey(algorithm: PasskeyAlgorithm): { privateKey: KeyObject; cose: Uint8Array } {
  const field = (value: string | undefined) => decodeBase64Url(value ?? '')!;
  if (algorithm === -7) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { privateKey, cose: encodeCbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, field(jwk.x)], [-3, field(jwk.y)]])) };
  }
  if (algorithm === -8) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    return { privateKey, cose: encodeCbor(new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, field(jwk.x)]])) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, cose: encodeCbor(new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, field(jwk.n)], [-2, field(jwk.e)]])) };
}

function signWith(passkey: SoftwarePasskey, data: Uint8Array): Uint8Array {
  if (passkey.algorithm === -7) return sign('sha256', data, { key: passkey.privateKey, dsaEncoding: 'der' });
  if (passkey.algorithm === -8) return sign(null, data, passkey.privateKey);
  return sign('sha256', data, passkey.privateKey);
}

function sha256(data: string | Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

/**
 * fetch with a cookie jar, as a browser keeps one per site: it sends the cookies it holds and
 * stores the ones the server sets. `lastSetCookie` is the last Set-Cookie line seen.
 */
export function cookieFetch(): typeof fetch & { cookies: Map<string, string>; lastSetCookie: string | null } {
  const cookies = new Map<string, string>();
  const jar = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
      const response = await fetch(input, { ...init, headers });
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';')[0]!;
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '' || /max-age=0/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
        jar.lastSetCookie = line;
      }
      return response;
    },
    { cookies, lastSetCookie: null as string | null },
  );
  return jar as typeof fetch & { cookies: Map<string, string>; lastSetCookie: string | null };
}
