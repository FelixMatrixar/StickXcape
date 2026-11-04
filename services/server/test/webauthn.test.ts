import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeBase64Url } from '@sticxcape/shared';
import { CborError, decodeCbor, decodeCborExact } from '../src/accounts/cbor.ts';
import { PasskeyError, parseAuthenticatorData, publicKeyFromCose, verifyAssertion, type RelyingParty } from '../src/accounts/webauthn.ts';
import { encodeCbor, SoftwarePasskeys, type Cbor } from './passkeys.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('CBOR', () => {
  it('reads every kind of item passkeys use', () => {
    const cases: [Cbor, number[]][] = [
      [0, [0x00]],
      [23, [0x17]],
      [24, [0x18, 24]],
      [65535, [0x19, 0xff, 0xff]],
      [4294967295, [0x1a, 0xff, 0xff, 0xff, 0xff]],
      [-1, [0x20]],
      [-257, [0x39, 0x01, 0x00]],
      ['fmt', [0x63, 0x66, 0x6d, 0x74]],
      [bytes(1, 2), [0x42, 1, 2]],
      [[1, [2]], [0x82, 0x01, 0x81, 0x02]],
      [true, [0xf5]],
      [null, [0xf6]],
    ];
    for (const [value, encoded] of cases) {
      expect(decodeCborExact(new Uint8Array(encoded))).toEqual(value);
      expect([...encodeCbor(value)]).toEqual(encoded);
    }
    expect(decodeCborExact(bytes(0x1b, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(2 ** 32);
    const map = decodeCborExact(encodeCbor(new Map<Cbor, Cbor>([[1, 2], [-2, bytes(9)], ['fmt', 'none']])));
    expect(map).toEqual(new Map<unknown, unknown>([[1, 2], [-2, bytes(9)], ['fmt', 'none']]));
    // decodeCbor stops after one item, for items packed one after another.
    expect(decodeCbor(bytes(0x01, 0x02), 0)).toEqual({ value: 1, end: 1 });
  });

  it('refuses what passkeys never send, and anything cut short', () => {
    const refused = [
      [],
      [0x18], // a one-byte number with no byte
      [0x42, 1], // a two-byte string with one byte
      [0x5f, 0x41, 1, 0xff], // indefinite length
      [0xc0, 0x00], // a tag
      [0xf9, 0x3c, 0x00], // a half float
      [0x9a, 0xff, 0xff, 0xff, 0xff], // an array longer than the input
      [0xa2, 0x01, 0x01, 0x01, 0x02], // a duplicate map key
      [0xa1, 0x42, 1, 2, 0x01], // a map key that is a byte string
      [0x62, 0xff, 0xfe], // text that is not UTF-8
      [0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], // past JavaScript's safe integers
      [0x01, 0x02], // trailing bytes
    ];
    for (const encoded of refused) expect(() => decodeCborExact(new Uint8Array(encoded)), JSON.stringify(encoded)).toThrow(CborError);
    const deep = new Uint8Array([...Array(20).fill(0x81), 0x00]);
    expect(() => decodeCborExact(deep)).toThrow(/nested/);
  });
});

describe('passkey keys and data', () => {
  it('reads P-256, Ed25519 and RSA keys, and refuses others', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const x = decodeBase64Url(ec.x!)!;
    const y = decodeBase64Url(ec.y!)!;
    expect(publicKeyFromCose(encodeCbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]))).algorithm).toBe(-7);

    const refused: Map<Cbor, Cbor>[] = [
      new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 2], [-2, x], [-3, y]]), // P-384 curve id
      new Map<Cbor, Cbor>([[1, 2], [3, -35], [-1, 1], [-2, x], [-3, y]]), // ES384
      new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, x.slice(1)], [-3, y]]), // short coordinate
      new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, x]]), // not a point on the curve
      new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, new Uint8Array(128).fill(0xff)], [-2, bytes(1, 0, 1)]]), // 1024-bit RSA
      new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, new Uint8Array(1024).fill(0xff)], [-2, bytes(1, 0, 1)]]), // 8192-bit RSA: too slow to check
    ];
    for (const cose of refused) expect(() => publicKeyFromCose(encodeCbor(cose))).toThrow(PasskeyError);
    expect(() => publicKeyFromCose(bytes(0x01))).toThrow(PasskeyError);
  });

  it('splits authenticator data, refusing bad lengths and trailing bytes', () => {
    const rpIdHash = createHash('sha256').update('localhost').digest();
    const plain = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 7]);
    expect(parseAuthenticatorData(plain)).toMatchObject({ flags: 0x05, signCount: 7, credential: null });
    expect(() => parseAuthenticatorData(plain.slice(0, 36))).toThrow(/too short/);
    expect(() => parseAuthenticatorData(new Uint8Array([...plain, 0]))).toThrow(/Trailing/);
    // Attested credential data that claims a longer id than it has.
    const attested = new Uint8Array([...rpIdHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0x00, 0x40, 1, 2, 3]);
    expect(() => parseAuthenticatorData(attested)).toThrow(PasskeyError);
  });

  it('checks a signature only against the key the passkey signed up with', () => {
    const rp: RelyingParty = { id: 'localhost', name: 'SticXcape', origin: 'http://localhost:8080' };
    const passkeys = new SoftwarePasskeys(rp.origin);
    passkeys.register({
      challenge: 'c2lnbi11cA',
      rp: { id: rp.id, name: rp.name },
      user: { id: 'dXNlcg', name: 'Ana', displayName: 'Ana' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 1000,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: [],
    });
    const passkey = passkeys.saved[0]!;
    const answer = passkeys.answer(passkey, 'c2lnbi1pbg', {});
    expect(verifyAssertion(answer, 'c2lnbi1pbg', rp, { publicKey: passkey.publicKey, algorithm: -7, signCount: 0 }, 'dXNlcg')).toEqual({ signCount: 0 });

    // The same answer against another key, or with the algorithm mislabelled, fails.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    const otherCose = encodeCbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, decodeBase64Url(other.x!)!], [-3, decodeBase64Url(other.y!)!]]));
    expect(() => verifyAssertion(answer, 'c2lnbi1pbg', rp, { publicKey: otherCose, algorithm: -7, signCount: 0 }, 'dXNlcg')).toThrow(/signature/);
    expect(() => verifyAssertion(answer, 'c2lnbi1pbg', rp, { publicKey: passkey.publicKey, algorithm: -8, signCount: 0 }, 'dXNlcg')).toThrow(/algorithm/);
    // A signature that isn't DER at all.
    const garbled = { ...answer, response: { ...answer.response, signature: 'AAAA' } };
    expect(() => verifyAssertion(garbled, 'c2lnbi1pbg', rp, { publicKey: passkey.publicKey, algorithm: -7, signCount: 0 }, 'dXNlcg')).toThrow(/signature/);
  });
});
