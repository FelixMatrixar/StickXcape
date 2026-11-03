# Backend PRD: services

Part of the SticXcape PRD set: [Product](01-product-prd.md) · [Frontend](02-frontend-prd.md) · **Backend** · [Integration](04-integration-prd.md)

## Scope

The services are everything that runs off the phone. In the MVP they are deliberately thin: room links, a relay that passes button presses between two phones, and a gateway that calls Meta's Model API. They grow at launch with accounts, move storage, matchmaking and photo arenas.

**Owns**

- Web hosting, room links and the relay.
- Online play end to end, including the client's netcode module, so the two workloads stay close.
- The AI gateway: the Meta API key, prompts, fallbacks and rate limits.
- Metrics, staging and deployment.

**Doesn't own**

- The fight itself. It runs on the phones; the relay never simulates.
- How anything looks or sounds.

**Requirements covered** (IDs from the [product PRD](01-product-prd.md))

- MVP: MP-1, MP-2 and MP-3 end to end, the AI side of MS-7 and MP-5.
- Launch: MP-6 to MP-9, AR-4, AR-5, AR-7, and nickname and taunt moderation.

## Progress

Updated 2026-11-03. The code is on the `backend-mvp` branch. Nothing has been tried on phones yet, and there are no automated tests yet.

| Deliverable | Status | Code |
| --- | --- | --- |
| Shared types package: move and arena files, room messages, HTTP API, button bits, input-delay rule, fixed-point maths | Written | `packages/shared` |
| Web hosting | Written: serves the web app, invite links and a test page. HTTPS comes from the host or a local tunnel | `services/server/src/web` |
| Rooms | Written and tried locally: create, look up, 8-player cap, empty rooms expire after an hour | `services/server/src/rooms` |
| Relay | Written: lobby, loadout and input passing, ping and input delay, desync and result checks, malformed-message drops, rate cap, input-ahead room close, winner stays on. Only joining has been tried so far | `services/server/src/relay` |
| AI gateway | Written: Muse Spark names and tips with versioned prompts, structured output, a 4.5 s budget, per-player daily limits, a cache, and canned answers when no key is set. Canned tips tried locally; live Meta calls need a key | `services/server/src/ai` |
| Metrics and alert | Written: Prometheus `/metrics`, an `/admin` dashboard, and an alert when AI errors pass 5% (optional Slack or Discord webhook) | `services/server/src/metrics` |
| Netcode client | Written: relay connection, input-delay lockstep, state-hash checks, fixed-step driver | `packages/netcode` |
| Client mocks | Written: a fake relay with an echo opponent, and canned AI names and tips | `packages/netcode` |
| Test page for phones | Written: create a room, open the link on a second phone, see each other | `services/server/public` |
| Relay lab (a toy match between two phones) | Not started | |
| Automated tests, bot matches, bad-network and load scripts | Not started | |
| Staging deploy (Docker, Fly.io) and CI | Not started | |
| Launch services | Not started; they wait for playtests | |

**Week checks.** Week 1 ("two phones join one room from a link and see each other") is ready to try with the test page. Weeks 2 and 3 need the relay lab or the game client.

**Contract details settled in code.** The [Integration PRD](04-integration-prd.md) left these open, so the frontend owner should review them:

- The relay answers `join` with `joined` (player, host, room), sends lobby changes as `room`, and sends failures as `error` (code, message).
- `start` also carries `fighters` (left, then right) and `arenaId`. The relay's `end` adds a `reason`: finished, desync, disconnect or room_closed.
- The 4 stick bits are up, down, left and right on screen; then L, H, S, D and Block.
- `stateHash` is an unsigned 32-bit number, sent after frames 0, 60, 120 and so on.
- The ping in the input-delay rule is the round trip between the two phones through the relay.
- Move frames are 19 little-endian int16 values each: root x and y in millimetres, then 17 joint angles in 1/65536 of a turn. The move hash covers a fixed JSON array of the hashed fields.
- `POST /ai/move-name` takes the 3 images as `keyframes` (PNG or WebP data URLs). Phones send a random id in `X-Player-Id` for per-player limits, and both AI calls answer 429 once the daily limit is hit.
- Room codes are 16 characters, invite links are `/r/{code}`, and the first player to join hosts.

## Services

Five small services make the MVP; five more arrive at launch. All are TypeScript on Node.js, so they share types with the client, and one small server in one region is enough for the MVP beta.

