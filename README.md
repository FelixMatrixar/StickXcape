# SticXcape

Product and engineering PRDs for SticXcape, the motion-capture stick-figure fighting game.

| File | What it covers |
| --- | --- |
| [01-product-prd.md](01-product-prd.md) | What we build and why: gameplay, game feel, look and sound, Meta AI use, roadmap, parked ideas |
| [02-frontend-prd.md](02-frontend-prd.md) | The phone web app: modules, screens, technical rules, week-by-week plan |
| [03-backend-prd.md](03-backend-prd.md) | The services: rooms, relay, AI gateway, security, week-by-week plan |
| [04-integration-prd.md](04-integration-prd.md) | The contract between them: file formats, messages, API, tests, definition of done |

Diagrams are in [images/](images/). These files were exported on 2026-11-03 from the [live doc](https://claude.ai/artifact/92awHCKr9eSbJmi1h5ofwj), which stays the place to edit and comment.

## Code

| Folder | What it is |
| --- | --- |
| [packages/shared](packages/shared/src/index.ts) | The contract in code: file formats, messages, HTTP API, button bits, input-delay rule, fixed-point maths |
| [packages/netcode](packages/netcode/src/index.ts) | The client's netcode module, plus a fake relay and canned AI for working offline |
| [services/server](services/server/src/app.ts) | The MVP services in one Node process: web hosting, rooms, relay, AI gateway, metrics |
| [services/server/lab](services/server/lab/main.ts) | The relay lab at `/lab/`: a toy match between two phones through the relay, on the game's netcode |
| [services/server/scripts](services/server/scripts/bots.ts) | Bot matches for the 50-match, bad-network and load checks, and the lab build |
| [apps/client](apps/client/src/main.ts) | The game client: Move Studio, the deterministic fight engine, renderer, sound and every screen |
| [apps/client/scripts](apps/client/scripts/bot-opponent.ts) | A practice bot that joins a room through the relay and fights with the client's engine |

Progress is tracked in the [Frontend PRD](02-frontend-prd.md#progress) and the [Backend PRD](03-backend-prd.md#progress).

### Run the game

```bash
npm install
npm run dev
```

```bash
npm run dev:client
```

The first starts the services on port 8080; the second serves the game on port 5173 and forwards rooms, the relay and AI calls to the services. Open http://localhost:5173. Practice fights and Move Studio work without the services; rooms, move names and coach tips need them.

On a computer: A and D walk, W jumps, S crouches, J light, K heavy, L special, I defense, Space blocks (tap it just before a hit lands to parry). Gamepads work too. On phones the on-screen stick and buttons appear.

To fight online from one computer, create a room in the browser and let a bot join it:

```bash
node --conditions=source apps/client/scripts/bot-opponent.ts <invite link> --level hard
```

Both sides run the same engine and the relay compares their state hashes every second, so a finished match also proves the browser and Node agree.

Phones need HTTPS for the camera. Build everything, then serve the game from the services and open it through a tunnel such as `cloudflared tunnel --url http://localhost:8080`:

```bash
npm run build
```

```bash
WEB_ROOT=../../apps/client/dist TRUST_PROXY=1 npm start
```

`WEB_ROOT` is relative to `services/server`, where the server runs. The [Docker image](Dockerfile) already serves the game this way.

Without a camera, Move Studio offers a demo take: a default move replayed as noisy tracking through the same cleanup.

### Run the services

You need Node.js 22.18 or later, which runs TypeScript directly (on Windows: `winget install OpenJS.NodeJS.LTS`).

```bash
npm install
npm run dev
```

The server listens on port 8080. To set options such as the Meta API key, copy [services/server/.env.example](services/server/.env.example) to `services/server/.env`. Without a key, move names and tips are canned answers.

### Try it on two phones

1. Find your computer's address on your Wi-Fi (on Windows, `ipconfig` shows it as the IPv4 address).
2. On a phone on the same Wi-Fi, open `http://<that address>:8080` and tap **Create a room**. If Windows asks, allow Node.js on private networks.
3. Open the invite link on a second phone. Both phones should list both players.
4. For a match, open `http://<that address>:8080/lab/` instead: create a room, open its invite link on the second phone, and both tap **Ready**. Walk, jump and jab with the on-screen buttons, or tick **Let a bot play for me**. The lab shows the ping, the input delay, time spent waiting for the other phone, and the state checks.

The game client will need HTTPS for the camera; for that, run a tunnel such as `cloudflared tunnel --url http://localhost:8080` and set `TRUST_PROXY=1`.

### Check it

```bash
npm run typecheck
```

```bash
npm test
```

The tests cover the shared contract, the netcode and the services, including real matches through the relay over WebSockets.

With the server running, `npm run bots` plays bot matches through it in real time:

```bash
npm run bots -- --rooms 10 --matches 5
```

```bash
npm run bots -- --latency 100 --jitter 20
```

The first is the week 3 check (50 matches with no desync or relay error), the second a bad network (100 ms more round trip between the phones). `--rooms 200` is a load test; start that server with `MAX_CONNECTIONS_PER_IP=1000 ROOMS_PER_IP_PER_10_MIN=1000`. On Windows, timers tick every 15.6 ms, so added delays come out longer than asked; the bots print the round trip they measured. `npm run bots -- --help` lists every option.

### Deploy

The [Dockerfile](Dockerfile) builds one image with everything:

```bash
docker build -t sticxcape .
```

[fly.toml](fly.toml) runs it on Fly.io as staging for playtests, and its comments give the one-time setup. After that, run **Deploy staging** from the GitHub Actions tab (it needs a `FLY_API_TOKEN` secret) or `fly deploy`. [CI](.github/workflows/ci.yml) typechecks, tests, plays the bot matches and smoke-tests the image on every push and pull request.
