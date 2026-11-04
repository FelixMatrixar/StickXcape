import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url, type PasskeyAssertion, type PasskeyRegistration } from '@sticxcape/shared';
import { decodeCbor, decodeCborExact, type CborValue } from './cbor.ts';

/**
 * Passkey checks (WebAuthn level 2, the parts a relying party needs), using Node's own crypto.
 * Attestation is not requested: a passkey is trusted for being the same key that signed up,
 * not for its maker, so any attestation statement that comes anyway is ignored.
 */

/** COSE algorithm numbers: ES256 (P-256), EdDSA (Ed25519) and RS256, the ones passkeys use. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;

/** The site passkeys are tied to: its domain (the relying-party id) and the exact page origin. */
export interface RelyingParty {
  id: string;
  name: string;
  origin: string;
}

/** A passkey answer that fails a check. The message is for logs; players see a general refusal. */
export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

export interface NewCredential {
  /** Base64url credential id. */
  id: string;
  /** The public key as COSE bytes, as stored. */
  publicKey: Uint8Array;
  algorithm: number;
  signCount: number;
  transports: string[];
  /** The passkey is synced (iCloud Keychain, Google Password Manager), so it survives a lost phone. */
  backedUp: boolean;
}

export interface StoredCredential {
  publicKey: Uint8Array;
  algorithm: number;
  signCount: number;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const FLAG_EXTENSIONS = 0x80;
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

/** Checks a new passkey made for `challenge` and returns what to store. */
export function verifyRegistration(registration: PasskeyRegistration, challenge: string, rp: RelyingParty): NewCredential {
  checkClientData(registration.response.clientDataJSON, 'webauthn.create', challenge, rp);
  const attestation = decodeCborExact(bytesOf(registration.response.attestationObject, 'attestationObject'));
  if (!(attestation instanceof Map)) throw new PasskeyError('The attestation object is not a map');
  const fmt = attestation.get('fmt');
  const authDataBytes = attestation.get('authData');
  if (typeof fmt !== 'string' || !(authDataBytes instanceof Uint8Array)) throw new PasskeyError('The attestation object is incomplete');

  const authData = parseAuthenticatorData(authDataBytes);
  checkAuthenticatorData(authData, rp);
  if (!authData.credential) throw new PasskeyError('No credential in the authenticator data');
  const id = encodeBase64Url(authData.credential.id);
  if (id !== registration.id) throw new PasskeyError('The credential id does not match the authenticator data');

  const { algorithm } = publicKeyFromCose(authData.credential.publicKey);
  const transports = (registration.response.transports ?? []).filter((t) => typeof t === 'string' && TRANSPORTS.has(t));
  return {
    id,
    publicKey: authData.credential.publicKey,
    algorithm,
    signCount: authData.signCount,
    transports,
    backedUp: (authData.flags & FLAG_BACKED_UP) !== 0,
  };
}

/**
 * Checks a passkey's signature over `challenge`. Returns its new signature counter, which must
 * have gone up unless the passkey doesn't count (synced passkeys always send 0).
 */
export function verifyAssertion(
  assertion: PasskeyAssertion,
  challenge: string,
  rp: RelyingParty,
  credential: StoredCredential,
  userHandle: string,
): { signCount: number } {
  const clientDataBytes = checkClientData(assertion.response.clientDataJSON, 'webauthn.get', challenge, rp);
  const authDataBytes = bytesOf(assertion.response.authenticatorData, 'authenticatorData');
  const authData = parseAuthenticatorData(authDataBytes);
  checkAuthenticatorData(authData, rp);

  if (assertion.response.userHandle !== null && assertion.response.userHandle !== userHandle) {
    throw new PasskeyError('The passkey belongs to a different account');
  }
  const { key, algorithm } = publicKeyFromCose(credential.publicKey);
  if (algorithm !== credential.algorithm) throw new PasskeyError('The stored key and its algorithm disagree');
  const signed = Buffer.concat([authDataBytes, createHash('sha256').update(clientDataBytes).digest()]);
  if (!verifySignature(algorithm, key, signed, bytesOf(assertion.response.signature, 'signature'))) {
    throw new PasskeyError('The signature does not verify');
  }
  // A counter that stops going up can mean a copied passkey (WebAuthn level 2, 7.2 step 21).
  if ((authData.signCount > 0 || credential.signCount > 0) && authData.signCount <= credential.signCount) {
    throw new PasskeyError('The signature counter went backwards');
  }
  return { signCount: authData.signCount };
}

/** Checks the browser's part of the answer; returns its bytes, which the signature covers. */
function checkClientData(encoded: string, type: string, challenge: string, rp: RelyingParty): Uint8Array {
  const bytes = bytesOf(encoded, 'clientDataJSON');
  let clientData: unknown;
  try {
    clientData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new PasskeyError('clientDataJSON is not JSON');
  }
  if (typeof clientData !== 'object' || clientData === null) throw new PasskeyError('clientDataJSON is not an object');
  const data = clientData as Record<string, unknown>;
  if (data.type !== type) throw new PasskeyError(`Expected a ${type} answer`);
  if (data.challenge !== challenge) throw new PasskeyError('The challenge does not match');
  if (data.origin !== rp.origin) throw new PasskeyError(`The answer came from ${String(data.origin)}, not ${rp.origin}`);
  if (data.crossOrigin === true) throw new PasskeyError('The passkey was used from inside another site');
  return bytes;
}

interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credential: { id: Uint8Array; publicKey: Uint8Array } | null;
}

