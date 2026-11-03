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

Progress against the backend plan is tracked in the [Backend PRD](03-backend-prd.md#progress).

### Run the services

You need Node.js 22.12 or later (on Windows: `winget install OpenJS.NodeJS.LTS`).

```bash
npm install
npm run dev
```

The server listens on port 8080. To set options such as the Meta API key, copy [services/server/.env.example](services/server/.env.example) to `services/server/.env`. Without a key, move names and tips are canned answers.

### Try it on two phones

1. Find your computer's address on your Wi-Fi (on Windows, `ipconfig` shows it as the IPv4 address).
2. On a phone on the same Wi-Fi, open `http://<that address>:8080` and tap **Create a room**. If Windows asks, allow Node.js on private networks.
3. Open the invite link on a second phone. Both phones should list both players.

The game client will need HTTPS for the camera; for that, run a tunnel such as `cloudflared tunnel --url http://localhost:8080` and set `TRUST_PROXY=1`.
