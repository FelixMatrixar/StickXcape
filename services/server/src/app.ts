import { readFileSync } from 'node:fs';
import type { Server as HttpsServer } from 'node:https';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyHttpsOptions, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { registerAccountRoutes } from './accounts/routes.ts';
import { AccountStore } from './accounts/store.ts';
import { AiGateway } from './ai/gateway.ts';
import { registerAiRoutes } from './ai/routes.ts';
import type { Config } from './config.ts';
import { alertNotifier, ErrorRateAlert } from './metrics/alerts.ts';
import { createMetrics, type Metrics } from './metrics/metrics.ts';
import { registerMonitoringRoutes } from './metrics/routes.ts';
import { Relay } from './relay/relay.ts';
import { registerRelayRoutes } from './relay/routes.ts';
import { RoomStore } from './rooms/room-store.ts';
import { registerRoomRoutes } from './rooms/routes.ts';
import { addSecurityHeaders, registerWeb } from './web/routes.ts';

export interface AppDeps {
  /** Used for Meta's API and the alert webhook; tests pass a fake. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Services {
  rooms: RoomStore;
  relay: Relay;
  ai: AiGateway;
  /** Accounts and cloud move libraries; null when accounts are off (no DATABASE_FILE). */
  accounts: AccountStore | null;
  metrics: Metrics;
  alert: ErrorRateAlert;
}

const SWEEP_INTERVAL_MS = 60_000;

/** Keeps logs to meaningful events: no line for every request, but failed requests still log. */
class QuietRequestLog extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply, metadata?: Record<string, unknown>): void {
    if (error || reply.statusCode >= 500) super.requestCompleted(error, request, reply, metadata);
  }
}

/** Builds the server with every MVP service mounted: web hosting, rooms, relay, AI gateway and metrics. */
export async function buildApp(config: Config, deps: AppDeps = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetch ?? fetch;
  const options: FastifyServerOptions = {
    logger: {
      level: config.logLevel,
      // Logs hold room codes and nicknames, never move data or IP addresses.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
    logController: new QuietRequestLog(),
    // Trust only the first N proxy hops, so a client can't fake its IP with its own X-Forwarded-For.
    trustProxy: config.trustProxy > 0 ? (_address: string, hop: number) => hop < config.trustProxy : false,
    bodyLimit: 64 * 1024,
  };
  const https = config.tls ? { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) } : null;
  const app: FastifyInstance = https
    ? (Fastify({ ...options, https } as FastifyHttpsOptions<HttpsServer>) as unknown as FastifyInstance)
    : Fastify(options);

  const metrics = createMetrics();
  const rooms = new RoomStore({ maxRooms: config.rooms.maxRooms, emptyTtlMs: config.rooms.emptyTtlMs, now });
  const alert = new ErrorRateAlert({
    ratio: config.monitoring.aiErrorRatio,
    windowMs: config.monitoring.aiErrorWindowMs,
    minCalls: config.monitoring.aiErrorMinCalls,
    now,
    onChange: alertNotifier(config.monitoring.alertWebhookUrl, config.monitoring.aiErrorWindowMs, fetchFn, app.log),
  });
  const relay = new Relay({ config: config.relay, minClientVersion: config.minClientVersion, rooms, metrics, log: app.log, now });
  const ai = new AiGateway({ config: config.ai, metrics, alert, log: app.log, fetch: fetchFn, now });
  const accounts = config.accounts.databaseFile ? new AccountStore(config.accounts.databaseFile, now) : null;

  metrics.registry.gauge('sticxcape_rooms_active', 'Rooms held right now', () => rooms.size);
  if (accounts) metrics.registry.gauge('sticxcape_accounts', 'Accounts stored', () => accounts.accountCount);
  metrics.registry.gauge('sticxcape_players_connected', 'Phones connected to the relay', () => relay.connectionCount);
  metrics.registry.gauge('sticxcape_matches_active', 'Matches being played right now', () => relay.matchCount);
  metrics.registry.gauge('sticxcape_ai_error_ratio', 'Share of AI calls that failed in the alert window', () => alert.stats().ratio);
  metrics.registry.gauge('sticxcape_ai_alert_firing', '1 while the AI error alert is firing', () => (alert.stats().firing ? 1 : 0));

  // Added before the WebSocket plugin's own hook, so phones hear why before their sockets close.
  app.addHook('preClose', async () => relay.shutdown());
  await app.register(websocket, { options: { maxPayload: config.relay.maxPayloadBytes, perMessageDeflate: false } });
  addSecurityHeaders(app, config.env === 'production');

  const roomLimiter = registerRoomRoutes(app, { config, rooms, metrics, now });
  registerRelayRoutes(app, { relay, allowedOrigins: config.allowedOrigins });
  registerAiRoutes(app, { gateway: ai });
  const accountRoutes = registerAccountRoutes(app, { config, store: accounts, metrics, now });
  registerMonitoringRoutes(app, { config, metrics, rooms, relay, ai, alert });
  app.get('/version', async () => ({ minClientVersion: config.minClientVersion, serverVersion: config.serverVersion }));
  registerWeb(app, { webRoot: config.webRoot, labRoot: config.labRoot });

  const sweeper = setInterval(() => {
    rooms.sweep();
    roomLimiter.prune(now());
    accountRoutes.prune(now());
    accounts?.pruneSessions();
    alert.check();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    metrics.close();
    accounts?.close();
  });

  return { app, services: { rooms, relay, ai, accounts, metrics, alert } };
}
