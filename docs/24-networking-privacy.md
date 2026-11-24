# 24. Networking and privacy

Accepted encoding direction and candidate field precision (#1093) are in
[24.1](24.1-wire-encoding-design.md), with measurements in
[42.47](42.47-wire-encoding.md). The backend is selected: the descriptor codec D (24.1,
[42.54](42.54-field-typed-codec.md)). Live adoption (#1131) is staged (24.1 "Adoption status"). Since stage 2 the server writes each connection's `state` messages as D's bytes unless the connection negotiated the JSON debug encoding ([State encoding](#state-encoding)); every other message, inputs included, stays JSON. Stage 3 (`WIRE_VERSION = 6`) closed the schema: match constants travel with the map, "none" is absent, unread fields left, and every state names its roster revision ([Schema closure](#schema-closure)). The lossy-transport delta design (#1094)
is [24.2](24.2-lossy-transport-deltas.md), implemented under #1095 (24.5 stage 3). The per-field data model of the
live state, and the engine-side choices that shape a typed wire, are in
[24.3](24.3-wire-data-model.md) (historical inventory and remaining proposals). The implemented relational data strategy,
static geometry split and structured localized event design (#1146) are in
[24.4](24.4-relational-data-model.md). The transport, WebTransport from a Rust edge with this WebSocket as its fallback
(#1095, [27](27-rust-path.md)), is [24.5](24.5-transport.md): stages 1–3 are built, and stage 4 is #1207.

The rules this mechanism enforces are in [15](15-information-rules.md).

Dynamic-physics prediction and projection ([29.2](29.2-physics-state-networking.md))
are implemented and required (#920, #975, #976). Movement prediction and reconciliation
are implemented; exact reconciliation is not promised for hidden contacts.

## Wire protocol and middleware boundary

`shared/protocol.ts` is the single transport-free source of truth for the live wire protocol (#957), imported directly by the client's modules under `public/` and re-exported with server-only room/seed helpers by `server/protocol.js`. It owns `WIRE_VERSION`, WebSocket message names (`CLIENT_MESSAGE`, `SERVER_MESSAGE`), close codes and reasons (`CLOSE_CODE`, `CLOSE_REASON`), HTTP endpoint paths (`HTTP_ENDPOINT`), rate and buffer limits, TypeScript payload contracts, the inbound validator (`validateClientMessage`), and checked outbound builders and validators (`validateServerMessage`, `assertServerMessage`, and the server message and HTTP response builders). Every outbound WebSocket message in `server/` is constructed through those checked builders and validated at `send()` in `server/room-views.js`, and every HTTP JSON response in `server/http-api.js` is built through its checked HTTP response builder. Domain-specific sub-contracts remain with their owners and are referenced rather than duplicated: live projection allowlists in `shared/simulation/projection-contract.ts`, keyframe/delta layers in `shared/frame-layers.ts`, discovery deltas in `shared/discovery.ts`, content/presentation descriptors in `shared/presentation.ts`, replay headers/frames/marks in `shared/recording.ts`, and chain snapshot encoding (`CHAIN_WIRE_VERSION`) in `map/macro/src/chain/saving.ts`. A boundary test in `tests/server-boundaries.test.js` fails if `server/` or `public/` sends or dispatches on a wire message not named in `shared/protocol.ts` or constructs raw server/HTTP envelopes outside the checked builders.

`GET /api/health` reports `rulesVersion`, `physicsVersion` and `wireVersion` under explicit names (replacing the ambiguous `version` field), and counts the split delivery's `fast` messages and their overflow ([24.5](24.5-transport.md#stage-3s-contracts) "Overflow"). `GET /api/client-config` reports `wireVersion` and the server's `devTools` policy (`none`, `owner`, `all`) alongside its deploy defaults and `presentation` so the browser checks `wireVersion` skew and learns whether open rooms are listed once on startup rather than polling `/api/health` on every room refresh. It also carries `webTransport`, the Rust edge's port and certificate hash when one is linked, or null ([24.5](24.5-transport.md#stage-1s-contracts)); adding it took `WIRE_VERSION` 6 → 7 (#1095). Inputs on WebTransport datagrams took it to 8 ([24.5](24.5-transport.md#stage-2s-contracts)), and fast state on them, with the `fast` and `slow` messages and acknowledgements on the input datagrams, to 9 ([24.5](24.5-transport.md#stage-3s-contracts)), and the edge's datagram send with the client's apply, which a version-9 page cannot read, to 10. Rounding the fast part (24.2 decision 3) took it to 11; for those fields a rebuilt fast frame equals the projection as transmitted (24.2 "Quantization boundary"). The input's nominated interaction target (below) took it to 12; the tick cutover takes it to 13 ([27.2](27.2-tick-architecture.md)).

Every inbound WebSocket message passes through `acceptClientMessage` in `server/protocol.js` before room dispatch. Malformed messages (non-object JSON, unknown `type`, or invalid fields) are dropped—or answered with the existing refusal message for `join` (`error`), `choose` (`choose { ok: false }`) and `teleport` (`teleport { ok: false }`)—while incrementing `session.rejectedMessages` and logging a rate-limited warning (`REJECT_LOG_INTERVAL_MS`). When the server runs with `strictProtocol: true` (enabled in `tests/helpers/browser.js`), any rejected message throws immediately so browser integration tests fail on client/server protocol drift. Wrong-moment messages caused by normal client/server races (such as `start` or `choose` arriving just after match start, or `input` arriving as a match finishes) pass schema validation and are ignored by room state; they are never counted or logged as protocol rejects. Escalating malformed messages or repeated rejects to a socket close with client-side recovery is wanted, but requires its own recovery design and is left out of scope for #957.

`join` separates connection `mode` (`'player' | 'spectator' | 'dev'`) from player `role` (`'contestant' | 'gladiator' | 'any'`). `welcome` preserves its three mode-specific variants, all sharing `room`, `owner`, `devTools`, `ready`, `paused`, `contentId`, `presentation`, `map`, `state`, `roster`, `constants` and `stateEncoding`:
- `player` (`PlayerWelcomeMessage`) carries `id` (the assigned `PlayerId`), `resumeKey`, `started`, `matchmade`, and `startsAt`, with the waiting-yard or live `map` and `state` (the player's `role`, `kit` and `seat` arrive in `state` and `lobby`, not on `welcome`).
- `spectator` (`SpectatorWelcomeMessage`) carries `id: null`, `spectator: true`, and `spectatorDelayTicks`, omits `started`, and carries `map` and `state` once `ready` is `true` (`null` while the map is still generating).
- `dev` (`DevWelcomeMessage`) carries `id: null`, `spectator: true`, `dev: true`, and `started` (with `devTools: true`), and carries `map` and `state` once `ready` is `true` (`null` while the map is still generating).
These three variants are preserved as-is until `join`/`welcome` are revisited for middleware.

### State encoding

`state` messages are negotiated per connection (#1131, [24.1](24.1-wire-encoding-design.md)); the server never
infers an encoding from a failed decode.
- **Asking.** `join` and `match` carry `wireVersion`, the `WIRE_VERSION` the page was built for, and
  `stateEncoding`, `'binary'` (the default) or `'json'` (`STATE_ENCODINGS`). A request naming another wire
  version is refused before anything else is sent, with `STALE_CLIENT_REASON` telling the page to reload; a
  matchmaking request is answered with that `error` too. Older tools that omit `wireVersion` are not checked.
- **Granting.** `binary` is the descriptor codec (`shared/wire-schema.ts`), whose schema version is
  `WIRE_VERSION`. `json` is a debug encoding of the same projection, granted only to a session the `DEV_TOOLS`
  policy admits ([Dev view](#dev-view)); otherwise the join is refused with an `error`, never given binary
  instead. The welcome's `stateEncoding` confirms what the connection will be sent.
- **Reading.** The client (`public/room-connection.js`, `public/dev-view.js`) reads `state` only in the encoding
  its welcome confirmed, and closes with a notice on anything else, including bytes the codec refuses. A page
  opened with `?wire=json` asks for the debug encoding.
- **Delivery.** Everything other than `state` is JSON text, including the frames inside `welcome` and `ready`.
  `broadcast` encodes each distinct (view, keyframe set, encoding) payload once and shares it between sessions,
  as before. In a room a binary payload is a `Uint8Array` and text is a string. A room on its own thread
  (#1089) transfers both as bytes with a `binary` flag, and the socket sends a binary frame only for those.

### Schema closure

Stage 3 of #1131 applied [24.3](24.3-wire-data-model.md)'s proposals 3, 6 and 8, with Corey's decision on the
rest of 8 ([17.4](17.4-live-service.md) #17). Snapshots and recordings are unchanged.
- **Constants once.** No frame carries `version`, `duration`, `cellChargeTicks`, `physicsProfile` or
  `predictionMotor`.
  - `welcome` and `ready` carry the map's `constants`, `{ physicsProfile, predictionMotor }`, or null with no
    map; the content descriptor already names duration and charge time.
  - The client's normalizer (`envelope`, `withMatchConstants` in `shared/relational-frame.ts`) puts the profile
    back on a frame with bodies and the motor on one with `self`, so readers see the frames they did.
- **One "none".** Own `reload`, `charging` and `respawnAt` are absent for none, never `null`. Inventory slots stay
  positional, `null` when empty.
- **No unread fields.** `directed` left, since the client knows how it joined. So did own `cell`, `nodeId` and
  `attackCd`, body `omega` and `sleeping`, and item `droppedBy`, `pickupAfter`, `nodeId`, `instanceId` and
  `lineageId`. A reload names its slot only. The
  map payload's items go through the same item contract as frames. A field is added when something reads
  it.
- **Roster revision.** `welcome`, `ready` and `seats` each name the `rosterRevision` (in `seats`, `revision`) of
  the roster they deliver, and each `state` names the revision it was projected against as `rosterRevision`,
  added by the transport rather than the projection.
  - A revision names a roster's content within its room (`server/room-views.js`). A delayed view therefore names
    its captured frame's roster, and the yard's and the match's never collide. It identifies a roster; it does
    not order rosters.
  - A session is sent `seats` when its next state names a revision it does not hold, not every tick; a welcome
    or ready sets the one it holds.
  - The client refuses to draw a frame against a different roster revision than it holds, or before it holds
    one, closing with the unreadable notice. On one ordered socket that cannot happen; what a client does without the roster on a
    lossy transport is #1094's to decide ([24.2](24.2-lossy-transport-deltas.md)).

Validation is transport-free and session concerns sit behind a minimal session interface (`id`, `deliver`, `close`, `rejectedMessages`) so room lifecycle, matchmaking, session admission/reconnection (`join`, `match`, `welcome`, `lobby`, `error`, `ping`/`pong`) and connection state can be absorbed by room middleware (Colyseus was the leading candidate; it is retired as one since 2026-11-17, kept only as lobby-pattern guidance, [27](27-rust-path.md)) while game update, visibility projection, layered frame encoding, lag compensation and recording stay ours. When evaluating Colyseus against this seam, note three specifics: Colyseus 0.16 replaced `@filter` with `StateView` for per-client visibility; Colyseus 0.18 added built-in client prediction and input handling, so `input` is not automatically application-owned; and our 60-tick spectator delay projects a historical frame rather than current room state, which does not fit live schema state sync and keeps state/projection delivery on our own message path unless delayed spectators move to a downstream consumer ([Two-tier spectators](#two-tier-spectators)).

## Client authority

Clients send bounded movement axes, aim, button state, monotonic sequence numbers and, on every input, the tick it is for (#1096, below). One-shot commands ride along only when sent: `reload`, `dropAmmo`, and `transit`, a station id of at most 64 characters naming a gladiator's transit destination (#692, 14). A destination is checked against the map when the tick spends it, so an unknown one is refused there. `target` nominates the interaction's target ([27.2](27.2-tick-architecture.md#rules) R8): `{ kind: 'extraction' }`, a gate by its `gateIdx`, a charger or transit station by its id, or a ground item by its outward id (#1164), which the receive boundary maps back through the match's key. The new tick validates only that target and never falls through to another, so a nomination that is malformed or names nothing on the map allows no interaction at all, neither the default target nor a rail destination, while movement and combat stand. It reaches the core as `unresolved`, which rejects a pressed interact with it, so the rejection is in that tick's events ([27.2](27.2-tick-architecture.md#core-changes-before-the-switch-3d4a)). An item's id must lie in the wire's id domain. The old tick ignores a valid target, and no client sends one yet. They cannot set health, world positions, inventory, or match outcomes. The server expires stale input and checks interaction range, cooldowns, collision, and extraction availability. Local movement is predicted with the same collision code and reconciled from authoritative snapshots. Input is buffered per player and a tick spends at most one. That is what makes reconciliation exact, and it replaced coalescing rather than refining it: clients send on their own interval, so two messages can land between two ticks and none between the next two, and a merge applied one movement step where the client had already predicted two while a late packet applied the previous step twice. Both directions diverged, on a large fraction of ticks, and reached the player as a correction indistinguishable from a real one. Latching went with it — a one-shot press needed rescuing only because a merge could erase it, and nothing is merged now.

A client may also send `{ type: 'diagnostic', kind, tick, startTick?, count?, worstMs? }` to flag a performance problem for the replay (26). It is metadata beside inputs, handled before the `input` branch, and is never queued, recorded as a command or read by the simulation. `kind` must be `frame-drop`, `packet-gap` or `manual`; numbers are rounded and clamped, and anything else is ignored. `tick` is the tick the client was drawing, which lags the server by its receive buffer and round trip, so the server holds it within `MAX_DIAGNOSTIC_LAG_TICKS` (150) before the tick it arrived at, never after, and records the reported tick and the arrival tick as well. A session may send one per `MIN_DIAGNOSTIC_INTERVAL_MS` (250) and `MAX_DIAGNOSTICS_PER_SESSION` (64) per match; spectators' reports are ignored. The client sends episodes, not samples: a run of frames over 50 ms or packet gaps over 150 ms is one report with its first and last tick, count and worst value (`public/diagnostics.js`). A visibility change ends the open episodes and forgets the previous frame and packet times, because frames stop while a tab is hidden and the first one back would otherwise measure the whole absence; nothing is reported for the time away. The `B` key and the flag button send a `manual` report.

Two sequence numbers are kept, and the split is the point. One records what was *accepted*, guarding ordering and duplicates on arrival; `lastSeq`, the one transmitted, records what a tick has *spent*. Acknowledging on arrival would tell a client an input was applied while it is still waiting in the buffer.

### Tick-stamped input

Protocol validation sanitizes input once. The match and waiting area admit that sanitized value directly into their
buffers. In-process callers can pass raw input through the same sanitizer. `unresolved` is an internal marker for
a pressed malformed nomination. A client-supplied marker follows the same rules as any malformed nomination.
A drag from an inventory slot into the world sends `drop: true` with the source `slot`. The boundary records that
as a drop of the named slot and preserves the selection. Drop without a slot acts on the current selection.

Every input names the tick it is for (#1096; Corey's decisions in [17.4](17.4-live-service.md) #16). The server buffers it and spends it on that tick and no other (`shared/simulation/input.ts`), so when an input takes effect is the client's choice, not the network's. Before stamps, inputs queued in arrival order and a send rate equal to the tick rate never drained the backlog a retransmission stall left: on a lossy socket the queue held 140 to 180 ms more input than the network needed (42.48). The wire refuses an input without a stamp; in-process callers (tests, tools) may still omit one, and a tick then spends those in arrival order.

- **Late input is discarded, never rewound.** A stamp for a tick that has already run is dropped. Nothing is resimulated for movement; only hits are judged in the past ([Lag compensation](#lag-compensation)). Delayed sealing with resimulation (#1096's option 2) is not built; it is revisited only if discarded inputs prove noticeable in play.
- **The lead is bounded by measured latency.** A stamp may lead the next tick by at most `inputLeadFrom(rtt)` ticks: 4 plus three times the round trip the server measured below, at most 28 (1.4 s) and that much before the first measurement. A lead buys a client nothing but its own delay, so the bound limits the buffer; a claimed past is never honoured at all, so faking lag gains nothing here.
- **One input per tick, in sequence order.** Stamps advance one tick per input. A newer input stamped for a tick already buffered supersedes it and everything buffered after it, which is how a client clock that steps back is absorbed.
- **The client steers by margin.** Each frame reports to its own player `inputMargin`: how many ticks before its tick the worst input since the last tick arrived, negative when late. The client's input clock (`shared/input-clock.ts`) stamps from an estimate of the server's tick (its least-delayed recent frame plus the measured round trip) and then sends slightly faster (×0.9 period) while a recent input was late or below the target margin, slightly slower (×1.05) while a full window of 20 arrived above it, otherwise at the tick rate. It jumps forward when its stamps would surely be late and steps back only when further ahead than any server buffers, which is a new clock (a new map). The target margin is 1 tick by default (Corey, #1096) and is a tuning value, not a rule.
- **Prediction reconciles by tick.** A frame for tick T has spent or discarded everything stamped T or earlier; the client replays the rest from the frame's tick, and a tick no input was stamped for replays as the server spends it ([29.2](29.2-physics-state-networking.md#prediction-and-reconciliation)).

An empty tick repeats the last spent input's movement and aim for a short while (10 ticks) — one late packet is far likelier than a player releasing every key — but never its one-shot presses, since that would turn packet loss into an action the player never asked for. The repeat is reported (`inputStalled`) so a correction the client could not have predicted is distinguishable from one it mispredicted. Measured against the simulated links of 42.48 (`tests/bench-input-timing.mjs`, section R, the implementation itself), the stamped buffer on today's socket spends a good link's input sooner than the arrival-order queue did (128 against 195 ms at target 1) and starves far fewer ticks on poor links (1.0% against 21.9%), at the price of more delay there (723 against 331 ms): the margin it holds for the jitter tail. Datagrams (#1095) would still need redundant inputs per packet, because the sequence guard refuses an input overtaken by a newer one.

Instantaneous attacks are resolved against what their attacker could see. It measures what that needs, and then uses it. The server stamps a token once a second, the client echoes it, and the server times the
return against its own clock: the client reports no number and can only return something it could not
have held earlier. It can still stall an echo, and that only ever makes its own connection look
slower — the direction that would buy a cheat more rewind — so the reported figure is the minimum of
the last five samples rather than their mean, and it is clamped at 400 ms. A lag switch cannot pull a
minimum upward without holding back every echo in the window, and the clamp bounds what it would win
if it did. Anything that later trades on latency must treat this as an upper bound the server chose,
never as a client statement.

## Lag compensation

Experimental physics P4 (#441) adds `predictionMotor` tuning, a match constant since #1131 stage 3 (sent with the map, restored to own frames by the client)
(acceleration, braking, maximum speed, whether motor surfaces apply) beside the authorized correction-tick
body lists. Own velocity remains private to that player; observed actors still
omit velocity. No view carries angular velocity or sleep state (#1131 stage 3). Fixed prediction proxies use only authorized
projected poses. No hidden contacts, force sources, endpoint IDs or backend
checkpoints are sent to explain correction. Tick, consumed `lastSeq`, body
generation and placement define reconciliation boundaries ([29.2](29.2-physics-state-networking.md)).
The own-only `predictionTethered` movement-status flag enables fallback without
revealing a hidden tether endpoint.
This live-only addition changes no recording/schema, server rules or content
identity, while matches run under the required physics rules and motor profile (#920, #976).

A player aims at what is on their screen, and what is on their screen is old: two ticks of
interpolation delay by design, plus however long the frame took to arrive. Resolving a swing against
where the target is *now* charges the attacker for both, and the amount is invisible and varies with
their connection. `shared/simulation/rewind.ts` keeps ten ticks of positions and resolves a gladiator's
melee and a warden's shockwave against the positions their attacker was looking at, derived from the
measured round trip plus the buffer's own delay. Range, firing arc and cover all read the rewound
position: a compensated hit still had to have had line of sight.

This is not permissiveness, and the distinction is what the tests pin. A target that has stepped out
of reach since can still be hit; a target that has only just stepped *into* reach cannot, because the
attacker could not have seen them there. The cost is paid by the person being shot at, who can be hit
after reaching cover on their own screen. That trade is the standard one, and it is why the window is
bounded at half a second: past that a connection is too far behind to compensate for without the
victim's experience becoming the absurd one.

Travel-time projectiles are deliberately left alone. A player already leads a moving target by the
flight time, aiming where it will be rather than where it was, so rewinding the shot as well would
compensate twice and land it behind. That is a decision about this game's weapons, not a gap:
revisit it if a hitscan weapon is ever added.

The history never reaches a snapshot or a recording. It is derivable from the frames a recording
already holds, so carrying it would store the same positions twice. A player with no measured
latency — a bot, a local match, anyone before their first round trip returns — carries no trace of
the mechanism at all, which is why the frozen behaviour baseline is unchanged by it.

## Potential visibility

The server is authoritative over what could become visible, not over what is visible. It transmits everything within a generous radius of a viewer, plus anything a reveal has exposed at any range, and leaves line of sight to the client. That removes the latency and the pop that a per-tick server side sight test causes when something steps out of cover, and it gives the renderer the data it needs to shade rather than erase. The trade is explicit and deliberate: that radius is also how far a modified client could see through walls, so it is a tuned constant rather than the whole map. True line of sight stays server side and stays authoritative wherever it decides an outcome — bot targeting, ability reach, hit resolution — none of which may depend on anything a client asserts.

Filtering is field-level as well: another player carries only what the renderer draws, while inventory counts, ability timers, bot status, and input bookkeeping stay with the player they belong to, and replay-only bookkeeping is never broadcast. Recordings keep the complete state; a live view is a projection of it and must never differ where the two overlap, except that IDs drawn from match-wide counters reach live clients through a per-match keyed one-to-one mapping, so a live ID is a keyed view of the recorded one ([24.4](24.4-relational-data-model.md#keyed-outward-ids-1164)). Every consumer of the transmitted state applies the client side sight test, the minimap included, since a surface that skipped it would quietly become a wallhack. This is not a complete production anti-cheat system.

`shared/simulation/projection-contract.ts` explicitly lists the live frame, own-player, equipment, gate, trap, projectile, effect and event fields. Source-key order and optional-field presence are retained for existing serialized output. Adding simulation bookkeeping now requires deliberate opt-in before it appears in those payloads. Wire version 4 separates `self` from observed `players`, both keyed by numeric `playerIdx`.
Seat metadata (`id`, `name`, `role`, `kit`, optional contestant `seat`) is delivered in the
welcome/ready `roster` and reliable `seats` updates ahead of matching state, each `seats` naming the roster
revision that state then names ([Schema closure](#schema-closure)). The selected
captured frame supplies delayed-view metadata. Body poses are authoritative for active
actors and physical items; bodyless players retain `x`/`y`. Static gate geometry stays in
ordered `map.gates`; dynamic `state.gates` holds only `gateIdx`, `open`, `locked`.
Numeric body owners and tether endpoints are filtered together, and shape omission is
relative to the exact baseline generation. Structured events retain event-time names and
use the shared formatter. See [24.4](24.4-relational-data-model.md) for these contracts.

Own-player projections carry authoritative map discovery (`discovered`) as a plain list (#275); room-views encodes it via keyframe-then-changes deltas for live delivery; other players and directed/spectator views never receive it, and recordings omit it since it is reconstructible by a pure fold. Own-player projections likewise carry heard gunfire (`heard`, #684, 15) as a plain list of `{ x, y, tick, until }` cues, present only while one lasts, so frames under other contents are unchanged; it is small and short-lived, so it is sent whole rather than as a layer, and it reaches no other view and no recording. Static welcome-map content still follows the prototype map contract, and permitted fields retain their current types: these lists are not a protocol migration framework or full schema validator.

## Viewers and spectators

A connection is a viewer before it is a player. Each socket holds a connection id, and a player id only once it claims a slot, so a non-player client is a first-class case rather than a missing player. A viewer id matching no player receives the directed view: unfogged, the same shape a recording plays back, and the basis for spectator, patron, and presenter clients. The owner-key gate remains, and spectator state is delayed by 60 authoritative ticks (three seconds at 20 Hz) before it is broadcast, so an audience cannot use the directed view to relay current positions. Broadcast cost is per distinct view rather than per socket — every spectator shares one filtered, serialized delayed payload — so an audience does not scale the tick. Non-player clients hold no slot, start no recording, and have no input authority; giving patrons a way to affect a match means a separate validated command type recorded alongside each frame, not a widening of player input.

<a id="two-tier-spectators"></a>

### Proposed direction: two-tier spectators and viewer publication (#1123)

Status: proposed architecture ([17.4](17.4-live-service.md) #16, [28.1](28.1-deployment-topology.md)); nothing below is implemented yet.

- **Separate authoritative finality from viewer publication.** An authoritative tick from `advance()` (or a sealed frame if `#1096` later adopts a delayed input-acceptance cutoff with rollback) is distinct from viewer publication (projection, delta encoding, keyframing, and audience delay). Viewer publication consumes an immutable authoritative frame alongside the private evidence recorder ([26](26-recording-contract.md#proposed-viewer-publication)) without blocking on `#1096`'s input-timing evaluation, and with independent queues and failure isolation.
- **High-trust live viewers (admin / dev / caster).** Live omniscient connections stay on the room host alongside players as slotless viewers (`dev` under `DEV_TOOLS`, plus any future live caster role). A live caster must require **explicit authorization** before receiving undelayed omniscient state; it must never automatically inherit the `DEV_TOOLS` exception.
- **Low-trust delayed spectators and patrons.** Public/delayed spectators move downstream of the room onto a progressive viewer-safe stream using `playerView(..., null)` (`shared/simulation/visibility.ts`) with the closed allowlists in `shared/simulation/projection-contract.ts`, plus `publicMap` (`server/map-payload.js` via `server/match.js`). That consumer owns admission ([17.4](17.4-live-service.md) #6), configurable server-enforced delay before bytes reach untrusted clients (consistent with [17.4](17.4-live-service.md) #6), late-join bootstrap, reconnect/resume, bounded buffering, and match-end delivery. Validated patron commands remain a separate command path into the room's command validation, never player input authority.
- **Viewer-safe is not publicly accessible.** Projection stripping defines what fields a viewer payload may disclose; who may receive the stream or download an archive remains governed by explicit access and lifetime policy (`17.4` #3 and #6, `#1098`, `#1074`).
- **Shared primitives, decoupled wire/archive contracts.** Live wire (`#1093`/`#1094`) and `delta-1` recording (`#901`) stay separate contracts while sharing closed projection allowlists and keyed-list delta primitives (`shared/keyed-list.ts`). Forward-only progressive spectation over a bounded window does not require `#1102`'s arbitrary-seek archive timeline.

### Directed presentation modes

An authorized directed feed supports two presentation modes (F-19, user answer
in [17.3](17.3-product-gameplay.md) #17): follow using the player's sight, or
omniscient viewing with follow or free roam. These are presentation choices over
the existing feed; selecting a mode grants no socket role, slot or input authority.
Admission, spectator delay and the dev exception remain as specified here.
Stronger spectator restrictions and anti-cheat policy are deferred.

A new connection or newly opened replay starts at the whole-arena view with
player vision selected for subsequent follows. V switches that follow preference;
it persists across subjects within the view, but is not a cross-session stored
preference. Esc or panning releases the subject into omniscient free roam, and 0
returns to the omniscient whole arena. Selecting a subject again uses the current
follow preference. An explicit dev step-out/back roundtrip restores its saved
follow/free framing and vision preference within that connection; reconnecting
discards the saved dev settings. Opening a replay gets its own defaults.

Player-vision mode uses the current subject as its sight viewer. Absence never
silently changes modes: without a current subject there is no sight, dynamic
entities are hidden (including minimap actors), and static terrain stays shaded.
V still permits an explicit omniscient view. The camera can remember a position
without inventing a viewer; [25](25-pacing-and-rendering.md) owns that temporal
rule. Present subjects use shared sight, cloak and reveal rules in the scene and
minimap. This approximates their experience from directed data: it does not
recreate network delivery, prediction or private discovery history; directed
minimap terrain remains fully available as described in [15](15-information-rules.md).

<a id="dev-view"></a>

### Dev view

The dev view is a development tool for watching a live match: the directed view with no delay. Who may open it is a server policy, `DEV_TOOLS` = `none`, `owner` or `all` (`server/protocol.js`). Unset means `none`, so a server started for real players offers it to nobody; `npm run dev` and `npm run dev:lan` pass `--dev-tools=all`, which outranks the environment. Under `owner` a session needs the room's owner key, as the delayed spectator stream does; under `all` anyone may open it, including a player who also holds a slot, which is the exception [15](15-information-rules.md) records. A dev session joins with `mode: 'dev'`, counts against the same 24 non-player places, and otherwise behaves as a spectator: no slot, no recording, no commands, no diagnostics. Every dev session in a room shares one payload, built from the current frame rather than the delayed one. Each welcome carries `devTools`, whether that session may open the view, so the client offers the link only where it would be admitted. A welcome into a room whose map is still generating (#258) carries `ready: false` and no map or state. Spectators and dev views receive the map and core tick 0 together in `ready` at the start. A player is shown the waiting yard instead until the start (#236): their welcome carries the yard's map, and `state` frames with `phase: 'waiting'` carry every player there (people only, in the fields a match shows of a player in sight, and the player's own fields, plus bodies for client Rapier prediction, #975, with the yard's physics profile and prediction motor in the welcome's `constants`). The match map is first sent to a player in the `ready` the start brings. Input before the start moves them in the yard and is neither a match command nor recorded.

A player steps out to it in place, with the telescope button or the backquote key, and back the same way (#246). The client opens a second socket as the dev viewer and draws its frames, while the player's own socket stays open, so they keep their slot; it sends no input meanwhile, so the server's usual repeat lets the character go idle, and it keeps receiving the player's frames so stepping back is immediate. Pauses, the lobby and saved replays still arrive on the player's socket. Opening a replay steps back first. `?room=…&dev` opens a standalone dev view with no player. Its camera belongs to `public/camera-director.js`, which every directed view shares (replays and spectators too): the whole arena, a free view (drag or WASD/arrows to pan, the wheel to zoom about the pointer), or a followed player. A followed player is shown in their own sight by default, at their own zoom, using the same shared sight rule a player's view uses; V turns that fog off and the wheel can then zoom, Esc stops following where the camera is, and 0 returns to the whole arena. The fog is drawn from data the directed view already has, so it shows what that player could see, not what their client was sent.

Any session the policy admits, a player's included, may pause and resume its own room with `{ type: 'dev', action: 'pause' | 'resume' }`; other rooms keep running. While paused, the scheduler drops owed time and leaves the match at its current tick. Resuming produces neither a burst nor a `server-stall` mark. Every session in the room is told with `{ type: 'paused', paused }`, and a welcome carries `paused`. Players stop sending input while paused, and the client forgets its packet timing at both ends, as it does for a hidden tab, so the pause is not reported as a packet gap. The recording gets one `pause` mark when the room resumes or ends (26). The empty-room grace keeps counting while paused: a paused room nobody is watching is still abandoned. The dev view's button or Space toggles it.

A dev session may also move any active player or bot: `{ type: 'dev', action: 'teleport', id, x, y }`, which the dev view sends with T for the followed player (or the viewer's own, stepped out of) to the point under the cursor. The simulation refuses a point that body could not occupy and answers the sender with `{ type: 'teleport', ok, id }`. On the default tick a successful move is applied between ticks, recorded as a `{ type: 'teleport', id, x, y }` command with the next frame, and broadcast immediately while paused. Rewind history is left alone: a lagged shooter still saw the player where they were.

An admitted teleport is an observation at the next tick, and the reply reports that tick's
committed warp. While paused, an admitted request explicitly runs one tick so it can return a result. A committed
warp publishes the paused state. If that tick ends the match, the room broadcasts the terminal frame for either
reply. Scheduler wakes leave the room paused. See [27.2](27.2-tick-architecture.md#the-opt-in-room-tick-3d4c).

A socket that has fallen 512 KB behind skips state frames, which the next frame supersedes; every other message (a pause, a lobby change, a saved replay) is sent regardless (`deliverable` in `server/protocol.js`). A session's `deliver` says whether it sent, so a skipped frame is known not to have delivered a keyframe (below).

<a id="layered-frames"></a>

## Layered frames

P3 (#440) adds independent `bodies` and `tethers` layers alongside items/gates.
Every transform, angle, velocity, sleep/generation change participates in entry
comparison; moving loot changes its item entry as well. No static-layer revision
shortcut may suppress those changes. Existing per-view keyframe delivery covers
late joins, skipped sends, deletions and room replacement for these lists too.

Physics live projections are closed display records built from the captured tick.
Actors use the same potential-visibility authorization as their player record;
props use the potential radius plus their bounding radius, and item bodies also
require the ground item to be authorized. Unknown actor associations are omitted.
Observed opponent actor bodies carry pose, shape, generation and placement only;
their velocity is omitted, matching the observed-player contract. The viewer's own
actor retains its velocity for correction, as do non-actor physics props and every
body in a directed view. Angular velocity and sleep state stay in recordings only:
no client read them, so #1131 stage 3 removed them from every view. Closed body, shape and tether field copies
are owned by `simulation/projection-contract.ts` alongside the other wire contracts.
A tether is omitted unless both endpoint bodies are authorized. No pending
commands, motors, force sources, contacts, engine settings or private gameplay
state accompany it. Delayed spectators project the complete delayed frame through
this same boundary, never today's world. The renderer also applies current sight
and actor concealment before drawing endpoints/tethers in a fogged view.
Props may draw when their geometry intersects current sight and camera coverage,
even if their center lies in shadow. Roof concealment remains center-based,
matching the existing prop/loot roof policy. A visible edge alone does not make
a hidden center tether anchor visible: that tether is omitted. `view.ts` owns
this shape visibility rule alongside point/actor visibility, including camera
margin and roof policy. It clips the star-shaped sight fan to camera coverage
once per fogged frame, then uses shared shape bounds, containment and overlap.
An off-camera bounds reject precedes SAT/sight work. The physics presentation
adapter supplies shapes/radii without owning a separate visibility predicate.

A live `state` frame carries the map's items and gates as layers: each is sent whole once, as a keyframe, and then as the changes since that keyframe (#250, `shared/frame-layers.ts`). The historical payload comparison is retained in [42.2](42.2-runtime-performance.md#layered-frame-payload-observations). Everything else in the frame is still sent whole every tick.

On the wire a layer is a plain list as before, or `{ k, set?, drop? }`: keyframe `k` with those entries replaced or added and those ids removed. A session that lacks keyframe `k` gets the same object with `all`, the keyframe itself. A keyframe never changes once cut. `all` is always the layer as it was when `k` was cut, never the current list, so a session given it late rebuilds the same frames as one that had it from the start. The client's decoder, one per socket, rebuilds the plain list before anything else reads the frame, so the snapshot buffer, renderer, HUD and prediction see the same frames as before. The rebuilt frame is identical to the projection, entry order included: the encoder cuts a new keyframe instead of sending a change set the decoder would rebuild in a different order. Waiting-yard frames, welcomes, `ready` and recordings carry plain lists. Recordings are unaffected, and the projection contract above holds for the rebuilt frame.

This is ordinary snapshot delta compression, and two choices fit it to this server:
- **Changes are against the keyframe, not the previous tick.** Every session on one view receives the same change set, so the payload stays shared and broadcast cost stays per view rather than per socket (above). Quake 3 and Source instead delta against each client's last acknowledged snapshot, which is smaller per tick but encodes per client. Here the change set grows until it reaches a thirty-second of the layer (at least 16 entries), and then a new keyframe is cut. The sampled item-change workload is recorded with that comparison in 42.2.
- **Keyframes are sent when needed, not on a timer.** The socket is ordered and reliable, so the only frame a client misses is one the server skipped, and the server knows which. A session not yet delivered the current keyframe (on joining, after a skip, or when a new one is cut) is sent it in its next frame, together with that frame's changes. There is no periodic re-send of the kind an MPEG transport stream uses for receivers that tune in at any time. Keyframe numbers are unique in the process, so a client never applies a change set to a table from another view or room. Should one arrive anyway, the decoder keeps the last list it had and names the layer in `stale`.

Layers are independent of each other and of the per-tick part of the frame, so another slow-changing collection can become a layer without changing the mechanism. Fast-moving state belongs in the per-tick part. That includes future physics bodies while they move: the client interpolates and predicts from complete per-tick frames (25). Bodies at rest would suit a layer, which is the usual treatment of sleeping bodies.