/** Splits authenticator data (WebAuthn level 2, 6.1) into its parts. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new PasskeyError('Authenticator data is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const signCount = view.getUint32(33);
  let offset = 37;
  let credential: AuthenticatorData['credential'] = null;
  try {
    if ((flags & FLAG_ATTESTED_CREDENTIAL) !== 0) {
      if (bytes.length < offset + 18) throw new PasskeyError('Attested credential data is too short');
      const idLength = view.getUint16(offset + 16);
      const idStart = offset + 18;
      if (idLength === 0 || idLength > 1023 || idStart + idLength > bytes.length) throw new PasskeyError('Bad credential id length');
      const id = bytes.slice(idStart, idStart + idLength);
      const { end } = decodeCbor(bytes, idStart + idLength);
      credential = { id, publicKey: bytes.slice(idStart + idLength, end) };
      offset = end;
    }
    if ((flags & FLAG_EXTENSIONS) !== 0) offset = decodeCbor(bytes, offset).end;
  } catch (err) {
    if (err instanceof PasskeyError) throw err;
    throw new PasskeyError(`Authenticator data does not parse: ${(err as Error).message}`);
  }
  if (offset !== bytes.length) throw new PasskeyError('Trailing bytes in the authenticator data');
  return { rpIdHash: bytes.slice(0, 32), flags, signCount, credential };
}

function checkAuthenticatorData(authData: AuthenticatorData, rp: RelyingParty): void {
  const expected = createHash('sha256').update(rp.id).digest();
  if (!expected.equals(authData.rpIdHash)) throw new PasskeyError('The passkey is for a different site');
  if ((authData.flags & FLAG_USER_PRESENT) === 0) throw new PasskeyError('The user was not present');
  if ((authData.flags & FLAG_USER_VERIFIED) === 0) throw new PasskeyError('The user was not verified (no fingerprint, face or PIN)');
}

/** Turns a COSE public key into a Node key, refusing anything but ES256, EdDSA and RS256 of safe sizes. */
export function publicKeyFromCose(cose: Uint8Array): { key: KeyObject; algorithm: number } {
  let map: CborValue;
  try {
    map = decodeCborExact(cose);
  } catch (err) {
    throw new PasskeyError(`The public key does not parse: ${(err as Error).message}`);
  }
  if (!(map instanceof Map)) throw new PasskeyError('The public key is not a COSE map');
  const kty = map.get(1);
  const algorithm = map.get(3);
  const b64 = (label: number, length?: number): string => {
    const value = map.get(label);
    if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) throw new PasskeyError('A public key field is missing or the wrong size');
    return encodeBase64Url(value);
  };
  try {
    if (algorithm === -7 && kty === 2 && map.get(-1) === 1) {
      return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(-2, 32), y: b64(-3, 32) }, format: 'jwk' }), algorithm };
    }
    if (algorithm === -8 && kty === 1 && map.get(-1) === 6) {
      return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64(-2, 32) }, format: 'jwk' }), algorithm };
    }
    if (algorithm === -257 && kty === 3) {
      // 2048 to 4096 bits: smaller is weak, and a huge key would make every sign-in slow to check.
      const modulus = map.get(-1);
      const exponent = map.get(-2);
      if (!(modulus instanceof Uint8Array) || modulus.length < 256 || modulus.length > 512) throw new PasskeyError('RSA keys must be 2048 to 4096 bits');
      if (!(exponent instanceof Uint8Array) || exponent.length > 8) throw new PasskeyError('The RSA exponent is too large');
      return { key: createPublicKey({ key: { kty: 'RSA', n: b64(-1), e: b64(-2) }, format: 'jwk' }), algorithm };
    }
  } catch (err) {
    if (err instanceof PasskeyError) throw err;
    throw new PasskeyError(`The public key is not valid: ${(err as Error).message}`);
  }
  throw new PasskeyError(`Unsupported public key (kty ${String(kty)}, alg ${String(algorithm)})`);
}

function verifySignature(algorithm: number, key: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (algorithm === -7) return verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    if (algorithm === -8) return verify(null, data, key, signature);
    return verify('sha256', data, key, signature);
  } catch {
    return false;
  }
}

function bytesOf(value: unknown, field: string): Uint8Array {
  const bytes = typeof value === 'string' && value.length <= 16_384 ? decodeBase64Url(value) : null;
  if (!bytes) throw new PasskeyError(`${field} is not base64url`);
  return bytes;
}
