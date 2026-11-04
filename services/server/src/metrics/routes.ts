import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EndReason } from '@sticxcape/shared';
import type { AiGateway } from '../ai/gateway.ts';
import type { Config } from '../config.ts';
import type { Relay } from '../relay/relay.ts';
import type { RoomStore } from '../rooms/room-store.ts';
import type { ErrorRateAlert } from './alerts.ts';
import { DASHBOARD_HTML } from './dashboard.ts';
import type { AiCall, AiOutcome, Metrics } from './metrics.ts';

export interface MonitoringDeps {
  config: Config;
  metrics: Metrics;
  rooms: RoomStore;
  relay: Relay;
  ai: AiGateway;
  alert: ErrorRateAlert;
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** /healthz for the host's checks; /metrics, /admin and /admin/stats.json behind ADMIN_TOKEN. */
export function registerMonitoringRoutes(app: FastifyInstance, deps: MonitoringDeps): void {
  const guard = adminGuard(deps.config);

  app.get('/healthz', async () => ({ ok: true, version: deps.config.serverVersion, rooms: deps.rooms.size, players: deps.relay.connectionCount }));

  app.get('/metrics', { preHandler: guard }, async (_request, reply) => reply.type(PROMETHEUS_CONTENT_TYPE).send(deps.metrics.registry.render()));

  app.get('/admin', { preHandler: guard }, async (_request, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(DASHBOARD_HTML),
  );

  app.get('/admin/stats.json', { preHandler: guard }, async (_request, reply) => reply.header('cache-control', 'no-store').send(statsSnapshot(deps)));
}

/** The numbers behind the dashboard: matches, desyncs, relay delay, AI response times and errors. */
export function statsSnapshot({ config, metrics, rooms, relay, ai, alert }: MonitoringDeps) {
  const ended = (reason: EndReason) => metrics.matchesEnded.get({ reason });
  const finished = ended('finished');
  const desyncs = ended('desync');
  const disconnects = ended('disconnect');
  const roomsClosed = ended('room_closed');
  const started = metrics.matchesStarted.sum();
  const { samples } = metrics;

  const aiCall = (call: AiCall) => {
    const get = (outcome: AiOutcome) => metrics.aiRequests.get({ call, outcome });
    const ok = get('ok');
    const cacheHits = get('cache_hit');
    const canned = get('canned');
    const rateLimited = get('rate_limited');
    return {
      ok,
      errors: metrics.aiRequests.sum({ call }) - ok - cacheHits - canned - rateLimited,
      cacheHits,
      canned,
      rateLimited,
      p50Ms: samples.aiMs[call].percentile(50),
      p95Ms: samples.aiMs[call].percentile(95),
    };
  };

  return {
    serverVersion: config.serverVersion,
    uptimeSeconds: Math.round(process.uptime()),
    rooms: { active: rooms.size, created: metrics.roomsCreated.get() },
    players: relay.connectionCount,
    matches: {
      active: relay.matchCount,
      started,
      rollback: metrics.matchesStarted.get({ netcode: 'rollback' }),
      finished,
      desyncs,
      disconnects,
      roomsClosed,
      finishRate: ratio(finished, started),
      desyncRate: ratio(desyncs, finished + desyncs + disconnects + roomsClosed),
    },
    relay: {
      rttMs: { p50: samples.rttMs.percentile(50), p95: samples.rttMs.percentile(95) },
      forwardMs: { p50: samples.forwardMs.percentile(50), p99: samples.forwardMs.percentile(99) },
      dropped: metrics.relayDropped.sum(),
    },
    ai: {
      mode: ai.mode,
      moveName: aiCall('move_name'),
      matchTips: aiCall('match_tips'),
      nameCheck: aiCall('name_check'),
      arenaCheck: aiCall('arena_check'),
      alert: { ...alert.stats(), threshold: config.monitoring.aiErrorRatio },
    },
  };
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/**
 * With ADMIN_TOKEN set, asks for HTTP Basic (user "admin") or a Bearer token. Without one the
 * pages are open in development and tests, and switched off in production.
 */
function adminGuard(config: Config) {
  const token = config.monitoring.adminToken;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!token) {
      if (config.env === 'production') return reply.code(404).send({ error: 'not_found', message: 'Set ADMIN_TOKEN to turn on monitoring pages' });
      return;
    }
    if (!matchesToken(request.headers.authorization, token)) {
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="SticXcape admin", charset="UTF-8"')
        .send({ error: 'unauthorized', message: 'Sign in as admin with ADMIN_TOKEN' });
    }
  };
}

function matchesToken(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const space = header.indexOf(' ');
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  let given = '';
  if (scheme === 'bearer') given = value;
  else if (scheme === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    given = decoded.slice(decoded.indexOf(':') + 1);
  }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
