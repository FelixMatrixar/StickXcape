import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  cleanText,
  TIP_MAX_WORDS,
  type MatchTipsRequest,
  type MatchTipsResponse,
  type MoveNameRequest,
  type MoveNameResponse,
} from '@sticxcape/shared';
import type { AiConfig } from '../config.ts';
import { DailyQuota, LruCache } from '../lib/limits.ts';
import type { ErrorRateAlert } from '../metrics/alerts.ts';
import type { AiCall, AiOutcome, Metrics } from '../metrics/metrics.ts';
import { cannedMatchTips, cannedMoveName } from './canned.ts';
import { AiError, chatJson } from './meta-client.ts';
import {
  ARENA_IMAGE_PROMPT,
  MATCH_TIPS_PROMPT,
  MOVE_NAME_PROMPT,
  NAME_PROMPT,
  arenaImageMessages,
  matchTipsMessages,
  moveNameMessages,
  nameMessages,
  type ChatMessage,
  type Prompt,
} from './prompts.ts';

/** A name's verdict: shown to others, refused, or not checked (no key, over the limit, or Meta failed). */
export type NameVerdict = 'allowed' | 'blocked' | 'unchecked';

/** A backdrop's verdict, with Meta's reason when it is flagged. */
export interface ImageVerdict {
  verdict: 'clear' | 'flagged' | 'unchecked';
  reason: string | null;
}

/** Sharing an arena isn't a moment anyone waits on mid-game, so its image check may take longer. */
const ARENA_CHECK_TIMEOUT_MS = 20_000;

/** The player used up a daily allowance; the client falls back (HTTP 429). */
export class AiRateLimitedError extends Error {}

/** Meta's API failed or was too slow; the client falls back (HTTP 503). */
export class AiUnavailableError extends Error {}

/** Who is asking. Limits apply per player id and, more loosely, per IP. */
export interface Requester {
  playerKey: string;
  ip: string;
}

export interface AiGatewayOptions {
  config: AiConfig;
  metrics: Metrics;
  alert: ErrorRateAlert;
  log: FastifyBaseLogger;
  fetch: typeof fetch;
  now: () => number;
}

const NAME_MAX_CHARS = 24;
const DESCRIPTION_MAX_CHARS = 90;
const MAX_ATTEMPTS = 2;
/** Retry only while at least this much of the time budget is left. */
const RETRY_MIN_BUDGET_MS = 1500;
const MAX_COMPLETION_TOKENS = 1024;

/**
 * The AI gateway: every call to Meta's Model API goes through here, so the API key never
 * reaches a phone. Structured replies, a time budget, per-player daily limits, a cache for
 * identical requests, and errors the client turns into its fallbacks.
 */
export class AiGateway {
  readonly mode: 'live' | 'canned';
  private readonly options: AiGatewayOptions;
  private readonly cache: LruCache<unknown>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly quotas: Record<AiCall, { player: DailyQuota; ip: DailyQuota }>;

  constructor(options: AiGatewayOptions) {
    const { config } = options;
    this.options = options;
    this.mode = config.apiKey ? 'live' : 'canned';
    this.cache = new LruCache(config.cacheEntries, config.cacheTtlMs);
    this.quotas = {
      move_name: { player: new DailyQuota(config.moveNamesPerDay), ip: new DailyQuota(config.moveNamesPerDay * config.perIpMultiplier) },
      match_tips: { player: new DailyQuota(config.matchTipsPerDay), ip: new DailyQuota(config.matchTipsPerDay * config.perIpMultiplier) },
      name_check: { player: new DailyQuota(config.nameChecksPerDay), ip: new DailyQuota(config.nameChecksPerDay * config.perIpMultiplier) },
      arena_check: { player: new DailyQuota(config.arenaChecksPerDay), ip: new DailyQuota(config.arenaChecksPerDay * config.perIpMultiplier) },
    };
  }

