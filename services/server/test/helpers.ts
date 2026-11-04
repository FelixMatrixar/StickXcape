import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  connectWebSocket,
  RelayClient,
  ServicesClient,
  type ConnectOptions,
  type LockstepSession,
  type RelayClientEvents,
  type ToyMatch,
} from '@sticxcape/netcode';
import { FRAME_MS, type ServerMessage } from '@sticxcape/shared';
import { buildApp, type AppDeps, type Services } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';

/** Config for tests: silent logs, no lab, plus any settings given as environment variables. */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', LAB: 'false', ...env });
}

/** A clock the test moves by hand, shared by the server and the toy matches. */
export class FakeClock {
  time = Date.UTC(2026, 10, 3, 12);
  readonly now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

export interface TestServer {
  app: FastifyInstance;
  services: Services;
  config: Config;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** The whole server on a random local port. */
export async function startServer(config: Config = testConfig(), deps: AppDeps = {}): Promise<TestServer> {
  const { app, services } = await buildApp(config, deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  let closed = false;
  return {
    app,
    services,
    config,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}

export async function createRoom(server: TestServer, nickname = 'Host'): Promise<string> {
  return (await new ServicesClient({ baseUrl: server.baseUrl }).createRoom(nickname)).code;
}

/** A phone's relay client, as the game uses it. */
export async function connect(server: TestServer, options?: ConnectOptions): Promise<RelayClient> {
  return new RelayClient(await connectWebSocket(server.wsUrl, options));
}

export async function joinRoom(server: TestServer, code: string, nickname: string): Promise<RelayClient> {
  const client = await connect(server);
  await client.join(code, nickname);
  return client;
}

/** The next event of this kind that passes `accept`. Subscribe before doing what triggers it. */
export function nextEvent<E extends keyof RelayClientEvents>(
  client: RelayClient,
  event: E,
  accept: (value: RelayClientEvents[E]) => boolean = () => true,
  timeoutMs = 3000,
): Promise<RelayClientEvents[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`No matching ${event} event within ${timeoutMs} ms`));
    }, timeoutMs);
    const off = client.on(event, (value) => {
      if (!accept(value)) return;
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}

/** Both fighters tap Ready; resolves with each one's session. */
export async function startMatch(a: RelayClient, b: RelayClient): Promise<[LockstepSession, LockstepSession]> {
  const started = Promise.all([nextEvent(a, 'start'), nextEvent(b, 'start')]);
  a.ready();
  b.ready();
  return started;
}

/** Waits for a condition, spinning the event loop so sockets keep moving. */
export async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Plays toy matches through the relay until the relay ends them. The fake clock, which the
 * server also reads, moves one frame per turn, so a 10-second match takes well under a second.
 */
export async function playOut(matches: ToyMatch[], clock: FakeClock, maxTurns = 20_000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (matches.every((m) => m.session.ended)) return;
    clock.advance(FRAME_MS + 0.001);
    for (const match of matches) match.update(clock.now());
    await until(() => matches.every((m) => m.session.ended || m.session.canStep()));
  }
  throw new Error(`The match did not end within ${maxTurns} turns`);
}

/** A bare WebSocket to the relay, for sending what a well-behaved phone never would. */
export async function rawSocket(server: TestServer, options?: WebSocket.ClientOptions) {
  const ws = new WebSocket(server.wsUrl, options);
  const messages: ServerMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, closed, send: (message: unknown) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)) };
}
