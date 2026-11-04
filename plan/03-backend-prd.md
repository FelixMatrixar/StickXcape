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

Updated 2026-11-04. Backend work is on the `backend-mvp` branch, restarted from `main` after PR 1 merged the backend with the game client. 280 automated tests pass and live Meta AI calls work, but nothing has been tried on phones or deployed yet. Built for launch: rollback netcode, passkey accounts with a cloud move library, quick match with signed moves and nickname checks, and sharing photo arenas, plus reports from friend rooms. The frontend makes photo arenas and sends reports already; the rest waits for it to switch them on (steps below).

| Deliverable | Status | Code |
| --- | --- | --- |
| Shared types package: move and arena files, room messages, HTTP API, button bits, input-delay rule, fixed-point maths | Tested. Two maths changes for the frontend owner: `fixedSin` gives 0 rather than -0 at a half turn, and its error bound is documented as under 2/65536 (it was stated as 1, measured 1.7) | `packages/shared` |
| Web hosting | Tested: serves the web app, invite links, a test page and the relay lab. HTTPS comes from the host or a local tunnel | `services/server/src/web` |
| Rooms | Tested: create, look up, 8-player cap, host hand-over, empty rooms expire after an hour | `services/server/src/rooms` |
| Relay | Tested over real WebSockets: lobby, loadout and input passing, ping and input delay, desync and result checks, malformed-message drops, rate cap, input-ahead room close, winner stays on. Bots have played full matches and rematches through it | `services/server/src/relay` |
| AI gateway | Tested against a stand-in for Meta's API (structured output, reply cleanup, the cache, daily limits, one retry, the 4.5 s budget and the fallbacks), and live: 27 calls for names and tips, all with usable replies. It uses Muse Spark 1.1, which answered in 2.3 s (median of 6 calls, slowest 3.0 s). Muse Spark 1.3 took 3.3 s (median of 17, slowest 4.9 s, past the budget) at the same price, and its names and tips were no better. `minimal` is the lowest reasoning level Muse Spark accepts (it rejects `none`), so the server refuses to start with an unknown level | `services/server/src/ai` |
| Metrics and alert | Tested: Prometheus `/metrics`, an `/admin` dashboard, and an alert when AI errors pass 5% (optional Slack or Discord webhook) | `services/server/src/metrics` |
| Netcode client | Tested, with two fixes: the driver's first update could skip its frame, and the bad-network simulation could reorder messages | `packages/netcode` |
| Rollback netcode (MP-6, launch) | Tested in unit tests and in bot matches through the relay: 2 frames of input delay, and up to 8 frames played on a guess of the opponent's input and replayed when the guess was wrong. State hashes and the result go out only for final frames, and a phone that runs ahead of its opponent slows by 10% until they're in step. Matches through a simulated network end in exactly the state a clean replay of the same inputs gives. A match uses rollback only when both phones ask, so nothing changes for the current fight screen. The relay lab has a switch for it. Not yet tried on phones | `packages/netcode/src/rollback-driver.ts`, `session.ts` |
| Client mocks | Tested: a fake relay with an echo opponent, and canned AI names and tips | `packages/netcode` |
| Test page for phones | Written: create a room, open the link on a second phone, see each other | `services/server/public` |
| Relay lab (a toy match between two phones) | Written and tried in a browser against a bot: create a room, share the link, ready, fight, rematch. Shows ping, input delay, time spent waiting and the state checks | `services/server/lab` |
| Automated tests, bot matches, bad-network and load scripts | Written: 280 tests (contract, netcode, services, matches through the relay). `npm run bots` plays real-time bot matches with optional added delay and jitter, for the 50-match, bad-network and load checks; `--rollback` plays them with rollback netcode | `*/test`, `services/server/scripts` |
| Staging deploy (Docker, Fly.io) and CI | The Docker image is built and tried locally: 50 bot matches in a row, a slow network, 100 rooms, and a clean shutdown that tells phones to reload. Not deployed yet. `fly.toml` puts staging in Singapore (`sin`), nearest the playtesters. Before rollback, every CI step passed when run locally (153 tests then). Now typecheck, the 280 tests and the build pass locally, and CI also plays rollback bot matches at 200 ms more round trip. CI on GitHub caught one flaky quick match test, since fixed; its later runs haven't been checked from here. Staging deploys by hand and needs a Fly.io app, a `FLY_API_TOKEN` secret and the Meta key. Accounts live on a 1 GB Fly volume at `/data` (`DATABASE_FILE`), which the first deploy makes and Fly snapshots daily; passkeys are tied to `PUBLIC_URL`'s domain, so changing it later strands existing passkeys | `Dockerfile`, `fly.toml`, `.github/workflows` |
| Accounts and the cloud move library (MP-9, launch) | Tested against software passkeys (ES256, EdDSA and RS256) and tried in a browser with one, on localhost. Players sign up and sign in with a passkey; nobody has to, since guests keep their moves on the phone. The server checks passkeys with Node's own crypto: the challenge, origin and site, user verification (Face ID, fingerprint or PIN), the signature and its counter. Each sign-up or sign-in prompt can be answered once, within 5 minutes. A sign-in is an HttpOnly, SameSite=Lax cookie that lasts 180 days and renews when used; only a hash of it is stored. The library keeps up to 200 moves (idle stances included) with their description and quality, plus the loadout, in SQLite (`node:sqlite`, no new dependency). Deleting an account deletes everything. Passkeys need HTTPS with a domain name, or localhost, so the Wi-Fi address can't use them; staging can. The relay lab has an account panel. Not yet tried on phones | `services/server/src/accounts`, `packages/netcode/src/account.ts` |
| Quick match (MP-7), signed moves (MP-8) and nickname checks (launch) | Tested over real sockets, and tried in a browser against a bot on localhost with a live nickname check. A signed-in player asks the relay for a quick match; the relay reads the sign-in cookie when the socket opens. Players are paired on a hidden skill rating (Elo from 1000) and ping. Matching starts within 100 points and 100 ms between the phones, widens each second, and accepts anyone after 30 s. Each pair gets a private two-player room, so loadouts, rollback and rematches work as in friend rooms. A finished match moves both ratings, leaving one counts as a loss, and desyncs don't count. Quick match rooms take only moves the server has checked and signed. The checks are wide limits that catch hand-edited files (45 m/s for the body, a third of a turn a frame for a joint); every default move passes. Muse Spark checks each nickname before strangers see it: a blocked one is refused, and one it can't check shows as Challenger. Players can block each other (never matched again) and file reports (stored for review). Not yet tried on phones | `services/server/src/relay/matchmaker.ts`, `accounts/signing.ts`, `packages/shared/src/move-rules.ts` |
| Shared photo arenas (AR-4, AR-5, AR-7) and reports from friend rooms (launch) | Tested, and tried live with a real JPEG. The phone makes the arena itself (the frontend's privacy pass, ink restyle and layout), so the server only shares finished ones, in the shape the client already sends: `POST /arenas`, `GET /arenas/{id}`, its image, and `DELETE /arenas/{id}` from the phone that shared it. An arena keeps its own id, so `/a/{id}` is the same link on every phone. Before storing, the server checks the arena file, the palette, and that the JPEG is 160 to 2048 px a side and at most 1.5 MB. It also requires the arena's only art to be its own backdrop. Muse Spark then checks the name and looks over the backdrop once more (AR-5); in production nothing is shared unchecked. Live: a drawn room passed both checks in 4.4 s, and the same room with a name, address and phone number on the wall was refused for "readable personal info". `POST /reports` takes the results screen's reports by nickname. Reasons are now name, moves, cheating and other everywhere. Not yet tried on phones | `services/server/src/arenas/routes.ts`, `lib/multipart.ts`, `lib/jpeg.ts` |
| Other launch services | Not started: checking taunt and victory clips before strangers see them (it needs the server to draw the stick figure); photo arenas in online rooms (both phones would fetch the shared arena first); more relay regions; showing ratings (ranked, MP-11, comes later). A server-side photo pipeline (Segment Anything 3.1 and Muse Image) isn't needed while the phone's works | |

**Bot results so far** (one laptop; the network checks ran inside Docker, on Linux):

- 100 rooms at once (200 bots): all 100 matches finished with no desync or relay error. The relay held inputs under 0.2 ms (p99) and picked 3 frames of input delay for every match.
- Bad networks, 12 matches at each level with ±20 ms jitter, no desyncs: +50 ms round trip between the phones picked 3 frames and the phones never waited; +100 ms picked 4 to 5 frames and they waited 0.5% of the time; +150 ms picked 6 frames and they never waited.
- Run these checks in Docker or on Linux. Windows timers tick every 15.6 ms, which stretches the bots' added delays, and Docker Desktop's port forwarding on Windows raised round trips to 40 ms under load. The relay's own hold stayed under 0.2 ms either way.
- Rollback against input delay, 4 matches each at +200 ms round trip ±20 ms (on Windows, so about 240 ms between the phones): rollback played with 2 frames of input delay, rewound at most 7 frames and never waited, with no desyncs. Input delay on the same network needed its 6-frame maximum (100 ms) and still waited 28.6% of the time. The toy bots change buttons often, so rollback replayed 1.7 frames for every new one; the fight engine's 0.005 ms a frame makes that negligible.

**Week checks.** Week 1 ("two phones join one room from a link and see each other") is ready to try with the test page. For week 2, the relay half is ready to try on two phones with the lab at `/lab/`, and live Meta move names arrive in 2 to 3 seconds, inside the 5-second target. For week 3, CI runs the 50-match and slow-network bot checks, and staging needs the Fly.io setup in `fly.toml`.

**Contract details settled in code.** The [Integration PRD](04-integration-prd.md) left these open, so the frontend owner should review them:

- The relay answers `join` with `joined` (player, host, room), sends lobby changes as `room`, and sends failures as `error` (code, message).
- `start` also carries `fighters` (left, then right) and `arenaId`. The relay's `end` adds a `reason`: finished, desync, disconnect or room_closed.
- The 4 stick bits are up, down, left and right on screen; then L, H, S, D and Block.
- `stateHash` is an unsigned 32-bit number, sent after frames 0, 60, 120 and so on.
- The ping in the input-delay rule is the round trip between the two phones through the relay. Each phone's part is the median of its last 5 round trips to the relay. Before a phone's first match, the relay pings it a few more times, so a match can take up to 1 s to start after both tap Ready.
- Move frames are 19 little-endian int16 values each: root x and y in millimetres, then 17 joint angles in 1/65536 of a turn. The move hash covers a fixed JSON array of the hashed fields.
- `POST /ai/move-name` takes the 3 images as `keyframes` (PNG or WebP data URLs). Phones send a random id in `X-Player-Id` for per-player limits, and both AI calls answer 429 once the daily limit is hit.
- Room codes are 16 characters, invite links are `/r/{code}`, and the first player to join hosts.
- Rollback: `ready` may carry `rollback: true`. When both fighters send it, `start` has `rollback: 8` and 2 frames of input delay (more only past about 260 ms between the phones); otherwise `rollback: 0` and the usual input delay. Rollback matches add a `sync` message (`lateness`, in frames), which each phone sends once a second and the relay passes to the other.
- `LockstepSession` is now `MatchSession`, which runs both kinds of match. The old name still works, so existing code needs no change.
- Quick match: `quickmatch` (nickname) starts a search, `cancelmatch` stops it, and `leave` leaves a room while keeping the socket. The relay answers `queued`, then `joined` and `matched` (the opponent's account id and nickname). New error codes: `not_signed_in`, `nickname_blocked`, `unsigned_move` and `quick_match_unavailable`.
- A move's `signature` is `v1.` followed by the server's keyed hash of the move hash. The key is kept with the accounts, so signatures outlast restarts; any edit to a move needs a new one.

**Turning on rollback in the fight screen.** The frontend owns this switch; the netcode side is ready.

1. Create the `RelayClient` with `{ rollback: true }`, or set `client.rollback = true` before `ready()`.
2. When `session.rollback > 0`, run the fight with `RollbackDriver` instead of `LockstepDriver`. Its hooks are `sampleInput`, `simulate(inputs, frame, replay)`, `save`, `load` and `stateHash`; `FightSim.save()` and `load()` fit as they are.
3. Put anything the screen decides from the fight into the save, such as the frame the match was decided on. Report the winner only once `session.confirmedFrame` reaches that frame: a guess can decide a fight that a late input then undoes, and phones that disagree end the match as a desync. `ToyMatch` in `packages/netcode` shows the pattern.
4. On a replayed frame (`replay` true), skip sounds and effects that the first run already played for that frame, but play new ones, such as a hit the guess missed.
5. Draw once per animation frame after `update()`, not inside `simulate`, so a rewind is never seen.

**Turning on accounts in the game.** Also the frontend's switch; the services and `AccountClient` are ready.

1. In development, add `'/account': SERVICES` to the Vite proxy, so the sign-in cookie stays on the game's own origin.
2. Show account features only when `passkeysSupported()` and `(await accounts.status()).passkeys` are both true. Off HTTPS (the Wi-Fi address) they're false, and the game plays as before.
3. Sign up with `accounts.createAccount(nickname)` and sign in with `accounts.signIn()`. A cancelled passkey prompt rejects with the browser's `NotAllowedError`.
4. After signing in, merge the libraries once with `getLibrary()`. Upload phone moves the cloud lacks with `saveMove` (the IndexedDB `StoredMove` fields map one to one; `kind: 'idle'` for the idle stance), and add cloud moves the phone lacks. While signed in, save each new or changed move and delete removed ones. `saveLoadout` takes the existing `LoadoutSelection` as it is.
5. Settings: sign out, and delete the account. After deleting, tell players they can remove the passkey in their phone's password settings.

**Turning on quick match in the game.** Also the frontend's switch; it needs accounts on first.

1. Open the relay socket after signing in (or reopen it), so it carries the sign-in cookie.
2. Sign the full nine-move loadout, defaults included, with `accounts.signMoves(loadout)`. Run `moveRuleProblem` from the shared package first to warn about a move before the server refuses it.
3. Call `client.quickMatch(nickname)` and show a searching state on `queued`. On `matched` the phone is already in a two-player room: send the signed loadout and ready as usual. `cancelQuickMatch()` stops a search.
4. After a match, offer Rematch (both ready again), and Find another (`client.leave()`, then `quickMatch` again).
5. On the results screen, offer Block and Report for `client.opponent.id` (`accounts.blockPlayer`, `accounts.reportPlayer`).
6. Show the refusals: not signed in, nickname blocked (pick another), unsigned move (sign again), and quick match unavailable.
7. Offline, `createFakeRelay` answers a quick match with Echo at once, for building these screens.

**Photo arena sharing and room reports are live in the backend.** The client already calls them; three small changes finish the job.

1. In development, add `'/arenas'` and `'/reports'` (and `'/account'`) to the Vite proxy.
2. When a player deletes a shared arena, or uses Delete my data, send `DELETE /arenas/{id}` with the same `X-Player-Id`, so the shared copy goes too.
3. Show the server's refusals: `name_blocked` (rename it), `image_blocked` (its message says what Muse Spark saw), `check_unavailable` (try again later), `too_many_arenas` (30 per phone) and `too_many_shares` (10 an hour per network).

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

- **Accounts and the cloud move library.** Built with passkeys (see Progress): moves and loadouts stored per player, so a cleared browser loses nothing.
- **Move validation and signing.** Built with wide limits (see Progress). The engine's exact checks (17 m/s at a fist or foot, human joint ranges) can join them once they move from the client's cleanup into the shared package. Bone lengths can't be edited: moves store only angles.
- **Quick match.** Built for one region (see Progress); more relay regions as players spread out.
- **Rollback netcode.** Built (see Progress). It runs alongside input delay and is picked per match; the relay only sets the input delay and passes a once-a-second sync message.
- **Photo arena pipeline.** Photo, then SAM 3.1 (floor, ledges, people), the privacy pass (remove people; blur faces, plates and screens), a Muse Image ink restyle, and finally an arena file. Friends-only sharing; under 2 minutes end to end. The frontend built this on the phone instead, so the photo never leaves it; the backend shares finished arenas and checks them once more (see Progress). A server-side SAM 3.1 and Muse Image version stays an option if the phone's results fall short.
- **Moderation, reports and blocks.** Built for nicknames, arena names and backdrops, reports and blocks (see Progress). Taunt and victory clips still need checking before strangers see them, which needs the server to draw the stick figure for Muse Spark.