  /**
   * Whether other players may see a name: a nickname in quick match, or a shared arena's name
   * (launch moderation). Never throws: without a key, over the daily limit, or when Meta fails or
   * is slow, the answer is unchecked, and the caller decides ("block until checked").
   */
  async checkName(text: string, who: Requester): Promise<NameVerdict> {
    if (this.mode === 'canned') return 'unchecked';
    // Case doesn't change what a name says, so checks are cached without it.
    const name = text.toLowerCase();
    try {
      const { allowed } = await this.run('name_check', NAME_PROMPT, { name }, who, () => ({ allowed: false }), async (signal) => {
        const reply = await this.chat(NAME_PROMPT, nameMessages(name), who, signal);
        if (typeof reply.allowed !== 'boolean') throw new AiError('invalid_response', 'Reply had no verdict');
        if (!reply.allowed) this.options.log.info({ reason: cleanLine(reply.reason, 80) }, 'name blocked');
        return { allowed: reply.allowed };
      });
      return allowed ? 'allowed' : 'blocked';
    } catch {
      return 'unchecked';
    }
  }

  /**
   * Muse Spark's look at a photo arena's backdrop (a JPEG) before friends may open it (AR-5).
   * Never throws: unchecked when there is no key, the player is over the limit, or Meta fails.
   */
  async checkArenaImage(jpeg: Uint8Array, who: Requester): Promise<ImageVerdict> {
    if (this.mode === 'canned') return { verdict: 'unchecked', reason: null };
    const image = `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`;
    try {
      const result = await this.run(
        'arena_check',
        ARENA_IMAGE_PROMPT,
        { image },
        who,
        () => ({ safe: false, reason: '' }),
        async (signal) => {
          const reply = await this.chat(ARENA_IMAGE_PROMPT, arenaImageMessages(image), who, signal);
          if (typeof reply.safe !== 'boolean') throw new AiError('invalid_response', 'Reply had no verdict');
          return { safe: reply.safe, reason: cleanLine(reply.reason, 90) ?? '' };
        },
        ARENA_CHECK_TIMEOUT_MS,
      );
      return result.safe ? { verdict: 'clear', reason: null } : { verdict: 'flagged', reason: result.reason || null };
    } catch {
      return { verdict: 'unchecked', reason: null };
    }
  }

  /** A name and one-line description for a new move. */
  moveName(request: MoveNameRequest, who: Requester): Promise<MoveNameResponse> {
    return this.run('move_name', MOVE_NAME_PROMPT, request, who, () => cannedMoveName(request), async (signal) => {
      const reply = await this.chat(MOVE_NAME_PROMPT, moveNameMessages(request), who, signal);
      const name = cleanName(reply.name);
      const description = cleanLine(reply.description, DESCRIPTION_MAX_CHARS);
      if (!name || !description) throw new AiError('invalid_response', 'Reply had no usable name or description');
      return { name, description };
    });
  }

  /** Exactly 2 tips, each under 20 words, from one player's match stats. */
  matchTips(request: MatchTipsRequest, who: Requester): Promise<MatchTipsResponse> {
    return this.run('match_tips', MATCH_TIPS_PROMPT, request, who, () => cannedMatchTips(request), async (signal) => {
      const reply = await this.chat(MATCH_TIPS_PROMPT, matchTipsMessages(request), who, signal);
      const tip1 = cleanTip(reply.tip1);
      const tip2 = cleanTip(reply.tip2);
      if (!tip1 || !tip2) throw new AiError('invalid_response', 'Reply did not hold 2 tips');
      return { tips: [tip1, tip2] };
    });
  }

