import { describe, expect, it, vi } from 'vitest';
import type { PasskeyCreationOptions, PasskeyRequestOptions } from '@sticxcape/shared';
import { AccountClient, browserPasskeys, passkeysSupported } from '../src/account.ts';

const buffer = (...values: number[]) => new Uint8Array(values).buffer;

const CREATE: PasskeyCreationOptions = {
  challenge: 'AQID',
  rp: { id: 'play.example', name: 'SticXcape' },
  user: { id: 'BAUG', name: 'Ana', displayName: 'Ana' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 120_000,
  attestation: 'none',
  authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  excludeCredentials: [{ type: 'public-key', id: '__8' }],
};

const GET: PasskeyRequestOptions = { challenge: 'BwgJ', rpId: 'play.example', timeout: 120_000, userVerification: 'required', allowCredentials: [] };

describe('browser passkeys', () => {
  it('turn the JSON options into WebAuthn bytes, and the new passkey back into JSON', async () => {
    const create = vi.fn(async () => ({
      id: 'cred-1',
      response: { clientDataJSON: buffer(1, 2, 3), attestationObject: buffer(0xfb, 0xff), getTransports: () => ['internal', 'hybrid'] },
    }));
    const passkeys = browserPasskeys({ create, get: vi.fn() } as unknown as CredentialsContainer);
    const registration = await passkeys.create(CREATE);

    const { publicKey } = (create.mock.calls[0] as unknown as [CredentialCreationOptions])[0];
    expect(publicKey!.challenge).toEqual(new Uint8Array([1, 2, 3]));
    expect(publicKey!.user.id).toEqual(new Uint8Array([4, 5, 6]));
    expect(publicKey!.excludeCredentials![0]!.id).toEqual(new Uint8Array([0xff, 0xff]));
    expect(publicKey).toMatchObject({ rp: CREATE.rp, attestation: 'none', authenticatorSelection: CREATE.authenticatorSelection });
    expect(registration).toEqual({ id: 'cred-1', type: 'public-key', response: { clientDataJSON: 'AQID', attestationObject: '-_8', transports: ['internal', 'hybrid'] } });
  });

  it('send a signature back as JSON, with or without a user handle', async () => {
    const answer = (userHandle: ArrayBuffer | null) => ({
      id: 'cred-1',
      response: { clientDataJSON: buffer(1), authenticatorData: buffer(2), signature: buffer(3), userHandle },
    });
    const get = vi.fn().mockResolvedValueOnce(answer(buffer(9, 9))).mockResolvedValueOnce(answer(null));
    const passkeys = browserPasskeys({ create: vi.fn(), get } as unknown as CredentialsContainer);

    expect(await passkeys.get(GET)).toEqual({ id: 'cred-1', type: 'public-key', response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: 'CQk' } });
    expect((await passkeys.get(GET)).response.userHandle).toBeNull();
    const { publicKey } = (get.mock.calls[0] as unknown as [CredentialRequestOptions])[0];
    expect(publicKey).toMatchObject({ challenge: new Uint8Array([7, 8, 9]), rpId: 'play.example', userVerification: 'required', allowCredentials: [] });
  });

  it('say so when there is nothing to use', async () => {
    expect(passkeysSupported()).toBe(false); // Node is not a browser
    await expect(browserPasskeys(undefined).create(CREATE)).rejects.toThrow(/not available/);
    const cancelled = browserPasskeys({ create: vi.fn(async () => null), get: vi.fn(async () => null) } as unknown as CredentialsContainer);
    await expect(cancelled.create(CREATE)).rejects.toThrow(/No passkey/);
    await expect(cancelled.get(GET)).rejects.toThrow(/No passkey/);
  });
});

describe('AccountClient', () => {
  it('calls the account routes on the page origin, and passes errors on', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith('/library')) return new Response(JSON.stringify({ error: 'not_signed_in', message: 'Sign in' }), { status: 401 });
      return new Response(null, { status: 204 });
    });
    const client = new AccountClient({ baseUrl: 'https://play.example/', fetch: fetch as unknown as typeof globalThis.fetch, passkeys: { create: vi.fn(), get: vi.fn() } });
    await client.signOut();
    await client.deleteMove('7a1c0de0-0000-4000-8000-000000000001');
    await expect(client.getLibrary()).rejects.toMatchObject({ status: 401, error: 'not_signed_in' });
    expect(calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'POST https://play.example/account/logout',
      'DELETE https://play.example/account/library/moves/7a1c0de0-0000-4000-8000-000000000001',
      'GET https://play.example/account/library',
    ]);
    // No body, no content type: the server refuses an empty JSON body.
    expect(calls[0]![1]!.headers).toBeUndefined();
  });
});
