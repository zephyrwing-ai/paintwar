# game-3d-multiplayer starter (three.js + relay and referee WebSocket server)

A complete, small online 3D game: **Ring Out**. Two to four players roll balls on a round arena and
try to push each other off the edge. The last ball on the arena takes the point. First to 3 points
wins, and a rematch starts 5 seconds later. Visitors after the fourth watch. It exists to be
*changed*: the engine and network layers are fixed scaffolding, and the game layer and the referee
rules are the parts you rewrite.

Each browser owns its own ball. It applies input, moves the ball, resolves its side of every
contact and draws the scene at once, then publishes the result as a `pose`. The server
`server/authoritative_server.mjs` does no physics. It relays poses and contacts, and it alone
decides the outcome from those reports: rounds, ring-outs, points, the match winner and the rules.

```bash
pnpm install
pnpm --dir server install   # once: the server has its own lockfile
pnpm dev:server             # relay and referee on ws://127.0.0.1:8787/ws (PORT overrides 8787)
pnpm dev                    # client; set GAME_MULTIPLAYER_SIGNALING_URL first (see below)
pnpm build                  # typecheck + production build + JS/font budgets
pnpm test                   # client unit tests (protocol, own ball, remote balls, save, i18n, tuning)
pnpm test:server            # server protocol tests on an isolated port
pnpm smoke                  # after build: headless players in one room; p1 pushes p2 out, then p3 joins
```

## Run players locally

1. Start the server with the Vite page origin allowed (default port 3000):
   `ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000 pnpm dev:server`. It prints one JSON
   line with the bound port. Without that variable the server accepts only same-origin pages, so
   it rejects the Vite page and the client keeps reconnecting.
2. Put `GAME_MULTIPLAYER_SIGNALING_URL=ws://127.0.0.1:8787/ws` in `.env.local` (not committed), then
   start or restart `pnpm dev`. The Vite dev server serves that endpoint as
   `/multiplayer/bootstrap.json`. Builds never include it.
3. Open the game, press **Play Online**, then **Copy invite link**. Open the link in a second window
   or browser, side by side: a hidden tab stops sending its ball, and the server puts a seat that is
   silent for 3 s out of the round. The first four visitors are P1 to P4, later visitors watch. A round starts when two
   players are connected; a player who joins during a round plays from the next round.

Without a configured endpoint the title screen still works and **Play Online** reports that online
play is not configured. A Manus cloud Preview cannot reach a loopback server: test cloud sessions
against a deployed `wss://` server whose `ALLOWED_ORIGINS` includes the Preview origin.

## Deploy

Deploy only `server/` (source, `package.json`, `pnpm-lock.yaml`) as a separate Node 22+ service behind
a public `wss://<host>/ws` endpoint. `server/README.md` owns its environment and limits; the Game
Skill's shared multiplayer guide (`game-multiplayer.md`) owns hosting and acceptance. Then:

1. Write the endpoint into `public/multiplayer/bootstrap.json` as `signalingUrl`. Published clients
   accept only `wss://` URLs with the path `/ws`.
2. If the client is published on a different origin than the server, add that exact origin to the
   server's `ALLOWED_ORIGINS`.
3. Build and publish the client, then test with two browsers on the published URL.

`build` in `bootstrap.json` and `BUILD` in `src/net/protocol.ts` must equal the server's `MARKER`
(`ring-out-v2`). Change all three together when the protocol changes, and deploy the matching
server and client together.

## Layout

| Path | Role | Change it? |
| --- | --- | --- |
| `server/authoritative_server.mjs` | Rooms, seats, pose and hit relay, referee, rules | Yes: outcome rules live here |
| `src/net/protocol.ts` | `ring-out-v2` message types and strict decoding | When the protocol changes |
| `src/net/connection.ts` | Bootstrap fetch, socket lifecycle, retry | Rarely |
| `src/net/session.ts` | Room code, `?room=` invite link, per-tab resume token | Rarely |
| `src/game/localBall.ts` | `OwnBall`: input, movement and contacts of the own ball | Yes: movement lives here |
| `src/game/balls.ts` | `RemoteTrack` (other balls in present time), ball meshes, rolling, fall | Yes |
| `src/game/game.ts` | Own-ball steps, contacts, server events → effects, sound and HUD | Yes |
| `src/game/arena.ts`, `fx.ts` | Arena, particles | Yes |
| `src/game/camera.ts` | Camera behind each seat, screen → arena input mapping, shake | Yes |
| `src/game/config.ts`, `tuning.ts` | Presentation and smoothing values, cosmetic Tweak controls | Yes |
| `src/main.ts` | Boot, connection wiring, 30 Hz pose sending, hits, 1 Hz ping | When adding messages |
| `src/engine/*` | Loop, renderer, input, audio, save, i18n, assets | Rarely |
| `src/ui/`, `src/styles/main.css` | HTML/CSS title, HUD, in-match menu, settings, touch stick | Yes |
| `src/i18n/*.json` | All player-facing text (both files, same keys) | Yes |
| `public/multiplayer/bootstrap.json` | Public server endpoint for published builds | On deploy |

## Protocol `ring-out-v2`

| Message | Direction | Fields |
| --- | --- | --- |
| `welcome` | server → client | `marker`, `room`, `role` (`p1` to `p4`, or `spectator`), private `resume_token`, `rules`, `spawn` |
| `room` | server → client, when something changes | `seq`, `round`, `phase`, `phase_ends_in_ms`, `seats.p1`…`p4` (`connected`, `playing`, `out`, `score`), `winner`, `event` (`seq`, `kind`, `seat`) |
| `pose` | client → server at 30 Hz during `live`, and at once after a contact or the edge | `seq` (increasing), `round`, `x`, `z`, `vx`, `vz`, `lat` (own one-way latency, ms) |
| `pose` | server → other clients, at once | the same fields plus `seat` |
| `hit` | client → server → the hit ball's owner | `to` (sent) or `seat` (received), `round`, `jx`, `jz` (impulse for that ball) |
| `ping` / `pong` | client ↔ server, 1 Hz | `t`; the client measures its latency from the round trip |
| `error` | server → client | `marker`, `room`, `code: "invalid_message"` |

