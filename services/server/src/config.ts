import { fileURLToPath } from 'node:url';
import { CLIENT_VERSION } from '@sticxcape/shared';

export interface RoomsConfig {
  /** Rooms the server holds at once before refusing new ones. */
  maxRooms: number;
  /** Empty rooms expire after this long. */
  emptyTtlMs: number;
  /** Rooms one IP address may create per window. */
  createLimitPerIp: number;
  createWindowMs: number;
}

export interface RelayConfig {
  pingIntervalMs: number;
  /** A phone that sends nothing (not even pongs) for this long is disconnected. */
  idleTimeoutMs: number;
  /** A fighter that sends no input for this long during a match forfeits it. */
  matchIdleTimeoutMs: number;
  /** After one fighter reports the end, how long to wait for the other to agree. */
  endConfirmMs: number;
  /** Per-phone message cap: a little above 60 inputs a second. */
  messagesPerSecond: number;
  messageBurst: number;
  maxPayloadBytes: number;
  /** Inputs more than this many frames ahead of the match clock close the room. */
  aheadToleranceFrames: number;
  maxConnectionsPerIp: number;
  /** Round trip assumed for a phone with no ping samples yet. */
  defaultRttMs: number;
  /** Before a match, a fighter short of round-trip samples gets extra pings this far apart. */
  startPingSpacingMs: number;
  /** A match waits at most this long for those pings to be answered. */
  startPingWaitMs: number;
}

export interface AiConfig {
  /** Meta Model API key. Without one the gateway gives canned answers. */
  apiKey: string | null;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  /** Time allowed for Meta's reply, inside the client's 5 s budget. */
  timeoutMs: number;
  moveNamesPerDay: number;
  matchTipsPerDay: number;
  /** One IP may use this many players' worth of the daily limits (shared Wi-Fi, rotated ids). */
  perIpMultiplier: number;
  cacheEntries: number;
  cacheTtlMs: number;
}

export interface MonitoringConfig {
  /** Password for /admin and /metrics (HTTP Basic, user "admin"). */
  adminToken: string | null;
  /** Optional private port that serves /metrics without auth, for a Prometheus scraper. */
  metricsPort: number | null;
  /** Optional Slack or Discord webhook for the AI error alert. */
  alertWebhookUrl: string | null;
  aiErrorRatio: number;
  aiErrorWindowMs: number;
  aiErrorMinCalls: number;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  /** Origin used in invite links. When null, it comes from each request's Host header. */
  publicUrl: string | null;
  /** Folder holding the built web app. */
  webRoot: string;
  /** Folder holding the built relay lab page, or null to turn /lab off. */
  labRoot: string | null;
  minClientVersion: number;
  serverVersion: string;
  /** Proxy hops in front of the server whose X-Forwarded-For is trusted (1 on Fly.io). */
  trustProxy: number;
  /** Browser origins allowed to open the relay socket. Empty allows any. */
  allowedOrigins: string[];
  tls: { certFile: string; keyFile: string } | null;
  logLevel: string;
  rooms: RoomsConfig;
  relay: RelayConfig;
  ai: AiConfig;
  monitoring: MonitoringConfig;
}

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const DEFAULT_LAB_ROOT = fileURLToPath(new URL('../dist/lab/', import.meta.url));

/**
 * Muse Spark 1.1 answered in about 2.3 s (median) in live tests on 2026-11-04, against 3.3 s for
 * 1.3, whose slowest replies went past the 4.5 s budget and would have fallen back. Same price,
 * and its names and tips were as good.
 */
const DEFAULT_AI_MODEL = 'muse-spark-1.1';

/** The reasoning levels Muse Spark accepts. It rejects "none", which would make every AI call fall back. */
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const publicUrl = env.PUBLIC_URL ? origin('PUBLIC_URL', env.PUBLIC_URL) : null;
  const certFile = env.TLS_CERT_FILE || null;
  const keyFile = env.TLS_KEY_FILE || null;
  if ((certFile === null) !== (keyFile === null)) throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => origin('ALLOWED_ORIGINS', value));
  if (allowedOrigins.length === 0 && publicUrl && mode === 'production') allowedOrigins.push(publicUrl);

  return {
    env: mode,
    host: env.HOST || '0.0.0.0',
    port: int(env, 'PORT', 8080, 0, 65535),
    publicUrl,
    webRoot: env.WEB_ROOT || DEFAULT_WEB_ROOT,
    labRoot: flag(env, 'LAB', true) ? DEFAULT_LAB_ROOT : null,
    minClientVersion: int(env, 'MIN_CLIENT_VERSION', CLIENT_VERSION, 0, 1_000_000_000),
    serverVersion: env.SERVER_VERSION || env.FLY_IMAGE_REF || 'dev',
    trustProxy: int(env, 'TRUST_PROXY', 0, 0, 10),
    allowedOrigins,
    tls: certFile && keyFile ? { certFile, keyFile } : null,
    logLevel: env.LOG_LEVEL || (mode === 'test' ? 'silent' : 'info'),
    rooms: {
      maxRooms: int(env, 'MAX_ROOMS', 10_000, 1, 1_000_000),
      emptyTtlMs: 60 * 60 * 1000,
      createLimitPerIp: int(env, 'ROOMS_PER_IP_PER_10_MIN', 20, 1, 10_000),
      createWindowMs: 10 * 60 * 1000,
    },
    relay: {
      pingIntervalMs: 2000,
      idleTimeoutMs: 30_000,
      matchIdleTimeoutMs: 15_000,
      endConfirmMs: 5000,
      messagesPerSecond: 75,
      messageBurst: 90,
      maxPayloadBytes: 256 * 1024,
      aheadToleranceFrames: 120,
      maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 32, 1, 10_000),
      defaultRttMs: 50,
      startPingSpacingMs: 75,
      startPingWaitMs: 1000,
    },
    ai: {
      apiKey: env.MODEL_API_KEY || null,
      baseUrl: (env.MODEL_API_BASE_URL || 'https://api.meta.ai/v1').replace(/\/+$/, ''),
      model: env.AI_MODEL || DEFAULT_AI_MODEL,
      reasoningEffort: choice(env, 'AI_REASONING_EFFORT', REASONING_EFFORTS, 'minimal'),
      timeoutMs: int(env, 'AI_TIMEOUT_MS', 4500, 500, 30_000),
      moveNamesPerDay: int(env, 'AI_MOVE_NAMES_PER_DAY', 30, 0, 100_000),
      matchTipsPerDay: int(env, 'AI_MATCH_TIPS_PER_DAY', 60, 0, 100_000),
      perIpMultiplier: 10,
      cacheEntries: 5000,
      cacheTtlMs: 24 * 60 * 60 * 1000,
    },
    monitoring: {
      adminToken: env.ADMIN_TOKEN || null,
      metricsPort: env.METRICS_PORT ? int(env, 'METRICS_PORT', 0, 1, 65535) : null,
      alertWebhookUrl: env.ALERT_WEBHOOK_URL || null,
      aiErrorRatio: 0.05,
      aiErrorWindowMs: 15 * 60 * 1000,
      aiErrorMinCalls: 20,
    },
  };
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function choice<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = allowed.find((option) => option === raw);
  if (value === undefined) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

function origin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL such as https://play.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must use http or https`);
  return url.origin;
}
