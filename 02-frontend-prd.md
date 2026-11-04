# Frontend PRD: game client

Part of the SticXcape PRD set: [Product](01-product-prd.md) · **Frontend** · [Backend](03-backend-prd.md) · [Integration](04-integration-prd.md)

## Scope

The game client is the phone web app: everything players see, touch and hear, plus the fight simulation itself, which runs on both phones. It carries most of the MVP's work; the services stay thin.

**Owns**

- Recording moves: camera, MediaPipe tracking, cleanup and the move library on the phone.
- The fight: simulation, on-screen controls, practice bot, rendering, effects, sound and vibration.
- Every screen, from opening the invite link to the results and rematch.

**Doesn't own**

- Room links, the relay and every call to Meta's Model API: these run in the services, because the API key can't live on a phone.
- Online play end to end, including the client's netcode module: the backend owner takes it to balance the workload (see [Integration](04-integration-prd.md)).
- The data formats and messages both sides use: these are fixed in [Integration](04-integration-prd.md).

**Requirements covered** (IDs from the [product PRD](01-product-prd.md))

- MVP: MS-1 to MS-7, CB-1 to CB-5, GF-1 to GF-3, AR-1 to AR-3, LS-1 to LS-8, and the screens for MP-1, MP-4 and MP-5.
- Launch: MS-8 to MS-10, CB-6 to CB-9, GF-4, GF-5, LS-9 to LS-12, and the screens for photo arenas and quick match.

## Progress

Updated 2026-11-04. The code is in `apps/client` on the `frontend-mvp` branch. 15 client tests pass, and two full online matches between the browser and a Node bot ran through the relay with 194 state checks and no desync. Nothing has been tried on real phones yet.

| Module | Status | Code |
| --- | --- | --- |
| Camera and tracking | Written: MediaPipe Pose Landmarker 0.10.21 loads from the CDN only when Move Studio opens; GPU with a CPU fallback; HTTPS and permission errors explained. Not yet run against a real camera | `src/capture` |
| Move Studio | Tried in a browser with demo takes: slot picker, consent and safety card, framing checks, 3-2-1, up to 5 takes with the cleanest flagged, trim, mirror, speed (MS-8), retake, save, Meta AI name | `src/screens/studio.ts` |
| Cleanup | Tested on noisy synthetic takes: 60 fps resampling, gap filling, facing, side-swap repair, per-joint smoothing, fixed bone lengths, grounding, foot locking, speed cap, auto-trim, stance blending, striking limb, active frames and height. About 8 ms per take on a laptop | `src/moves/cleanup.ts` |
| Move library | Written: IndexedDB with an in-memory fallback; default moveset of 9 keyframed moves in the real move format | `src/moves` |
| Fight engine | Tested: Q16.16 only, 60 Hz, capsule hits from limb paths, block, parry, high/mid/low, slot power, armor, counter-hits, combo scaling, swing-direction knockback, launches, knockdowns, rounds, state hash. 0.005 ms a frame on a laptop | `src/engine` |
| Practice bot | Tested: easy, normal and hard, with reaction delay; blocks, parries, punishes, combos | `src/engine/bot.ts` |
| Renderer | Tried in a browser: ink stick men, 2 painted arenas with parallax, camera dolly, shake, zoom punch, sparks, ink bursts, shield arcs, parry rings, trails, smears, dust, squash and stretch, KO ragdoll with an inverted frame and slow motion | `src/render` |
| Audio and vibration | Written, not yet checked by ear: every sound synthesized; layered impacts, whooshes from limb speed, parry clang, footsteps, stingers, fight and menu music with ducking and a final-round layer; vibration patterns for Android | `src/audio`, `src/app/haptics.ts` |
| Screens | Tried in a browser, including at phone size: title, nickname, record or skip, home, Move Studio, loadout, room, fight, results with stats and coach tips, settings with comfort sliders (GF-5) | `src/screens`, `src/ui` |

**Decisions settled in code.** The move format belongs to the frontend, so the backend owner should review these:

- Each joint angle turns the bone that ends at that joint, relative to its parent bone. The pelvis angle turns the whole body. World angle 0 points up and a quarter turn points forward; moves face forward. Root x is the forward offset from the move's start and root y the pelvis height above the floor, both in millimetres. Bone lengths are in `src/engine/skeleton.ts`.
- Phones always send a full nine-move loadout in this order: light, light 2, heavy, heavy 2, low, special, defense, taunt, victory. Missing places are filled with the default moveset, which both phones generate identically.
- Arena ids are `rooftop` and `dojo`: 10 m wide, fighters start at 3.6 m and 6.4 m.
- Light hit stun is 17 frames rather than 12, so a light hit can cancel into a heavy (14-frame startup). Light hit stop is 4 frames.
- Light 2 and Heavy 2 are a direction plus L or H; Low is down plus H; Taunt is down plus D; a double tap dashes.

**Still to do:** a real camera on real phones (iPhone Safari, Android Chrome), listening to the mix, live Meta AI names with a key, and the launch items not started: grabs, stamina and guard meters, ring-outs and ledges, active-ragdoll hit reactions, photo arenas, the cloud move library and quick match.

## Modules

