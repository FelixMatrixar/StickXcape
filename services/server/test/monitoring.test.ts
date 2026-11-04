import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { alertNotifier, ErrorRateAlert, type AlertStats } from '../src/metrics/alerts.ts';
import { Registry } from '../src/metrics/registry.ts';
import { FakeClock, testConfig } from './helpers.ts';

let app: FastifyInstance | undefined;

async function build(config: Config = testConfig()): Promise<FastifyInstance> {
  app = (await buildApp(config)).app;
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('Registry', () => {
  it('renders the Prometheus text format', () => {
    const registry = new Registry();
    const plain = registry.counter('things_total', 'Things');
    const byReason = registry.counter<'reason'>('drops_total', 'Drops', ['reason']);
    registry.gauge('open_rooms', 'Rooms', () => 3);
    const latency = registry.histogram<'call'>('latency_seconds', 'Latency', [0.5, 0.1, 1], ['call']);

    expect(registry.render()).toContain('# TYPE things_total counter\nthings_total 0\n');
    plain.inc();
    byReason.inc({ reason: 'say "hi"\n' }, 2);
    latency.observe(0.05, { call: 'tips' });
    latency.observe(0.7, { call: 'tips' });
    latency.observe(3, { call: 'tips' });

    const text = registry.render();
    expect(text).toContain('# HELP things_total Things\n# TYPE things_total counter\nthings_total 1\n');
    expect(text).toContain('drops_total{reason="say \\"hi\\"\\n"} 2\n');
    expect(text).toContain('# TYPE open_rooms gauge\nopen_rooms 3\n');
    expect(text).toContain(
      [
        'latency_seconds_bucket{call="tips",le="0.1"} 1',
        'latency_seconds_bucket{call="tips",le="0.5"} 1',
        'latency_seconds_bucket{call="tips",le="1"} 2',
        'latency_seconds_bucket{call="tips",le="+Inf"} 3',
        'latency_seconds_sum{call="tips"} 3.75',
        'latency_seconds_count{call="tips"} 3',
      ].join('\n'),
    );
    expect(byReason.sum()).toBe(2);
    expect(byReason.get({ reason: 'other' })).toBe(0);
  });
});

describe('ErrorRateAlert', () => {
  function alert(clock: FakeClock) {
    const changes: [boolean, AlertStats][] = [];
    const a = new ErrorRateAlert({ ratio: 0.05, windowMs: 15 * 60_000, minCalls: 20, now: clock.now, onChange: (firing, stats) => changes.push([firing, stats]) });
    return { a, changes };
  }

  it('fires when AI errors pass 5%, once, and resolves when they drop', () => {
    const clock = new FakeClock();
    const { a, changes } = alert(clock);
    for (let i = 0; i < 18; i++) a.record(true);
    a.record(false);
    a.check();
    expect(changes).toEqual([]); // 19 calls: too few to judge

    a.record(false);
    a.check();
    a.check();
    expect(changes).toEqual([[true, { calls: 20, errors: 2, ratio: 0.1, firing: true }]]);

    for (let i = 0; i < 30; i++) a.record(true);
    a.check();
    expect(changes).toHaveLength(2);
    expect(changes[1]![0]).toBe(false);
    expect(a.stats()).toMatchObject({ calls: 50, errors: 2, firing: false });
  });

  it('forgets calls older than the window', () => {
    const clock = new FakeClock();
    const { a } = alert(clock);
    for (let i = 0; i < 25; i++) a.record(false);
    clock.advance(16 * 60_000);
    a.record(true);
    expect(a.stats()).toEqual({ calls: 1, errors: 0, ratio: 0, firing: false });
  });

  it('posts alerts to a Slack or Discord webhook', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
    const notify = alertNotifier('https://hooks.example/alert', 15 * 60_000, fetch, log);
    notify(true, { calls: 40, errors: 4, ratio: 0.1, firing: true });
    expect(log.error).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://hooks.example/alert');
    const body = JSON.parse(String(init!.body)) as { text: string; content: string };
    expect(body.text).toBe('SticXcape alert: 10.0% of AI calls failed in the last 15 minutes (4 of 40). Move names and tips are falling back.');
    expect(body.content).toBe(body.text);

    alertNotifier(null, 15 * 60_000, fetch, log)(false, { calls: 40, errors: 1, ratio: 0.025, firing: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
  });
});

describe('monitoring routes', () => {
  it('answers health checks', async () => {
    const a = await build();
    expect((await a.inject({ url: '/healthz' })).json()).toEqual({ ok: true, version: 'dev', rooms: 0, players: 0 });
  });

  it('serves metrics, the dashboard and its stats', async () => {
    const a = await build();
    await a.inject({ method: 'POST', url: '/rooms', payload: { nickname: 'Ana' } });

    const metrics = await a.inject({ url: '/metrics' });
    expect(metrics.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(metrics.body).toContain('sticxcape_rooms_created_total 1\n');
    expect(metrics.body).toContain('sticxcape_rooms_active 1\n');
    expect(metrics.body).toContain('# TYPE sticxcape_relay_rtt_seconds histogram');

    const dashboard = await a.inject({ url: '/admin' });
    expect(dashboard.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(dashboard.headers['cache-control']).toBe('no-store');

    expect((await a.inject({ url: '/admin/stats.json' })).json()).toMatchObject({
      serverVersion: 'dev',
      rooms: { active: 1, created: 1 },
      players: 0,
      matches: { started: 0, finishRate: null, desyncRate: null },
      relay: { rttMs: { p50: null }, dropped: 0 },
      ai: { mode: 'canned', moveName: { ok: 0, errors: 0 }, alert: { firing: false, threshold: 0.05 } },
    });
  });

  it('asks for ADMIN_TOKEN when one is set', async () => {
    const a = await build(testConfig({ ADMIN_TOKEN: 's3cret' }));
    const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

    const refused = await a.inject({ url: '/metrics' });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe('Basic realm="SticXcape admin", charset="UTF-8"');
    for (const authorization of [basic('admin', 'wrong'), 'Bearer s3cre', 'Bearer s3cret2', 's3cret', basic('admin', '')]) {
      expect((await a.inject({ url: '/admin/stats.json', headers: { authorization } })).statusCode, authorization).toBe(401);
    }
    for (const authorization of [basic('admin', 's3cret'), 'Bearer s3cret', 'bearer s3cret']) {
      expect((await a.inject({ url: '/admin', headers: { authorization } })).statusCode, authorization).toBe(200);
    }
    expect((await a.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('switches the pages off in production without a token', async () => {
    const config = testConfig();
    config.env = 'production';
    const a = await build(config);
    for (const url of ['/metrics', '/admin', '/admin/stats.json']) expect((await a.inject({ url })).statusCode, url).toBe(404);
  });
});
