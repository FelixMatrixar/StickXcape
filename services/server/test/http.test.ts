import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOM_CODE_PATTERN } from '@sticxcape/shared';
import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { testConfig } from './helpers.ts';

let app: FastifyInstance | undefined;

async function build(config: Config = testConfig()): Promise<FastifyInstance> {
  app = (await buildApp(config)).app;
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const createRoom = (a: FastifyInstance, body: unknown = { nickname: 'Ana' }, options: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  a.inject({ method: 'POST', url: '/rooms', payload: body as object, ...options });

describe('POST /rooms', () => {
  it('creates a room with an unguessable code and an invite link', async () => {
    const a = await build();
    const res = await createRoom(a);
    expect(res.statusCode).toBe(201);
    const { code, link } = res.json<{ code: string; link: string }>();
    expect(code).toMatch(ROOM_CODE_PATTERN);
    expect(link).toBe(`http://localhost:80/r/${code}`);
    expect((await createRoom(a)).json<{ code: string }>().code).not.toBe(code);
  });

  it('builds links from PUBLIC_URL, or from a trusted proxy', async () => {
    const fromPublicUrl = await build(testConfig({ PUBLIC_URL: 'https://play.example/ignored/path' }));
    expect((await createRoom(fromPublicUrl)).json<{ link: string }>().link).toMatch(/^https:\/\/play\.example\/r\//);
    await fromPublicUrl.close();

    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tunnel.example' };
    const behindProxy = await build(testConfig({ TRUST_PROXY: '1' }));
    expect((await createRoom(behindProxy, undefined, { headers })).json<{ link: string }>().link).toMatch(/^https:\/\/tunnel\.example\/r\//);
    await behindProxy.close();

    const untrusted = await build();
    expect((await createRoom(untrusted, undefined, { headers })).json<{ link: string }>().link).toMatch(/^http:\/\/localhost:80\/r\//);
  });

  it('wants a nickname of 1 to 16 characters', async () => {
    const a = await build();
    for (const body of [undefined, {}, { nickname: '   ' }, { nickname: 'x'.repeat(17) }, { nickname: 7 }]) {
      const res = await a.inject({ method: 'POST', url: '/rooms', ...(body ? { payload: body } : {}) });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'bad_nickname' });
    }
  });

  it('limits rooms per IP address and per server', async () => {
    const a = await build(testConfig({ ROOMS_PER_IP_PER_10_MIN: '2', MAX_ROOMS: '3' }));
    expect((await createRoom(a)).statusCode).toBe(201);
    expect((await createRoom(a)).statusCode).toBe(201);
    const tooMany = await createRoom(a);
    expect(tooMany.statusCode).toBe(429);
    expect(tooMany.json()).toMatchObject({ error: 'too_many_rooms' });

    expect((await createRoom(a, undefined, { remoteAddress: '10.0.0.2' })).statusCode).toBe(201);
    const full = await createRoom(a, undefined, { remoteAddress: '10.0.0.3' });
    expect(full.statusCode).toBe(429);
    expect(full.json<{ message: string }>().message).toMatch(/server is full/);
  });

  it('refuses oversized bodies', async () => {
    const a = await build();
    const res = await createRoom(a, { nickname: 'Ana', padding: 'x'.repeat(70 * 1024) });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /rooms/{code}', () => {
  it('finds a room by its code in any case', async () => {
    const a = await build();
    const { code } = (await createRoom(a)).json<{ code: string }>();
    const res = await a.inject({ url: `/rooms/${code.toUpperCase()}` });
    expect(res.statusCode).toBe(200);
    // The creator only becomes a player once their phone joins over the relay.
    expect(res.json()).toEqual({ exists: true, players: [], arena: null, inMatch: false });
  });

  it('answers 404 for unknown and malformed codes', async () => {
    const a = await build();
    for (const code of ['0000000000000000', 'nope', 'x'.repeat(40)]) {
      const res = await a.inject({ url: `/rooms/${code}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
    }
  });
});

describe('GET /version', () => {
  it('reports the lowest supported client and the server build', async () => {
    const a = await build(testConfig({ MIN_CLIENT_VERSION: '3', SERVER_VERSION: 'abc123' }));
    expect((await a.inject({ url: '/version' })).json()).toEqual({ minClientVersion: 3, serverVersion: 'abc123' });
  });
});

describe('web hosting', () => {
  async function webRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sticxcape-web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Game</title>');
    await writeFile(join(root, 'assets', 'app.1a2b3c.js'), 'console.log(1)');
    await writeFile(join(root, 'icon.png'), 'png');
    await writeFile(join(root, '.env'), 'SECRET=1');
    return root;
  }

  it('serves the test page by default, with security headers', async () => {
    const a = await build();
    const res = await a.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('<title>SticXcape</title>');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect((await a.inject({ url: '/version' })).headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers invite links and app routes with index.html, and caches hashed assets for good', async () => {
    const config = testConfig();
    config.webRoot = await webRoot();
    const a = await build(config);

    for (const url of ['/r/0123456789abcdef', '/r/0123456789abcdef?from=share', '/practice', '/']) {
      const res = await a.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe('<!doctype html><title>Game</title>');
      expect(res.headers['cache-control'], url).toBe('public, max-age=0');
    }
    const asset = await a.inject({ url: '/assets/app.1a2b3c.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await a.inject({ url: '/icon.png' })).headers['cache-control']).toBe('public, max-age=3600');

    for (const url of ['/missing.js', '/.env', '/assets/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
      const res = await a.inject({ url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('SECRET');
    }
  });

  it('serves the relay lab at /lab/ when it is built', async () => {
    const config = testConfig();
    config.labRoot = await mkdtemp(join(tmpdir(), 'sticxcape-lab-'));
    await writeFile(join(config.labRoot, 'index.html'), '<!doctype html><title>Lab</title>');
    await writeFile(join(config.labRoot, 'lab.js'), 'export {}');
    const a = await build(config);

    const redirect = await a.inject({ url: '/lab?room=abc' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/lab/?room=abc');
    expect((await a.inject({ url: '/lab/?room=abc' })).body).toContain('<title>Lab</title>');
    const script = await a.inject({ url: '/lab/lab.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect((await a.inject({ url: '/lab/nope.js' })).statusCode).toBe(404);
  });

  it('sends HSTS only in production over HTTPS', async () => {
    const config = testConfig({ TRUST_PROXY: '1' });
    config.env = 'production';
    const a = await build(config);
    expect((await a.inject({ url: '/healthz', headers: { 'x-forwarded-proto': 'https' } })).headers['strict-transport-security']).toBe('max-age=31536000');
    expect((await a.inject({ url: '/healthz' })).headers['strict-transport-security']).toBeUndefined();
  });
});
