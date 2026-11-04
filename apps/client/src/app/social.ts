/**
 * Report and block (trust and safety: "report and block from every result screen"). Blocks stay
 * on this phone, by nickname (the only identity the MVP has), and a room with someone you blocked
 * won't let you ready up. Reports go to the services; when they can't be delivered (offline, or a
 * server without the launch endpoint yet) they wait on the phone and are sent again later.
 *
 * Proposed contract (Integration PRD, launch): POST /reports { nickname, reason, room, at } with
 * the X-Player-Id header; the services answer 202.
 */
import { uuid } from '../moves/hash.ts';
import { services } from './online.ts';
import { settings, updateSettings } from './settings.ts';

export type ReportReason = 'name' | 'moves' | 'cheating' | 'other';

export const REPORT_REASONS: readonly { value: ReportReason; label: string }[] = [
  { value: 'name', label: 'Offensive name' },
  { value: 'moves', label: 'Offensive move or taunt' },
  { value: 'cheating', label: 'Cheating' },
  { value: 'other', label: 'Something else' },
];

export interface Report {
  nickname: string;
  reason: ReportReason;
  /** The room the match was played in, when there was one. */
  room: string | null;
  at: string;
}

const QUEUE_KEY = 'sticxcape.reports.v1';
const MAX_QUEUED = 20;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function isBlocked(nickname: string): boolean {
  return settings.blocked.some((name) => same(name, nickname));
}

export function block(nickname: string): void {
  if (!isBlocked(nickname)) updateSettings({ blocked: [...settings.blocked, nickname.trim()] });
}

export function unblock(nickname: string): void {
  updateSettings({ blocked: settings.blocked.filter((name) => !same(name, nickname)) });
}

/** Sends a report now if it can; otherwise keeps it on the phone. */
export async function report(nickname: string, reason: ReportReason, room: string | null): Promise<'sent' | 'queued'> {
  const item: Report = { nickname, reason, room, at: new Date().toISOString() };
  if (await send(item)) return 'sent';
  save([...queued(), item].slice(-MAX_QUEUED));
  return 'queued';
}

/** Tries the reports still waiting on this phone (called when the app starts). */
export async function flushReports(): Promise<number> {
  const waiting = queued();
  const left: Report[] = [];
  for (const item of waiting) if (!(await send(item))) left.push(item);
  save(left);
  return waiting.length - left.length;
}

export function queued(): Report[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as Report[]) : [];
  } catch {
    return [];
  }
}

function save(list: Report[]): void {
  try {
    if (list.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    // Storage blocked: the report is lost with the visit.
  }
}

/** The same random id the services client sends for per-player limits. */
export function playerId(): string {
  const key = 'sticxcape.playerId';
  try {
    const known = localStorage.getItem(key);
    if (known) return known;
    const id = uuid();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return uuid();
  }
}

async function send(item: Report): Promise<boolean> {
  try {
    const response = await fetch(`${services.baseUrl}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-player-id': playerId() },
      body: JSON.stringify(item),
    });
    return response.ok;
  } catch {
    return false;
  }
}