  private async run<T>(
    call: AiCall,
    prompt: Prompt,
    request: unknown,
    who: Requester,
    canned: () => T,
    live: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.options.config.timeoutMs,
  ): Promise<T> {
    if (this.mode === 'canned') {
      this.count(call, 'canned');
      return canned();
    }
    const now = this.options.now();
    const key = cacheKey(prompt, this.options.config.model, request);
    const cached = this.cache.get(key, now);
    if (cached !== undefined) {
      this.count(call, 'cache_hit');
      return cached as T;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.count(call, 'cache_hit');
      return pending as Promise<T>;
    }

    const quota = this.quotas[call];
    if (!quota.player.take(who.playerKey, now)) {
      this.count(call, 'rate_limited');
      throw new AiRateLimitedError();
    }
    if (!quota.ip.take(who.ip, now)) {
      quota.player.refund(who.playerKey);
      this.count(call, 'rate_limited');
      throw new AiRateLimitedError();
    }

    const promise = this.callWithRetry(call, prompt, live, timeoutMs)
      .then(
        (value) => {
          this.cache.set(key, value, this.options.now());
          return value;
        },
        (err: unknown) => {
          // A failed call cost the player nothing, so it doesn't count against them.
          quota.player.refund(who.playerKey);
          quota.ip.refund(who.ip);
          throw err;
        },
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async callWithRetry<T>(call: AiCall, prompt: Prompt, live: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const { now, log } = this.options;
    const started = now();
    const deadline = started + timeoutMs;
    for (let attempt = 1; ; attempt += 1) {
      const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
      try {
        const value = await live(signal);
        this.record(call, 'ok', started);
        return value;
      } catch (err) {
        const error = err instanceof AiError ? err : new AiError(signal.aborted ? 'timeout' : 'network', err instanceof Error ? err.message : String(err));
        if (error.retryable && attempt < MAX_ATTEMPTS && deadline - now() > RETRY_MIN_BUDGET_MS) {
          await sleep(200 + Math.random() * 300);
          continue;
        }
        this.record(call, `error_${error.kind}`, started);
        log.warn({ call, prompt: `${prompt.id}.v${prompt.version}`, kind: error.kind, status: error.status, attempts: attempt }, `AI call failed: ${error.message}`);
        throw new AiUnavailableError(error.kind);
      }
    }
  }

  private record(call: AiCall, outcome: AiOutcome, started: number): void {
    const ms = this.options.now() - started;
    this.count(call, outcome);
    this.options.metrics.aiLatency.observe(ms / 1000, { call });
    this.options.metrics.samples.aiMs[call].push(ms);
    this.options.alert.record(outcome === 'ok');
  }

  private count(call: AiCall, outcome: AiOutcome): void {
    this.options.metrics.aiRequests.inc({ call, outcome });
  }

  private chat(prompt: Prompt, messages: ChatMessage[], who: Requester, signal: AbortSignal): Promise<Record<string, unknown>> {
    const { config, fetch } = this.options;
    return chatJson({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? '',
      fetch,
      signal,
      body: {
        model: config.model,
        messages,
        response_format: { type: 'json_schema', json_schema: { name: prompt.schemaName, schema: prompt.schema, strict: true } },
        reasoning_effort: config.reasoningEffort,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        // Meta asks for a hashed id so it can flag abuse without learning who the player is.
        safety_identifier: sha256(who.playerKey).slice(0, 32),
        prompt_cache_key: `sticxcape-${prompt.id}-v${prompt.version}`,
      },
    });
  }
}

function cacheKey(prompt: Prompt, model: string, request: unknown): string {
  return sha256(`${prompt.id}.v${prompt.version}|${model}|${JSON.stringify(request)}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps whole words up to `maxChars` characters. */
function fitWords(text: string, maxChars: number): string {
  if ([...text].length <= maxChars) return text;
  let fitted = '';
  for (const word of text.split(' ')) {
    const next = fitted ? `${fitted} ${word}` : word;
    if ([...next].length > maxChars) break;
    fitted = next;
  }
  return fitted || [...text].slice(0, maxChars).join('');
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/["“”`*_#]/g, '').replace(/\s+/g, ' ').trim();
  return cleanText(fitWords(text, NAME_MAX_CHARS), NAME_MAX_CHARS);
}

function cleanLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const line = (value.split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  return cleanText(fitWords(line, maxChars), maxChars);
}

/** One tip without list markers, cut to at most TIP_MAX_WORDS words. */
function cleanTip(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().replace(/^(?:[-•*]\s+|\d+[.)]\s+)/, '');
  const words = text.split(' ');
  const tip = words.length > TIP_MAX_WORDS ? `${words.slice(0, TIP_MAX_WORDS).join(' ').replace(/[,;:]$/, '')}…` : text;
  return cleanText(tip, 200);
}
