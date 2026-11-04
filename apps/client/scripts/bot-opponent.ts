/**
 * A practice-bot opponent that joins a friend room through the relay and fights with the game
 * client's own engine, for testing online play from one computer:
 *
 *   node --conditions=source apps/client/scripts/bot-opponent.ts <room code or invite link> [--server http://localhost:8080] [--level hard]
 *
 * Both sides run the same deterministic simulation and the relay compares state hashes every 60
 * frames, so a finished match here also checks that the browser and Node agree bit for bit.
 */
import { connectWebSocket, LockstepDriver, RelayClient, ServicesClient, type LockstepSession } from '@sticxcape/netcode';
import { roomCodeFromPath } from '@sticxcape/shared';
import { PracticeBot, type BotLevel } from '../src/engine/bot.ts';
import { FightSim, PHASE } from '../src/engine/sim.ts';
import { defaultMoves } from '../src/moves/defaults.ts';
import { completeLoadout } from '../src/moves/loadout.ts';
import { arenaFileById, simArena } from '../src/render/arena-files.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
if (!target) {
  console.error('Usage: node --conditions=source apps/client/scripts/bot-opponent.ts <room code or invite link> [--server URL] [--level easy|normal|hard]');
  process.exit(1);
}
const code = target.includes('/') ? roomCodeFromPath(new URL(target).pathname) : target.toLowerCase();
if (!code) throw new Error(`Not a room link or code: ${target}`);
const server = option('server', 'http://localhost:8080');
const level = option('level', 'normal') as BotLevel;


const services = new ServicesClient({ baseUrl: server });
const client = new RelayClient(await connectWebSocket(services.relayUrl));
const joined = await client.join(code, `${level[0]!.toUpperCase()}${level.slice(1)} Bot`);
console.log(`Joined room ${code} as player ${joined.player}`);
const loadout = defaultMoves();
client.sendLoadout(loadout);
client.on('room', (room) => {
  const me = room.players.find((p) => p.player === client.player);
  if (room.players.length >= 2 && !room.fighters && me && !me.ready && room.queue.slice(0, 2).includes(me.player)) {
    console.log('Ready');
    client.ready();
  }
});
client.on('error', (err) => console.error('Relay error:', err.code, err.message));
client.on('close', (reason) => {
  console.log('Disconnected:', reason);
  process.exit(0);
});
client.on('start', (session) => play(session));

function play(session: LockstepSession): void {
  const [left, right] = session.fighters;
  const loadoutOf = (player: number) => (player === client.player ? loadout : completeLoadout(client.loadouts.get(player) ?? defaultMoves()));
  // The same arena file the browser uses, so the edges match.
  const arena = simArena(arenaFileById(session.arenaId));
  const sim = new FightSim({ seed: session.seed, arena, loadouts: [loadoutOf(left), loadoutOf(right)] });
  const bot = new PracticeBot(session.localSide, session.seed ^ 0x51, level);
  let reported = false;
  let checks = 0;
  const driver = new LockstepDriver(session, {
    sampleInput: () => bot.input(sim),
    simulate: (inputs) => {
      sim.step(inputs);
      for (const event of sim.events) {
        if (event.type === 'roundEnd') console.log(`Round over: winner side ${event.winner} by ${event.reason}`);
        if (event.type === 'matchEnd' && !reported) {
          reported = true;
          session.finish(event.winner === null ? null : session.fighters[event.winner]);
        }
      }
    },
    stateHash: () => {
      checks += 1;
      return sim.hash();
    },
  });
  console.log(`Match started: seed ${session.seed}, input delay ${session.inputDelay}, I am side ${session.localSide}`);
  session.onDesync((frame) => console.error(`DESYNC at frame ${frame}`));
  const timer = setInterval(() => {
    driver.update(performance.now());
    if (session.ended || sim.phase === PHASE.over) clearInterval(timer);
  }, 4);
  session.onEnd((end) => {
    clearInterval(timer);
    console.log(`Match ended: ${end.reason}, winner player ${end.winner}, ${checks} state checks sent, desync frame ${session.desyncFrame ?? 'none'}`);
  });
}