| Service | What it does | Phase |
| --- | --- | --- |
| Web hosting | Serves the web app over HTTPS | MVP |
| Rooms | Creates a room with an unguessable code and invite link; tracks players, host and arena | MVP |
| Relay | One WebSocket hub per room: passes loadouts and each frame's inputs to the other player, measures ping, runs no game logic | MVP |
| AI gateway | Calls Meta's Model API for move names and match tips; holds the API key; applies rate limits and fallbacks | MVP |
| Metrics | Counts matches started and finished, desyncs, AI errors and response times | MVP |
| Accounts | Sign-in and profiles | Launch |
| Move storage and signing | Cloud move library; re-checks speed caps and bone lengths, then signs each move | Launch |
| Matchmaking | Pairs strangers on skill and ping for quick match | Launch |
| Photo arena pipeline | SAM 3.1 finds floor, ledges and people; privacy pass; Muse Image restyle; outputs an arena file | Launch |
| Moderation | Muse Spark checks nicknames and taunt clips before strangers see them | Launch |

## AI gateway

Every call to Meta's Model API goes through the gateway, never straight from a phone, because the API key must stay secret. The game never waits on AI to start or finish a match.

| Call | Client sends | Meta model | Returns | If it fails |
| --- | --- | --- | --- | --- |
| Move name (MVP) | Slot, striking limb, height, peak speed, 3 small keyframe images of the stick man | Muse Spark | A name and a one-line description | A default name such as Heavy 2 |
| Match tips (MVP) | Per-move uses, hits, blocks, parries and misses; damage dealt and taken | Muse Spark | Exactly 2 tips, under 20 words each | No tips; results still show |
| Photo arena (launch) | The photo | SAM 3.1, then Muse Image | An arena file | Ask for another photo |
| Moderation (launch) | A nickname, or a taunt drawn as a short stick-man clip | Muse Spark | Allow or block | Block until checked |

**Rules**

- **Structured replies.** Every call asks for JSON in a fixed schema, using the Model API's [structured output](https://dev.meta.ai/docs/structured-output), so replies always parse.
- **Only stick men and numbers in the MVP.** No camera video or photos of players are ever sent.
- **Timeouts.** 5 seconds for names and tips, then the fallback.
- **Rate limits per player** (for example 30 move names a day) to cap cost; identical requests reuse the cached answer.
- **Prompts live in the gateway** with version numbers, so they can be tuned without shipping a new client.

## Security, privacy, cost and monitoring

- **Secrets.** The Meta API key lives only in the gateway. Everything runs over HTTPS and secure WebSockets.
- **Rooms.** Codes are long random strings, rooms hold at most 8 players, and empty rooms expire after an hour.
- **Relay hygiene.** Drops malformed messages, caps each player's message rate a little above 60 inputs a second, and closes a room when a phone sends inputs far ahead of the current frame.
- **Privacy.** The MVP stores no video, photos or skeletons. Loadouts pass through the relay in memory only, and logs hold room codes and nicknames, never move data.
- **Cost.** The MVP's main running cost is Meta API calls. Check Meta's [pricing page](https://dev.meta.ai/docs/pricing-rate-limits), measure cost per player in the beta, and set rate limits from that.
- **Monitoring.** A dashboard for matches started and finished, desync rate, relay delay, and AI response time and errors, with an alert when AI errors pass 5%.

## Week by week

| Week | Deliverables | Done when |
| --- | --- | --- |
| 1 | Contracts agreed with the client (see [Integration](04-integration-prd.md)); HTTPS hosting; rooms; a relay that echoes messages; AI gateway with canned answers | Two phones join one room from a link and see each other |
| 2 | Relay passing loadouts and inputs; ping; the netcode client with input delay and state hashes; live Meta AI move names | Two phones on the same Wi-Fi play a full match through the relay, and a new move gets a Meta AI name in under 5 seconds |
| 3 | Match tips, rate limits, fallbacks, metrics, staging deploy for playtests | 50 test matches with no desync or relay error, and every finished match shows tips or the fallback |

## Added at launch

- **Accounts and the cloud move library.** Sign-in; moves and loadouts stored per player, so a cleared browser loses nothing.
- **Move validation and signing.** Re-check speed caps and bone lengths, then sign each move so clients can't edit move data.
- **Quick match.** Pair strangers on skill rating and ping, with more relay regions as players spread out.
- **Rollback netcode.** Replaces input delay in the netcode client; the relay itself doesn't change.
- **Photo arena pipeline.** Photo, then SAM 3.1 (floor, ledges, people), the privacy pass (remove people; blur faces, plates and screens), a Muse Image ink restyle, and finally an arena file. Friends-only sharing; under 2 minutes end to end.
- **Moderation, reports and blocks.** Muse Spark checks nicknames and taunt clips; reports are stored and blocks enforced.
