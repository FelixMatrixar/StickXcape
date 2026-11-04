import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountClient, ApiRequestError, toyLoadout } from '@sticxcape/netcode';
import {
  withHash,
  type CloudMoveInput,
  type MoveFile,
  type PasskeyAssertion,
  type PasskeyCeremony,
  type PasskeyCreationOptions,
  type PasskeyRegistration,
  type PasskeyRequestOptions,
} from '@sticxcape/shared';
import { FakeClock, startServer, testConfig, type TestServer } from './helpers.ts';
import { cookieFetch, SoftwarePasskeys, type AnswerChanges, type PasskeyAlgorithm } from './passkeys.ts';

const servers: TestServer[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** A server with accounts in memory. Its origin uses localhost: passkeys refuse IP addresses. */
async function serveAccounts(env: Record<string, string> = {}, now?: () => number) {
  const server = await startServer(testConfig({ DATABASE_FILE: ':memory:', LOG_LEVEL: 'silent', ...env }), now ? { now } : {});
  servers.push(server);
  return { server, origin: server.baseUrl.replace('127.0.0.1', 'localhost') };
}

/** One browser: its own cookies, and a passkey authenticator (which may be shared, like a synced passkey). */
function browser(origin: string, passkeys = new SoftwarePasskeys(origin)) {
  const fetch = cookieFetch();
  return { client: new AccountClient({ baseUrl: origin, fetch, passkeys }), fetch, passkeys };
}

function post(fetch: typeof globalThis.fetch, url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

const toyMove = toyLoadout()[0]!;

function cloud(move: MoveFile, kind: 'move' | 'idle' = 'move'): CloudMoveInput {
  return { move, kind, description: 'A quick jab', quality: 0.8, createdAt: 1_790_000_000_000 };
}

describe('passkey accounts', () => {
  it('makes an account with a passkey, signs out, and signs back in with it', async () => {
    const { server, origin } = await serveAccounts();
    const { client, fetch } = browser(origin);
    expect(await client.status()).toEqual({ account: null, passkeys: true });

    const account = await client.createAccount('  Ana ');
    expect(account).toMatchObject({ name: 'Ana' });
    // 180 days, never readable by scripts, and not sent along with requests from other sites.
    expect(fetch.lastSetCookie).toMatch(/^sx_session=[\w-]{43}; Path=\/; Max-Age=15552000; HttpOnly; SameSite=Lax$/);
    expect((await client.status()).account).toEqual(account);

    await client.signOut();
    expect(fetch.cookies.size).toBe(0);
    expect((await client.status()).account).toBeNull();
    expect(await client.signIn()).toEqual(account);
    expect((await client.status()).account).toEqual(account);

    const { metrics, accounts } = server.services;
    expect(metrics.accountsCreated.get()).toBe(1);
    expect(metrics.passkeyChecks.get({ ceremony: 'register', outcome: 'ok' })).toBe(1);
    expect(metrics.passkeyChecks.get({ ceremony: 'login', outcome: 'ok' })).toBe(1);
    expect(accounts!.accountCount).toBe(1);
  });

  it('signs in on a second device the passkey synced to, each with its own sign-in', async () => {
    const { origin } = await serveAccounts();
    const phone = browser(origin);
    const account = await phone.client.createAccount('Ana');
    const tablet = browser(origin, phone.passkeys);
    expect(await tablet.client.signIn()).toEqual(account);
    await tablet.client.signOut();
    expect((await phone.client.status()).account).toEqual(account);
  });

  it.each([
    ['ES256', -7],
    ['EdDSA', -8],
    ['RS256', -257],
  ] as [string, PasskeyAlgorithm][])('accepts %s passkeys', async (_name, algorithm) => {
    const { origin } = await serveAccounts();
    const { client } = browser(origin, new SoftwarePasskeys(origin, { algorithm }));
    const account = await client.createAccount('Ana');
    await client.signOut();
    expect(await client.signIn()).toEqual(account);
  });

  it('refuses sign-ins whose passkey answer does not check out', async () => {
    const { server, origin } = await serveAccounts();
    const { client, fetch, passkeys } = browser(origin, new SoftwarePasskeys(origin, { counting: true }));
    await client.createAccount('Ana');
    await client.signOut();
    await client.signIn();
    await client.signOut();
    const passkey = passkeys.saved[0]!;

    const attempt = async (answer: (options: PasskeyRequestOptions) => PasskeyAssertion, ceremony?: string) => {
      const started = (await (await post(fetch, `${origin}/account/passkey/login/options`, {})).json()) as PasskeyCeremony<PasskeyRequestOptions>;
      const response = await post(fetch, `${origin}/account/passkey/login`, { ceremony: ceremony ?? started.ceremony, credential: answer(started.options) });
      return { status: response.status, error: ((await response.json()) as { error: string }).error, ceremony: started.ceremony };
    };
    const signed = (changes: AnswerChanges) => (options: PasskeyRequestOptions) => passkeys.answer(passkey, options.challenge, changes);

    expect(await attempt((o) => passkeys.answer(passkey, `${o.challenge}x`, {}))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    expect(await attempt(signed({ origin: 'https://evil.example' }))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    expect(await attempt(signed({ rpId: 'evil.example' }))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    expect(await attempt(signed({ type: 'webauthn.create' }))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    expect(await attempt(signed({ flags: 0x01 }))).toMatchObject({ status: 401, error: 'passkey_rejected' }); // no fingerprint, face or PIN
    expect(await attempt(signed({ breakSignature: true }))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    expect(await attempt(signed({ userHandle: 'c29tZW9uZSBlbHNl' }))).toMatchObject({ status: 401, error: 'passkey_rejected' });

    // A copied passkey: its counter is behind the one the server has seen.
    passkey.signCount = 0;
    expect(await attempt(signed({}))).toMatchObject({ status: 401, error: 'passkey_rejected' });
    passkey.signCount = 50;

    // A passkey this server never registered.
    const stranger = new SoftwarePasskeys(origin);
    const options = (await (await post(fetch, `${origin}/account/passkey/register/options`, { name: 'Bo' })).json()) as PasskeyCeremony<PasskeyCreationOptions>;
    stranger.register(options.options);
    expect(await attempt((o) => stranger.answer(stranger.saved[0]!, o.challenge, {}))).toMatchObject({ status: 401, error: 'unknown_passkey' });

    // Each ceremony works once, even after a good answer.
    const good = await attempt(signed({}));
    expect(good.status).toBe(200);
    expect(await attempt(signed({}), good.ceremony)).toMatchObject({ status: 400, error: 'ceremony_expired' });

    expect(server.services.metrics.passkeyChecks.get({ ceremony: 'login', outcome: 'rejected' })).toBe(9);
  });

  it('refuses sign-ups whose passkey answer does not check out', async () => {
    const { server, origin } = await serveAccounts();
    const fetch = cookieFetch();
    const passkeys = new SoftwarePasskeys(origin);
    const attempt = async (changes: AnswerChanges, edit: (r: PasskeyRegistration) => PasskeyRegistration = (r) => r) => {
      const { ceremony, options } = (await (await post(fetch, `${origin}/account/passkey/register/options`, { name: 'Ana' })).json()) as PasskeyCeremony<PasskeyCreationOptions>;
      const response = await post(fetch, `${origin}/account/passkey/register`, { ceremony, credential: edit(passkeys.register(options, changes)) });
      return { status: response.status, error: ((await response.json()) as { error?: string }).error };
    };

    expect(await attempt({ origin: 'https://evil.example' })).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({ rpId: 'evil.example' })).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({ flags: 0x41 })).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({}, (r) => ({ ...r, id: 'AAAAAAAAAAAAAAAAAAAAAA' }))).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({}, (r) => ({ ...r, response: { ...r.response, attestationObject: 'oA' } }))).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({}, (r) => ({ ...r, response: { ...r.response, clientDataJSON: '!!' } }))).toMatchObject({ status: 400, error: 'passkey_rejected' });
    expect(await attempt({}, () => ({ id: 1 }) as unknown as PasskeyRegistration)).toMatchObject({ status: 400, error: 'bad_request' });
    expect(fetch.cookies.size).toBe(0);
    expect(server.services.accounts!.accountCount).toBe(0);
    expect(await attempt({})).toMatchObject({ status: 201 });
  });

  it('checks names, and limits passkey attempts per network', async () => {
    const { origin } = await serveAccounts({ PASSKEYS_PER_IP_PER_10_MIN: '2' });
    const { client } = browser(origin);
    await expect(client.createAccount(' ')).rejects.toMatchObject({ status: 400, error: 'bad_name' });
    await expect(client.createAccount('a'.repeat(17))).rejects.toMatchObject({ status: 400, error: 'bad_name' });
    await client.createAccount('Ana');
    await client.signOut();
    await client.signIn();
    await expect(client.signIn()).rejects.toMatchObject({ status: 429, error: 'too_many_attempts' });
  });

  it('refuses account changes sent from other sites', async () => {
    const { origin } = await serveAccounts();
    const fetch = cookieFetch();
    const response = await post(fetch, `${origin}/account/passkey/register/options`, { name: 'Ana' }, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'wrong_origin' });
    expect((await post(fetch, `${origin}/account/passkey/register/options`, { name: 'Ana' }, { origin })).status).toBe(200);
  });

  it('marks the sign-in cookie Secure over HTTPS', async () => {
    const { server } = await serveAccounts({ TRUST_PROXY: '1' });
    const reply = await server.app.inject({ method: 'POST', url: '/account/logout', headers: { 'x-forwarded-proto': 'https', host: 'play.localhost' } });
    expect(reply.headers['set-cookie']).toBe('sx_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  });

  it('says when passkeys cannot work here, and why', async () => {
    // Accounts off: no database.
    const off = await startServer(testConfig());
    servers.push(off);
    expect(await (await fetch(`${off.baseUrl}/account`)).json()).toEqual({ account: null, passkeys: false });
    expect((await post(fetch, `${off.baseUrl}/account/passkey/login/options`, {})).status).toBe(503);
    expect(await (await fetch(`${off.baseUrl}/account/library`)).json()).toMatchObject({ error: 'accounts_off' });

    // An IP address can't hold passkeys, and plain http only works on localhost.
    const { server } = await serveAccounts();
    expect(await (await fetch(`${server.baseUrl}/account`)).json()).toEqual({ account: null, passkeys: false });
    expect(await (await post(fetch, `${server.baseUrl}/account/passkey/login/options`, {})).json()).toMatchObject({ error: 'passkeys_unavailable' });

    // In production the site is PUBLIC_URL, whatever address the request used.
    const { origin } = await serveAccounts({ NODE_ENV: 'production', PUBLIC_URL: 'https://play.example' });
    const started = (await (await post(fetch, `${origin}/account/passkey/register/options`, { name: 'Ana' })).json()) as PasskeyCeremony<PasskeyCreationOptions>;
    expect(started.options.rp).toEqual({ id: 'play.example', name: 'SticXcape' });
    const { origin: bare } = await serveAccounts({ NODE_ENV: 'production' });
    expect(await (await fetch(`${bare}/account`)).json()).toEqual({ account: null, passkeys: false });
  });

  it('deletes an account with its passkeys, sign-ins and library', async () => {
    const { server, origin } = await serveAccounts();
    const phone = browser(origin);
    await phone.client.createAccount('Ana');
    await phone.client.saveMove(cloud(toyMove));
    const tablet = browser(origin, phone.passkeys);
    await tablet.client.signIn();

    await phone.client.deleteAccount();
    expect((await phone.client.status()).account).toBeNull();
    expect((await tablet.client.status()).account).toBeNull();
    await expect(phone.client.signIn()).rejects.toMatchObject({ status: 401, error: 'unknown_passkey' });
    expect(server.services.accounts!.accountCount).toBe(0);
  });

  it('keeps accounts and libraries across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sticxcape-accounts-'));
    try {
      const env = { DATABASE_FILE: join(dir, 'accounts.db') };
      const first = await serveAccounts(env);
      const { client, passkeys } = browser(first.origin);
      const account = await client.createAccount('Ana');
      await client.saveMove(cloud(toyMove));
      await first.server.close();

      const second = await serveAccounts(env);
      passkeys.origin = second.origin;
      const again = browser(second.origin, passkeys);
      expect(await again.client.signIn()).toEqual(account);
      expect((await again.client.getLibrary()).moves.map((m) => m.move.id)).toEqual([toyMove.id]);
      await second.server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a used sign-in going, and ends one left unused for 180 days', async () => {
    const clock = new FakeClock();
    const { origin } = await serveAccounts({}, clock.now);
    const { client, fetch } = browser(origin);
    const account = await client.createAccount('Ana');

    clock.advance(100 * DAY_MS);
    fetch.lastSetCookie = null;
    expect((await client.status()).account).toEqual(account);
    expect(fetch.lastSetCookie).toMatch(/Max-Age=15552000/);

    // Each use renews it for 180 days: used on day 100, it lasts to day 280; used on day 279, to day 459.
    clock.advance(179 * DAY_MS);
    expect((await client.status()).account).toEqual(account);
    clock.advance(181 * DAY_MS);
    expect((await client.status()).account).toBeNull();
  });
});

describe('the cloud move library', () => {
  it('keeps moves, idle stances and the loadout, and replaces a move saved again', async () => {
    const { origin } = await serveAccounts();
    const { client } = browser(origin);
    await client.createAccount('Ana');
    expect(await client.getLibrary()).toEqual({ moves: [], loadout: {} });

    const idle = await withHash({ ...toyMove, id: '7a1c0de0-0000-4000-8000-000000000002', name: 'Ready Stance' });
    const savedAt = await client.saveMove(cloud(toyMove));
    await client.saveMove({ ...cloud(idle, 'idle'), description: null, quality: null });
    await client.saveLoadout({ light1: toyMove.id, special: idle.id });

    const library = await client.getLibrary();
    expect(library.moves).toEqual([
      { ...cloud(toyMove), updatedAt: savedAt },
      { move: idle, kind: 'idle', description: null, quality: null, createdAt: 1_790_000_000_000, updatedAt: expect.any(Number) },
    ]);
    expect(library.loadout).toEqual({ light1: toyMove.id, special: idle.id });

    const renamed = await withHash({ ...toyMove, name: 'Toy Jab Two' });
    await client.saveMove(cloud(renamed));
    expect((await client.getLibrary()).moves.find((m) => m.move.id === toyMove.id)!.move.name).toBe('Toy Jab Two');

    await client.deleteMove(idle.id);
    expect((await client.getLibrary()).moves.map((m) => m.move.id)).toEqual([toyMove.id]);
    await expect(client.deleteMove(idle.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses tampered or malformed moves and loadouts, and caps the library', async () => {
    const { origin } = await serveAccounts({ LIBRARY_MAX_MOVES: '1' });
    const { client, fetch } = browser(origin);
    await client.createAccount('Ana');

    const refused = (input: unknown, id = toyMove.id) =>
      fetch(`${origin}/account/library/moves/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(async (r) => [
        r.status,
        ((await r.json()) as { error: string }).error,
      ]);
    expect(await refused(cloud({ ...toyMove, name: 'Changed' }))).toEqual([400, 'bad_move']); // hash no longer matches
    expect(await refused(cloud(toyMove), '7a1c0de0-0000-4000-8000-000000000009')).toEqual([400, 'bad_move']);
    expect(await refused({ ...cloud(toyMove), description: 'x'.repeat(201) })).toEqual([400, 'bad_move']);
    expect(await refused({ ...cloud(toyMove), quality: 2 })).toEqual([400, 'bad_move']);
    expect(await refused({ ...cloud(toyMove), kind: 'taunt' })).toEqual([400, 'bad_move']);

    await client.saveMove(cloud(toyMove));
    const second = await withHash({ ...toyMove, id: '7a1c0de0-0000-4000-8000-000000000003' });
    await expect(client.saveMove(cloud(second))).rejects.toMatchObject({ status: 409, error: 'library_full' });
    // Saving a move that is already there replaces it, full or not.
    await client.saveMove(cloud(toyMove));

    await expect(client.saveLoadout({ 'Light 1': toyMove.id })).rejects.toMatchObject({ status: 400, error: 'bad_loadout' });
    await expect(client.saveLoadout({ light1: 'not-a-move-id' })).rejects.toMatchObject({ status: 400, error: 'bad_loadout' });
  });

  it('is only there for a signed-in account', async () => {
    const { origin } = await serveAccounts();
    const { client } = browser(origin);
    await expect(client.getLibrary()).rejects.toMatchObject({ status: 401, error: 'not_signed_in' });
    await expect(client.saveMove(cloud(toyMove))).rejects.toBeInstanceOf(ApiRequestError);
    await expect(client.deleteAccount()).rejects.toMatchObject({ status: 401 });
  });

  it('keeps each account to its own library', async () => {
    const { origin } = await serveAccounts();
    const ana = browser(origin);
    const bo = browser(origin);
    await ana.client.createAccount('Ana');
    await bo.client.createAccount('Bo');
    await ana.client.saveMove(cloud(toyMove));
    expect((await bo.client.getLibrary()).moves).toEqual([]);
    await expect(bo.client.deleteMove(toyMove.id)).rejects.toMatchObject({ status: 404 });
    expect((await ana.client.getLibrary()).moves).toHaveLength(1);
  });
});