The client is ten modules in one TypeScript web app. The fight engine is the heart: it never touches the screen, the network or the clock, so it can be tested alone and gives the same result on every phone.

| Module | What it does | Built on | Phase |
| --- | --- | --- | --- |
| Camera and tracking | Opens the camera in landscape and tracks 33 body points live | MediaPipe Pose Landmarker (web) | MVP |
| Move Studio | Slot picker, countdown, up to 5 takes, trim, retake, save | Own code | MVP |
| Cleanup | Per-joint smoothing, foot locking, 17-joint stick skeleton, fixed bone lengths, speed cap, start and end at the stance | Own code | MVP |
| Move library | Stores moves on the phone and ships the default moveset | Browser storage (IndexedDB) | MVP |
| Fight engine | Deterministic 60 Hz simulation: movement, hitboxes from limb paths, block, parry, high/mid/low, slot power, knockback, rounds | Own code, fixed-point maths | MVP |
| Practice bot | Rule-based opponent using the default moveset | Own code | MVP |
| Renderer | Stick men, arenas, camera, effects (sparks, trails, smear frames, dust, flashes) and the HUD | Canvas 2D or WebGL | MVP |
| Audio and vibration | Motion-driven sounds, music loop, mute; hit vibration on Android | Web Audio API, Vibration API | MVP |
| Screens | Title, nickname, Move Studio, loadout, room, fight, results | Own code | MVP |
| Netcode client | Sends and receives inputs, applies the input delay, checks state hashes | WebSocket | MVP, owned by the backend owner |

Rollback netcode at launch replaces only the netcode client. Building the fight engine deterministic from day 1 keeps that swap cheap.

## Screens and flow

A new player goes from an invite link to a finished fight in seven screens:

1. **Open the link.** The web app loads in Safari or Chrome. In portrait, a rotate-your-phone prompt shows.
2. **Tap to start.** Unlocks sound. First-time players pick a nickname and allow the camera.
3. **Record or skip.** New players record their 4 moves in Move Studio, or start with the default moveset.
4. **Home.** Practice against the bot, create a room, or join from a link.
5. **Room.** Both players and their loadouts; the host picks the arena; both tap Ready.
6. **Fight.** Best of 3 rounds, 60 seconds each.
7. **Results.** Winner, per-move stats and 2 Meta AI tips, then Rematch or Edit moves.

**Inside Move Studio:** pick a slot, line up side-on inside the outline guide, 3-2-1 countdown, perform, watch the stick-man replay, trim or retake, save. Meta AI then suggests a name the player can keep or change.

## Technical rules

### Deterministic fight engine

Both phones must compute exactly the same fight from the same inputs, or online matches drift apart.

- Integer or fixed-point maths only, with the engine's own sine and square-root tables. Never call the browser's maths functions (such as sine or square root) inside the simulation: JavaScript engines may return slightly different results on different phones.
- A fixed 60 Hz step, a seeded random generator, and nothing that depends on frame rate, wall-clock time or the renderer.
- Rendering reads the simulation and draws between its frames; the simulation never reads anything back from the screen.

### Performance budget (mid-range phone)

| What | Budget |
| --- | --- |
| Fight frame rate | 60 fps |
| Simulation per frame | Under 2 ms |
| Tracking preview delay | Under 100 ms |
| Cleanup of a 3 s clip | Under 10 s |

The tracking model loads only when Move Studio opens, so the fight screens start fast. Test on at least one older iPhone and one mid-range Android from around 2021, in Safari and Chrome.

### Phone-browser limits

- **The camera needs HTTPS** (localhost is the only exception), so even test builds on phones must be served over HTTPS.
- **Sound waits for the first tap**, which is why the title screen says tap to start.
- **iPhones can't vibrate from a browser.** Vibration runs on Android only until a native app exists.
- **Landscape can't be locked reliably** in phone browsers, so show a rotate prompt. Adding the app to the home screen hides the browser bars.
- **Safari can delete a site's stored data** after about a week without a visit, so iPhone players could lose recorded moves. Ask players to add the app to the home screen; the cloud move library fixes this at launch.

## Week by week

Each week ends with the same check as the product PRD's roadmap.

| Week | Deliverables | Done when |
| --- | --- | --- |
| 1 | Camera and tracking, Move Studio, cleanup, stick-man replay, move library, default moveset | 8 of 10 friends record a move they like in under 10 minutes |
| 2 | Fight engine, on-screen controls, practice bot, renderer and effects, sound, vibration | Testers rate hit feel 4 out of 5 or higher, and one input log gives the same result on an iPhone and an Android phone |
| 3 | Room and results screens, Meta AI names and tips on screen, second arena, polish | Friends play 10+ online matches across iPhone and Android with no desync |

## Added at launch

- 8-move loadouts with mirror and speed adjust, jitter tips and the physics check.
- Grabs, stamina and guard meters, knockdowns with active ragdoll, ring-outs, and light and heavy traits on the move card.
- Sign-in and the cloud move library, so moves survive a cleared browser.
- Photo arenas: taking the photo, showing progress, drawing the result.
- Quick match, combo scaling, comfort settings, volume sliders, stereo panning and final-round music.
