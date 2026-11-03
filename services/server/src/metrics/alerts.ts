import type { FastifyBaseLogger } from 'fastify';

export interface AlertStats {
  calls: number;
  errors: number;
  ratio: number;
  firing: boolean;
}

export interface ErrorRateAlertOptions {
  /** Fire when errors ÷ calls goes above this, such as 0.05. */
  ratio: number;
  windowMs: number;
  /** Ignore windows with fewer calls than this, so one failure at 3 a.m. pages nobody. */
  minCalls: number;
  now: () => number;
  onChange: (firing: boolean, stats: AlertStats) => void;
}

const MINUTE_MS = 60_000;

/** Tracks AI call outcomes per minute and fires when the error rate over the window passes the threshold. */
export class ErrorRateAlert {
  private readonly options: ErrorRateAlertOptions;
  private readonly minutes = new Map<number, { ok: number; errors: number }>();
  private firing = false;

  constructor(options: ErrorRateAlertOptions) {
    this.options = options;
  }

  record(ok: boolean): void {
    const minute = Math.floor(this.options.now() / MINUTE_MS);
    let bucket = this.minutes.get(minute);
    if (!bucket) {
      bucket = { ok: 0, errors: 0 };
      this.minutes.set(minute, bucket);
    }
    if (ok) bucket.ok += 1;
    else bucket.errors += 1;
  }

  stats(): AlertStats {
    const oldest = Math.floor((this.options.now() - this.options.windowMs) / MINUTE_MS);
    let ok = 0;
    let errors = 0;
    for (const [minute, bucket] of this.minutes) {
      if (minute <= oldest) {
        this.minutes.delete(minute);
        continue;
      }
      ok += bucket.ok;
      errors += bucket.errors;
    }
    const calls = ok + errors;
    return { calls, errors, ratio: calls > 0 ? errors / calls : 0, firing: this.firing };
  }

  /** Re-evaluates the alert; call once a minute. */
  check(): void {
    const stats = this.stats();
    const shouldFire = stats.calls >= this.options.minCalls && stats.ratio > this.options.ratio;
    if (shouldFire === this.firing) return;
    this.firing = shouldFire;
    this.options.onChange(shouldFire, { ...stats, firing: shouldFire });
  }
}

/** Logs alert changes and, when a webhook is set, posts them to Slack or Discord. */
export function alertNotifier(webhookUrl: string | null, windowMs: number, fetchFn: typeof fetch, log: FastifyBaseLogger) {
  const minutes = Math.round(windowMs / MINUTE_MS);
  return (firing: boolean, stats: AlertStats): void => {
    const percent = (stats.ratio * 100).toFixed(1);
    const text = firing
      ? `SticXcape alert: ${percent}% of AI calls failed in the last ${minutes} minutes (${stats.errors} of ${stats.calls}). Move names and tips are falling back.`
      : `SticXcape resolved: AI errors are down to ${percent}% (${stats.errors} of ${stats.calls} calls in ${minutes} minutes).`;
    if (firing) log.error({ alert: 'ai_error_rate', ...stats }, text);
    else log.info({ alert: 'ai_error_rate', ...stats }, text);
    if (!webhookUrl) return;
    // Slack reads `text` and Discord reads `content`; each ignores the other.
    fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) log.warn({ status: res.status }, 'alert webhook refused the message');
      })
      .catch((err: unknown) => log.warn({ err: String(err) }, 'alert webhook failed'));
  };
}
