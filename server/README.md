# Ring Out relay and referee service

This directory owns Ring Out's protocol and executable service. It is deployed separately from the
static client; installing this template does not provision a computer or start the service. Hosting
and acceptance are owned by the Game Skill's shared multiplayer guide (`game-multiplayer.md`).

- Node 22+, pinned pnpm dependencies: `pnpm install --frozen-lockfile --prod`.
- Run `HOST=127.0.0.1 PORT=8787 node authoritative_server.mjs` after verifying the chosen port.
  `PORT=0` picks a free port; the first stdout line is JSON with the bound `port`.
- `ALLOWED_ORIGINS` is a comma-separated list of exact browser origins permitted in addition to the
  same-origin deployment. Origin checks are not account authentication.
- Optional `STATIC_ROOT` serves a complete built client (default `../dist`). Server source and private
  configuration must never be placed in the static root.
- `GET /healthz` reports process availability. `/ws?room=ABCD` connects a client. Room codes are 4–8
  ASCII letters/digits and public invitations; this reference does not implement private rooms.

## Protocol: ring-out-v2

This service does no physics. Each client simulates its own ball and publishes it. The service
relays poses and contacts, and it alone decides rounds, ring-outs, points and the match winner.

`welcome` contains `marker`, `room`, `role` (`p1` to `p4`, or `spectator`), a private
`resume_token`, `rules` (`arena_radius`, `ball_radius`, `accel`, `damping`, `max_speed`,
`restitution`, `win_score`) and `spawn` (`p1` to `p4`, each `x`, `z`). Every client moves its ball
with these numbers. Reconnect adds the token as `resume` to the same endpoint and room. Do not log
request queries or share this token. A resumed seat closes the previous socket with code `4001`.

`pose` from a client has `seq`, `round`, `x`, `z`, `vx`, `vz` and `lat` (the sender's one-way
latency in ms). The service accepts it only from the seat's current socket, during `live`, for the
current `round`, from a seat that is still in play, with a strictly increasing safe-integer `seq`,
finite values, `|x, z|` at most arena radius + 4, `|vx, vz|` at most 2 × max speed and `lat` from 0
to 1000. It relays a valid pose at once, with `seat`, to every other player and spectator, and it
keeps the latest pose per seat for late joiners. Invalid poses are dropped without a reply.

`hit` from a client has `to` (a seat), `round`, `jx` and `jz`: the impulse that the owner of `to`
must apply after a contact. The service relays it, with the sender as `seat`, only to that owner,
when both seats are in play, the round matches and `|jx, jz|` is at most 2 × max speed. The two
balls' last poses must also be within reach: at most two ball radii plus 1 m apart, plus the
distance each ball can move at its reported speed since its pose. The service relays at most one
hit per pair every 150 ms. It does not simulate the contact.

`ping` with a numeric `t` gets `pong` with the same `t`, so clients measure latency without clock
synchronization.

`room` is sent when something changes. It contains a monotonically increasing `seq`, `round`,
`phase` (`waiting`, `countdown`, `live`, `point`, `ended`), `phase_ends_in_ms`, `seats.p1` to `p4`
(`connected`, `playing`, `out`, `score`), `winner` and `event` (`seq`, `kind`, `seat`). Event kinds
are `round`, `ringout`, `point` and `match`. `error` carries the same marker and room with the
stable code `invalid_message`.

## Referee rules

A round needs two connected players and starts after a 3 s countdown. Players who join during a
round play from the next round. The first valid pose of a ball with its centre beyond the arena
radius (10 m) puts that ball out (`ringout`). A player who disconnects, or resumes the seat from a
new page, during a round is out of that round. A playing seat that sends no pose for 3 s is also out
of the round, without a `ringout` event; a hidden browser tab stops sending. When at most one ball
is left, that ball's seat scores 0.25 s later (`point`), unless that ball also goes out first. If
no ball is left, nobody scores. The next round starts 1.5 s after a point. A seat that reaches 3 points wins (`match`), and a
new match starts 5 s later. When fewer than two players stay connected, the round is void and the
room waits.

Trust model: the referee trusts each client's report of its own ball within the bounds above. A
modified client can move its ball anywhere within 14 m of the centre from one pose to the next,
refuse to fall, or push a ball within reach harder than the rules allow. This is acceptable for a
casual game, not for ranked play.

Disconnected seats are reserved for 60 seconds. Empty rooms expire after ten minutes. Process
restart loses rooms and scores. Capacity is bounded to 128 rooms, 256 connections and eight
spectators per room (close code `1013` when full). Messages have a 4096-byte limit and a
90-message/s ceiling. Slow clients and missed heartbeats are disconnected. This is a bounded MVP,
not internet-scale matchmaking, persistent identity, ranked play or DDoS protection.

## Checks

`pnpm test` starts an isolated process on port 0 and verifies four seats, spectators, room
isolation, pose and hit validation and relay, the referee, reconnection and the Origin allowlist.
`pnpm test:e2e -- wss://VERIFIED_HOST/ws` targets an explicitly chosen service, creates a temporary
room, and checks that a pose past the edge from p2 gives p1 the point on both clients.
