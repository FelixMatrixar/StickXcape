import type { Connection } from './connection.ts';

/** A signed-in player waiting for a quick match. */
export interface Seeker {
  conn: Connection;
  accountId: string;
  /** The nickname strangers see: theirs once Meta AI has checked it, otherwise Challenger. */
  nickname: string;
  rating: number;
  since: number;
  /** Accounts this player blocked or was blocked by. */
  blocked: ReadonlySet<string>;
}

/** Round trip assumed for a phone the relay hasn't measured yet. */
const DEFAULT_RTT_MS = 50;

/**
 * How far apart two seekers may be after the longer of them has waited `seconds`. Ratings start
 * within 100 points and widen by 25 a second, ping starts under 100 ms between the phones (the
 * PRD's target) and widens by 15 ms a second. After 30 s anyone is a match, so a quiet hour
 * still gets games.
 */
export function ratingWindow(seconds: number): number {
  return seconds >= 30 ? Infinity : 100 + 25 * seconds;
}

export function pingWindow(seconds: number): number {
  return seconds >= 30 ? Infinity : 100 + 15 * seconds;
}

/** The round trip between two phones through the relay: each one's round trip to it, added. */
export function pingBetween(a: Seeker, b: Seeker): number {
  return (a.conn.rtt() ?? DEFAULT_RTT_MS) + (b.conn.rtt() ?? DEFAULT_RTT_MS);
}

/** Every 10 ms of ping costs as much as 10 rating points when choosing between opponents. */
const PING_WEIGHT = 1;

/**
 * The quick match queue (MP-7): pairs strangers on skill rating and ping. The longest-waiting
 * player picks first, taking the closest opponent inside the windows above; blocked pairs and
 * two sessions of one account never meet.
 */
export class Matchmaker {
  private readonly queue: Seeker[] = [];

  get size(): number {
    return this.queue.length;
  }

  has(conn: Connection): boolean {
    return this.queue.some((seeker) => seeker.conn === conn);
  }

  add(seeker: Seeker): void {
    if (!this.has(seeker.conn)) this.queue.push(seeker);
  }

  remove(conn: Connection): boolean {
    const index = this.queue.findIndex((seeker) => seeker.conn === conn);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** Takes every pair that can be made now out of the queue. */
  takePairs(now: number): [Seeker, Seeker][] {
    const pairs: [Seeker, Seeker][] = [];
    const taken = new Set<Seeker>();
    const byWait = [...this.queue].sort((a, b) => a.since - b.since);
    for (const a of byWait) {
      if (taken.has(a)) continue;
      let best: Seeker | null = null;
      let bestCost = Infinity;
      for (const b of byWait) {
        if (b === a || taken.has(b) || !this.compatible(a, b, now)) continue;
        const cost = Math.abs(a.rating - b.rating) + PING_WEIGHT * pingBetween(a, b);
        if (cost < bestCost) {
          best = b;
          bestCost = cost;
        }
      }
      if (best) {
        taken.add(a);
        taken.add(best);
        pairs.push([a, best]);
      }
    }
    if (taken.size > 0) {
      const left = this.queue.filter((seeker) => !taken.has(seeker));
      this.queue.splice(0, this.queue.length, ...left);
    }
    return pairs;
  }

  private compatible(a: Seeker, b: Seeker, now: number): boolean {
    if (a.accountId === b.accountId || a.blocked.has(b.accountId) || b.blocked.has(a.accountId)) return false;
    // The window follows whoever has waited longer, so a long wait is never wasted.
    const waited = (now - Math.min(a.since, b.since)) / 1000;
    return Math.abs(a.rating - b.rating) <= ratingWindow(waited) && pingBetween(a, b) <= pingWindow(waited);
  }
}
