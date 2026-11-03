/** A token bucket: `rate` tokens a second, holding at most `burst`. */
export class TokenBucket {
  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  private last: number;

  constructor(rate: number, burst: number, now: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events per key in fixed windows, such as rooms created per IP every 10 minutes. */
export class WindowLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly counts = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  take(key: string, now: number): boolean {
    let entry = this.counts.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      entry = { start: now, count: 0 };
      this.counts.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  /** Forgets finished windows so the map can't grow without bound. */
  prune(now: number): void {
    for (const [key, entry] of this.counts) if (now - entry.start >= this.windowMs) this.counts.delete(key);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A per-key allowance that resets at midnight UTC, such as 30 move names a day per player. */
export class DailyQuota {
  private readonly limit: number;
  private readonly maxKeys: number;
  private day = -1;
  private readonly used = new Map<string, number>();

  constructor(limit: number, maxKeys = 200_000) {
    this.limit = limit;
    this.maxKeys = maxKeys;
  }

  take(key: string, wallClockMs: number): boolean {
    const day = Math.floor(wallClockMs / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.used.clear();
    }
    const used = this.used.get(key) ?? 0;
    if (used >= this.limit || (used === 0 && this.used.size >= this.maxKeys)) return false;
    this.used.set(key, used + 1);
    return true;
  }

  /** Gives back one use, for a request that failed through no fault of the player. */
  refund(key: string): void {
    const used = this.used.get(key);
    if (used !== undefined && used > 0) this.used.set(key, used - 1);
  }
}

/** Least-recently-used cache with a time to live. */
export class LruCache<V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { value: V; expires: number }>();

  constructor(max: number, ttlMs: number) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= now) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Keeps the latest samples of a value for percentiles on the dashboard. */
export class RollingSamples {
  private readonly values: number[] = [];
  private readonly capacity: number;
  private next = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: number): void {
    if (this.values.length < this.capacity) this.values.push(value);
    else this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
  }

  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  }

  get count(): number {
    return this.values.length;
  }
}
