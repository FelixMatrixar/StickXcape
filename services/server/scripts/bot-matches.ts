import { performance } from 'node:perf_hooks';
import {
  ApiRequestError,
  connectWebSocket,
  RelayClient,
  ServicesClient,
  ToyMatch,
  toyLoadout,
  type Latency,
  type RelayClientEvents,
} from '@sticxcape/netcode';
import { END_REASONS, FPS, type EndReason } from '@sticxcape/shared';

export interface BotMatchOptions {
  /** The server's origin, such as http://localhost:8080. */
  url: string;
  /** Rooms playing at the same time, two bots in each. */
  rooms: number;
  /** Matches each room plays in a row (winner stays on, so these are rematches). */
  matches: number;
  /**
   * Round trip added between the two phones, in ms, as the input-delay rule measures it: each
   * bot's link to the relay gets half, split evenly between sending and receiving.
   */
  latencyMs: number;
  /** The delay between the phones varies by up to this many ms either way (half on each link); order is always kept. */
  jitterMs: number;
  /** Frames before a match goes to whoever has more health. */
  maxFrames: number;
  /** Progress lines; silent when left out. */
  log?: (line: string) => void;
}

export interface BotMatchReport {
  matches: number;
  reasons: Record<EndReason, number>;
  /** Anything that went wrong: relay errors, unexpected ends, closed sockets, timeouts. */
  errors: string[];
  /** The input delay the relay picked, per match. */
  inputDelays: number[];
  /** Share of match time the bots spent waiting for the other phone's input. */
  stallShare: number;
  /** Each bot's round trip to the relay, in ms, as it measured it at the end. */
  rttMs: number[];
  seconds: number;
}

/** How often the bots' drivers run; they simulate at 60 Hz whatever the tick. */
const TICK_MS = 4;

/** Every running match, driven by one shared timer so hundreds of rooms stay cheap. */
const running = new Set<{ match: ToyMatch; stalledMs: number }>();
let ticker: NodeJS.Timeout | null = null;
let lastTick = 0;

function track(entry: { match: ToyMatch; stalledMs: number }): () => void {
  running.add(entry);
  if (!ticker) {
    lastTick = performance.now();
    ticker = setInterval(() => {
      const now = performance.now();
      for (const item of running) {
        item.match.update(now);
        if (item.match.stalled) item.stalledMs += now - lastTick;
      }
      lastTick = now;
    }, TICK_MS);
  }
  return () => {
    running.delete(entry);
    if (running.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** Plays toy matches between bots through a real relay, the way two phones would. */
export async function runBotMatches(options: BotMatchOptions): Promise<BotMatchReport> {
  const report: BotMatchReport = {
    matches: 0,
    reasons: Object.fromEntries(END_REASONS.map((reason) => [reason, 0])) as Record<EndReason, number>,
    errors: [],
    inputDelays: [],
    stallShare: 0,
    rttMs: [],
    seconds: 0,
  };
  const totals = { stalledMs: 0, matchMs: 0 };
  const started = performance.now();
  await Promise.all(Array.from({ length: options.rooms }, (_, i) => playRoom(i + 1, options, report, totals)));
  report.seconds = (performance.now() - started) / 1000;
  report.stallShare = totals.matchMs > 0 ? totals.stalledMs / totals.matchMs : 0;
  return report;
}

async function playRoom(index: number, options: BotMatchOptions, report: BotMatchReport, totals: { stalledMs: number; matchMs: number }): Promise<void> {
  const services = new ServicesClient({ baseUrl: options.url });
  const bots: RelayClient[] = [];
  let leaving = false;
  try {
    const { code } = await services.createRoom(`Bot ${index}A`);
    for (const name of [`Bot ${index}A`, `Bot ${index}B`]) {
      const bot = new RelayClient(await connectWebSocket(services.relayUrl, { latency: botLatency(options) }));
      bots.push(bot);
      bot.on('error', (error) => report.errors.push(`room ${index}, ${name}: relay error ${error.code}: ${error.message}`));
      bot.on('close', (reason) => {
        if (!leaving) report.errors.push(`room ${index}, ${name}: connection closed (${reason})`);
      });
      await bot.join(code, name);
      bot.sendLoadout(toyLoadout());
    }
    const [a, b] = bots as [RelayClient, RelayClient];

    for (let round = 1; round <= options.matches; round++) {
      const where = `room ${index}, match ${round}`;
      const starts = Promise.all([once(a, 'start', 10_000), once(b, 'start', 10_000)]);
      a.ready();
      b.ready();
      const sessions = await starts;
      const matchTimeout = (options.maxFrames / FPS) * 1000 + 30_000;
      const ends = Promise.all([once(a, 'end', matchTimeout), once(b, 'end', matchTimeout)]);
      const entries = sessions.map((session) => ({ match: new ToyMatch(session, { maxFrames: options.maxFrames }), stalledMs: 0 }));
      const untrack = entries.map(track);
      const began = performance.now();
      try {
        const [end, otherEnd] = await ends;
        report.matches += 1;
        report.reasons[end.reason] += 1;
        report.inputDelays.push(sessions[0].inputDelay);
        if (end.reason !== 'finished') report.errors.push(`${where}: ended by ${end.reason}`);
        else if (end.winner !== entries[0]!.match.result || otherEnd.winner !== end.winner) report.errors.push(`${where}: the relay and the bots disagree on the winner`);
        const desync = sessions.find((session) => session.desyncFrame !== null);
        if (desync) report.errors.push(`${where}: state hashes differed at frame ${desync.desyncFrame}`);
      } finally {
        for (const stop of untrack) stop();
        const ms = performance.now() - began;
        totals.matchMs += ms;
        totals.stalledMs += (entries[0]!.stalledMs + entries[1]!.stalledMs) / 2;
      }
      options.log?.(`${where}: ${report.reasons.finished} finished so far, input delay ${sessions[0].inputDelay}, ${entries[0]!.match.sim.frame} frames`);
    }
    for (const bot of bots) if (bot.rtt !== null) report.rttMs.push(bot.rtt);
  } catch (err) {
    const why = err instanceof ApiRequestError && err.status === 429 ? `${err.message} (raise ROOMS_PER_IP_PER_10_MIN on the server)` : String(err);
    report.errors.push(`room ${index}: ${why}`);
  } finally {
    leaving = true;
    for (const bot of bots) bot.close();
  }
}

/** Half the added round trip goes on each bot's link, half of that each way; jitter splits the same way. */
function botLatency({ latencyMs, jitterMs }: BotMatchOptions): Latency | undefined {
  if (latencyMs <= 0 && jitterMs <= 0) return undefined;
  const oneWay = latencyMs / 4;
  const delay = () => Math.max(0, oneWay + ((Math.random() * 2 - 1) * jitterMs) / 2);
  return { sendMs: delay, receiveMs: delay };
}

function once<E extends keyof RelayClientEvents>(client: RelayClient, event: E, timeoutMs: number): Promise<RelayClientEvents[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${event} within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const off = client.on(event, (value) => {
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}
