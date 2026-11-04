/**
 * Bot matches against a running server: pairs of bots play toy matches through the relay in
 * real time, the way two phones would. Run from the repository root:
 *
 *   npm run bots                                    one match against http://localhost:8080
 *   npm run bots -- --rooms 10 --matches 5          the week 3 check: 50 matches, no desync or relay error
 *   npm run bots -- --latency 100 --jitter 20       a bad network: 100 ms more round trip between the phones
 *   npm run bots -- --latency 200 --rollback        rollback netcode instead of input delay (MP-6)
 *   npm run bots -- --rooms 200 --matches 2         load: start the server with MAX_CONNECTIONS_PER_IP=1000
 *                                                   and ROOMS_PER_IP_PER_10_MIN=1000 first
 *   npm run bots -- --url https://staging.example --admin-token ...
 *
 * Exits with 1 when any match desyncs, a relay error happens, or waiting passes --max-stall.
 */
import { parseArgs } from 'node:util';
import { runBotMatches, type BotMatchReport } from './bot-matches.ts';

const HELP = `Usage: npm run bots -- [options]

  --url <origin>        Server to play against (default http://localhost:8080)
  --rooms <n>           Rooms playing at once, two bots each (default 1)
  --matches <n>         Matches per room, back to back (default 1)
  --latency <ms>        Round trip added between the two phones (default 0)
  --jitter <ms>         The delay between the phones varies by up to this much either way (default 0)
  --max-frames <n>      Frames before a match goes to whoever leads (default 3600, 60 s)
  --rollback            Play with rollback netcode: 2 frames of input delay, up to 8 frames corrected
  --max-stall <pct>     Fail when bots wait for each other more than this share of the time (default 5)
  --admin-token <t>     ADMIN_TOKEN of the server, to print its own relay stats
  --quiet               Only print the summary
`;

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    rooms: { type: 'string', default: '1' },
    matches: { type: 'string', default: '1' },
    latency: { type: 'string', default: '0' },
    jitter: { type: 'string', default: '0' },
    'max-frames': { type: 'string', default: '3600' },
    rollback: { type: 'boolean', default: false },
    'max-stall': { type: 'string', default: '5' },
    'admin-token': { type: 'string' },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

function number(name: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    process.stderr.write(`--${name} must be a number of at least ${min}\n\n${HELP}`);
    process.exit(2);
  }
  return value;
}

const url = values.url.replace(/\/+$/, '');
const options = {
  url,
  rooms: Math.floor(number('rooms', values.rooms, 1)),
  matches: Math.floor(number('matches', values.matches, 1)),
  latencyMs: number('latency', values.latency, 0),
  jitterMs: number('jitter', values.jitter, 0),
  maxFrames: Math.floor(number('max-frames', values['max-frames'], 60)),
  rollback: values.rollback,
};
const maxStall = number('max-stall', values['max-stall'], 0) / 100;

const simulated = options.latencyMs > 0 || options.jitterMs > 0;
const network = simulated ? `, +${options.latencyMs} ms round trip ±${options.jitterMs} ms jitter` : '';
const netcode = options.rollback ? ', rollback netcode' : '';
console.log(`SticXcape bot matches against ${url}: ${options.rooms} room(s) × ${options.matches} match(es)${network}${netcode}`);
if (simulated && process.platform === 'win32') {
  console.log('Note: timers on Windows tick about every 15.6 ms, so each added delay comes out up to 15 ms longer.');
  console.log('      Check the measured round trip below, or run bad-network checks on Linux (as CI does) for exact delays.');
}

const report = await runBotMatches({ ...options, log: values.quiet ? undefined : (line) => console.log(`  ${line}`) });
printReport(report);
await printServerStats();

// Asking for rollback and getting input delay means the server is older than these bots.
const noRollback = options.rollback && report.rollbackMatches < report.matches;
if (noRollback) console.log(`\nAsked for rollback, but the relay started ${report.matches - report.rollbackMatches} match(es) with input delay only.`);
const failed = report.errors.length > 0 || report.matches < options.rooms * options.matches || report.stallShare > maxStall || noRollback;
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);

function printReport(r: BotMatchReport): void {
  const { finished, desync, disconnect, room_closed: closed } = r.reasons;
  console.log(`\n${r.matches} matches in ${r.seconds.toFixed(1)} s: ${finished} finished, ${desync} desyncs, ${disconnect} disconnects, ${closed} rooms closed`);
  const delays = new Map<number, number>();
  for (const delay of r.inputDelays) delays.set(delay, (delays.get(delay) ?? 0) + 1);
  const delayText = [...delays].sort(([a], [b]) => a - b).map(([frames, count]) => `${frames} frames × ${count}`).join(', ');
  console.log(`Input delay picked by the relay: ${delayText || 'none'}`);
  if (r.rollback.frames > 0) {
    const { frames, rollbacks, replayedFrames, deepest } = r.rollback;
    const replayed = ((replayedFrames / frames) * 100).toFixed(1);
    console.log(`Rollback: ${rollbacks} rewinds in ${frames} frames, deepest ${deepest} frames; ${replayedFrames} frames replayed (${replayed}% extra simulation)`);
  }
  console.log(`Waiting for the other phone: ${(r.stallShare * 100).toFixed(1)}% of match time (limit ${(maxStall * 100).toFixed(1)}%)`);
  if (r.rttMs.length > 0) console.log(`Round trip to the relay: p50 ${Math.round(percentile(r.rttMs, 50))} ms, p95 ${Math.round(percentile(r.rttMs, 95))} ms`);
  if (r.errors.length > 0) {
    console.log(`\n${r.errors.length} problem(s):`);
    for (const error of r.errors.slice(0, 20)) console.log(`  ${error}`);
    if (r.errors.length > 20) console.log(`  …and ${r.errors.length - 20} more`);
  }
}

/** The relay's own view, from the dashboard's stats; skipped when they're switched off. */
async function printServerStats(): Promise<void> {
  try {
    const headers: Record<string, string> = values['admin-token'] ? { authorization: `Bearer ${values['admin-token']}` } : {};
    const res = await fetch(`${url}/admin/stats.json`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const stats = (await res.json()) as {
      relay: { rttMs: { p50: number | null; p95: number | null }; forwardMs: { p99: number | null }; dropped: number };
      matches: { desyncRate: number | null };
    };
    const ms = (v: number | null) => (v === null ? '–' : `${Math.round(v)} ms`);
    const hold = stats.relay.forwardMs.p99 === null ? '–' : `${stats.relay.forwardMs.p99.toFixed(2)} ms`;
    console.log(`Server: round trip p50 ${ms(stats.relay.rttMs.p50)}, p95 ${ms(stats.relay.rttMs.p95)}; relay hold p99 ${hold}; ${stats.relay.dropped} dropped messages`);
  } catch {
    // Stats are a bonus; the bots' own numbers above are the result.
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