Phases: `waiting` (fewer than two players) → `countdown` (3 s) → `live` → `point` (1.5 s) after the
round, or `ended` (5 s) after a win, then a fresh match. Event kinds: `round`, `ringout` (a ball left
the arena), `point` (the last ball standing scores; empty `seat` means nobody), `match`. Coordinates
are metres on the arena plane: centre (0, 0), radius 10, ball radius 0.8. Spawns: P1 at z = +4, P2 at
z = −4, P3 at x = +4, P4 at x = −4. Close code `4001` means another tab resumed the same seat. Close
code `1013` means the room already has eight spectators. The client stops retrying after either code.

## How movement stays smooth

- **Own ball, no wait.** `OwnBall` runs at 60 Hz in the fixed-step loop. Input moves it at once; no
  server round trip sits between a key press and the ball.
- **Other balls in present time.** `RemoteTrack` projects the last relayed pose forward by its age
  (sender latency + own latency + time since receipt, at most `net.maxLead`). A new pose moves the
  estimate at once, and the drawn ball fades the jump out over `net.smoothTime`. The jump is measured
  between the old and new estimate at the same instant, so normal movement is never treated as error.
  A jump longer than `net.snapDistance` (one ball diameter) is applied at once instead of faded, so a
  large error does not slide the ball across the arena.
  Balls are drawn where they are now, not 100 ms in the past. Only a round's spawn moves them without a fade.
- **One contact, applied once.** The client that detects a contact first applies its own half of
  the impulse and sends the other half as a `hit` to the owner of the other ball. That owner applies
  it. If both owners detect the same contact, each applies only its own half and ignores the other's
  `hit`. The window per pair is at least `HIT_WINDOW` (0.25 s) and grows to the measured
  client-to-client round trip.
- **Optimistic fall, server verdict.** A ball that crosses the edge holds that pose and starts
  falling at once on its owner's screen and, from its pose, on every other screen. The server's `ringout`, `point` and
  `match` events are the only source of score and winner.

## Trust model

The referee trusts each client's report of its own ball within bounds: position at most arena
radius + 4, speed and hit impulse at most 2 × max speed, increasing `seq`, the current `round`, and
at most 90 messages per second. It relays a `hit` only between balls whose last poses are within
reach, at most once per pair every 150 ms. A modified client can still move its ball anywhere within
14 m of the centre from one pose to the next, refuse to fall, or push a nearby ball harder than the
rules allow. If it stops sending poses, the server puts it out after 3 s. This is acceptable for a
casual game. For competitive play, move movement and contacts
to the server and accept the input round trip.

## Rules for changes

- **Outcome rules go in the server.** Round, point and win rules live in `checkRoundEnd()` and
  `pose()` in `server/authoritative_server.mjs`. Never score or end a round on the client.
- **Movement rules go in `welcome.rules`.** Acceleration, damping, speed cap, ball and arena radius
  and restitution are defined once in the server and sent in `welcome.rules`. Every client runs the
  same `integrate()` and `touch()` in `src/game/localBall.ts` with those numbers. Add a new rule to
  both the server constants and `validRules()` in `src/net/protocol.ts`.
- **New actions** (for example a dash): apply them to `OwnBall` and set `urgent` in `game.ts`, so
  the next `pose` goes out at once. If an action affects another ball, send it like `hit`, and add a strict
  validator and a relay to the server.
- **Every visible string is an i18n key** in both `en.json` and `zh-CN.json` (a test enforces
  matching keys and placeholders). English and Chinese use the bundled Manus CC0 fonts.
- **UI is HTML/CSS**, not canvas. Menus stay keyboard/gamepad navigable (`data-nav`). Opening the
  menu never pauses the match, because the other players keep playing.
- Keep `pnpm build` within the JS/font budgets, and keep `pnpm test`, `pnpm test:server` and
  `pnpm smoke` green.

## Controls

Keyboard: WASD or arrow keys roll, Esc opens the menu. Gamepad: left stick rolls, Start opens the
menu. Touch: drag anywhere on the screen. "Up" always rolls toward the arena centre, because each
player's camera sits behind their own spawn.

## Credits

Fonts: ManusCC0 (regular, medium, bold) and ManusCC0 Sans CJK SC — CC0 1.0. See
`public/fonts/ManusCC0-LICENSE.txt`. Libraries: three.js (MIT), ws (MIT).

## Preview Tweak

`src/game/tuning.ts` is this game's parameter manager. The server owns every movement and outcome
rule and sends it in `welcome.rules`, so the catalog exposes only `LIVE` `COSMETIC` camera controls.
Do not add gameplay controls to the client: a value on one client would make its ball follow
different rules from the others. Register through
`scripts/manus-tuning/adapter.js` only under `import.meta.env.DEV`, and keep the Vite plugin and
`scripts/__manus__/` helpers intact; production builds exclude the browser adapter.

Apply changes preview state only. Do not mutate the source defaults or persist Apply to
localStorage. Save with Manus checks the snapshot against the current catalog and edits
`DEFAULT_CONFIG`, then uses the normal Three.js Web build/checkpoint workflow.

The preview plugin reads the ignored `.manus-webdev/preview-identity.json` v1 projection written by
the Runtime when initializing, attaching or restoring this project. Missing identity disables the
bridge.
