# 27. Rust path

**Step 6c.3c.2, the readers take equipment from the store (#1214, adapter version 24).** Phases 3 and 6 no longer pack
inventories, reserves, reload, selection, weapon, keys or charging.
- **Tokens name the records.** `player-store.ts` keeps a table per runtime: a token is a carried record's index there.
  - Each upload numbers the carried records in roster and slot order, and the store loads those tokens.
  - A new item the core reports (token -1) is filed under the next token, in the order the adapter builds it
    (`adoptCarried`). That is the order the store gives new items their tokens (`players::put_items`), so both agree.
  - A swap's clone takes its original's token (`replaceCarried`).
  - The adapters read writes back by token (`carriedItem`), so a carried record keeps its identity across calls and
    stops, as the per-call pools kept it within one.
- **The adapters still decide what the rules may read.** Where an adapter used to pack an actor's inventory, it now writes
  `FROM_STORE` (-2) for its length, and the core fills the inventory from the store; elsewhere it stays absent, as before.
  Selection, weapon, reserves and reload (phase 3), and keys, charging, selection, weapon and reserves (phase 6), are
  filled always, as their adapters always packed them. A plan's standalone item (`planDropInCore`) still crosses, with a
  token of the call's own above `EXTRA_TOKEN`.
- **Between ticks a call uploads first, at its start,** before anything names a carried record by its token, since the
  upload numbers them afresh. Uploading after the identity lists were built broke eight item tests, which found it.
- **The witness.** The dump now carries the store's tokens, and `storeDrift` packs the records with the table's, so a
  store item naming a different record from the one in its slot shows as drift.
- **Cost:** measured once, at the end of step 6, against the `main` before 6a (Corey, 2026-11-21).

**Step 6d.1, the ground store (#1214, adapter version 25).** `rust/core/src/ground.rs` keeps each ground record's rule
fields in the list's order: id, the body's world key (`item:<label>`, whose order is the labels'), pose, kind, weapon type,
ammo, count, charge, ammo family, identity, quality, the dropper's roster index, `pickupAfter`, and an absence mask.
`shared/simulation/ground-store.ts` drives it.
- **Written through, not uploaded each tick.** Node's ground helpers report each change (`GroundSink` in `ground-items.ts`),
  and the store applies it: `addItems` appends, `removeItem` removes, `replaceItem` replaces. Those helpers make every
  change inside a tick: drops, pickups, swaps, and phase 4's poses (`writePhysicalItemPoses`). So a tick pays for its own
  changes and never for the map's size (#635).
- **Uploaded whole only when the list changed without them.** Each change carries the list and length it started from.
  When the store has not seen that list, or `groundList` announced raw edits, the store takes the result whole. That
  covers match setup, which `createGame` uploads (`ownGround`), and a test that replaces `s.items` or edits it raw.
- **Node's writes drive it until 6e.** The records stay Node's, so the store follows Node's helpers rather than the
  reverse; 6e turns the core's facts into the only writes.
- **The witness.** `tests/player-store.test.js` also holds the ground store equal to the live list after every tick
  (`groundDrift`). With `replaceItem`'s or `removeItem`'s write-through disabled, it fails at tick 1.
- **Cost:** measured once, at the end of step 6.

**Step 6d.2, the body sync's bookkeeping (#1214, adapter version 26).** The body sync (`synchronize_bodies` in
`boundary.rs`) no longer takes JavaScript's runtime bookkeeping as input:
- **The actor bodies** are the world's bodies whose IDs start `actor:` (`World::keys_with_prefix`); they were the
  runtime's `actors`.
- **The item bodies whose records left the ground** are the world's `item:` bodies whose keys the ground store no longer
  holds (`Ground::holds`, a key set kept with the store); they were `r.items` checked against `groundItem`.
- **Each gate's body** is reconciled from the world's own record (`GateBodies` in `world.rs`): the gates' keys and closed
  bodies' rows, uploaded once per world (`uploadGateBodies`, from `createGame`), the legacy admission order by ID, what
  the world last saw of each gate, and the door state in the gate set (6a). It was `r.gateOrder` and `r.gates`.
- **What still crosses** is the body templates, the discontinuity markers and whether anything was launched. The
  runtime's `actors`, `items` and `gates` stay as mirrors, updated from the sync's log as before, since phases 3 and 6
  read `actors.size` and phase 4's poses read `items`.
- **Cost:** measured once, at the end of step 6.

**Step 6d.3, the item admission (#1214, adapter version 27).** The sync's second call (`synchronize_items`) takes its
lists from the core, so no ground record crosses for it.
- **The records awaiting a body** are the world's `waiting` keys, in ID order (`unadmittedItems`' order). The world keeps
  them as the ground store changes (`await_body`, `stop_awaiting` in `ground_write`) and as items are admitted; only a
  whole upload sorts them (`rebuild_waiting`). Positions come from the ground store's key map (`Ground::by_key`).
- **One call, not chunks.** The admission walks the waiting keys until the world has no room, where the chunks it
  replaces stopped. No item frees room and a skipped one changes nothing, so the result is the same.
- **The launches** are the world's (`launches`). Node's `itemLaunches` is now a buffer: each admission hands its contents
  to the core (`physics_launch`) and clears it. The core takes the launches still on the ground, in ID order.
- **An admitted item names its record by ID**, so Node's mirror (`r.items` and the admission order) finds it without
  a packed list.
- **`physics-items`' admission test** counted a blocked record's `x` reads in JavaScript. Node now reads no record during
  the admission, so the count is 0, and the comments say where the guarantees moved: the core's walk skips a launched
  record, and its waiting list keeps one until it is admitted or leaves the ground.
- **Cost:** measured once, at the end of step 6.

**Step 6d.4, the hooks (#1214, adapter version 28).** The world keeps the hooks (`World::hooks`, `HookRecord`), in ID
order, and `r.hooks` is their mirror.
- **The hook rules work on them in place.** `hooks.rs` takes the world's hooks and writes back what its rules leave; its
  output, which the mirror applies, is unchanged. Whether a hook still names its caster, and its target the actor it hit,
  is read from the player store's keys, as the adapter compared IDs.
- **Phase 3 launches and cancels them in the core** (`launch_hook`, `cancel_hook`), from the same facts the mirror
  applies. It reads the hooks from the world where its adapter would have packed them (`FROM_STORE`).
- **Each player's hook key** (`hook:<id>`) is interned by JavaScript and carried in the player store (`Extra::hook_key`),
  so a hook the core launches has the key JavaScript's table holds; the core does not intern strings.
- **Uploaded only when Node changed them without the facts** (`syncHooks`): the retained scenario `hookSkill`, or a test.
  Each list the core matches is remembered (`sawHooks`), as the ground's is.
- **The witness.** `player-store.test.js` holds the world's hooks equal to the mirror after every tick (`hookDrift`), in
  a hook's flight, hit, pull and release. With phase 3's launch disabled in the core, it fails.
- **Cost:** measured once, at the end of step 6.

**Decided 2026-11-17; started under tracker #1173.** The backend's foundations move to Rust:
- **Network edge first,** as a full conversion.
- **Then a core** that absorbs the simulation from Node, module by module, behind an adapter.

Corey's words are in [17.4](17.4-live-service.md) #18. This document owns the design. The tracker owns the
sequence and each issue's state.

Before this, 27 was a plan with start conditions: the rules stop changing, a CPU ceiling, or a native server
requirement (checked for #568, 2026-10-27, none held). Corey's reason for starting anyway: the target will not be
more stable than it is under the feature freeze, and changes are better made in their real home than ported
again later. **The freeze continues while the core is reworked.**

## Boundaries

The backend has three natural cuts. They move in this order:

| Cut | What it holds | Determinism | Order |
| --- | --- | --- | --- |
| Network edge | Transport termination: QUIC, TLS, WebTransport sessions, datagram framing and size limits; later the WebSocket too | None. It touches no simulation, fixture or replay | First, a full conversion (#1095, [24.5](24.5-transport.md)) |
| Core | The tick, geometry, navigation, physics ownership, projection | The hard part (below) | Module by module through an adapter (#1175), then the state flip (#1066) |
| Room host | Threads, scheduler, room lifecycle, delivery, recording, lobbies | Follows the core | Last; native or hosting WASM is decided then |

**Map generation stays in Node.** Where its edge lies already exists: a generated map crosses into a room as one
transferable package (`server/map-pack.js`, #1089). Its format does not suit Rust yet.
- **What the package holds today.** The map and its portal graph are `node:v8`-serialized, which is V8's private
  object-graph format. The free-space tiles are separate typed arrays.
- **What the core needs.** A language-neutral form of the map. The tiles' flat arrays nearly are one already; the
  map and its portal graph need a schema'd flat encoding, as D gave the state.
- **When.** That format is part of the core's first consumer that needs the map itself, not of the math port, and not
  of a derived index such as sight's segments (port order, below).
- **Otherwise unchanged.** `map/` moves only if a later reason appears.

Review 907 on PR #1172 found the format gap.

**Colyseus is retired as a candidate.** Its value was architectural guidance for rooms and lobby management,
never the running game. Lobbies keep an edge where an external lobby service could still attach if nothing better
fits (17.4 #18).

## The edge

A Rust process built on `wtransport` (over `quinn`, `rustls` and `tokio`; MIT or Apache-2.0) terminates
WebTransport. It forwards sessions to Node over one local framed connection. Rooms stay behind the session seam
(`deliver`, `close`), so they cannot tell which transport carries a session.

That seam has synchronous expectations, so the local framing must carry what the room host reads today:
- **Backlog and skips.** `deliver` returns `false` for a droppable state frame it skipped (`server/room-views.js`
  then keeps the layer's keyframe unacknowledged), and threaded rooms read `session.buffered()` before building a
  frame. The real backlog now sits in the edge's QUIC streams. The edge therefore reports each session's backlog
  to Node, and Node decides skips against that report. Otherwise Node either queues into the local pipe or
  believes it delivered a keyframe the edge dropped.
- **Certificates and the address.** The edge generates and rotates the development certificate and binds its own
  UDP port. Node serves `/api/client-config`, so the edge reports the current certificate hash and its URL to Node.
- **Origin checks.** The edge validates a session's `Origin` as `server/websocket.js` does, against the HTTP
  origin, not the edge's port.

Review 907 on PR #1172 raised these.
- **WebSocket.** It stays in Node at first, as the fallback, and moves to the edge afterwards. Node then has one
  peer type.
- **The local framing** between the edge and Node is a contract with its own version. A future Rust host absorbs it,
  or keeps it as the edge in 28.1's topology.
- **What the edge holds.** Datagram size enforcement and 24.2's fragmentation belong to the edge. Acknowledgements,
  history and deltas are application-owned and stay with whatever owns the projection.

## The core and its adapter

One Rust crate, compiled to **one WASM binary that both the Node server and the browser load** (option 1 below).
The server and the predicting client then run identical bits without a second math library to verify. Node keeps
hosting rooms and calls into the WASM.

The adapter is what decides the cost. The rapier.js wrapper walks every collider on each step, and a map's object
graph cost a thread 150–200 ms to decode until #1089 packed it into buffers. Three rules follow:
1. **Flat typed buffers, never object graphs.** Inputs and outputs live in WASM memory, and JavaScript reads
   views of them.
2. **Leaves first, then the flip.**
   - **Early:** pure functions with small inputs and outputs, so each adapter stays thin.
   - **The flip:** once enough is ported, the world state moves into Rust memory and the tick crosses over.
     JavaScript then reads a mirror rather than feeding functions. Its design was decided under #1066:
     [The state flip](#the-state-flip).
   - **When (Corey, 2026-11-18).** Not yet: the sight port's crossings were cheap ([42.58](42.58-sight-core-adapter.md)),
     so #1092's deltas are built in Node behind the projection seam. The flip comes after #1092 closes, or earlier if
     a better point appears. #1092 closed on 2026-11-19, with the deltas built (24.5 stage 3), so the flip is next,
     starting with Rapier (#1192).
3. **Measure early.** Port one per-tick module, measure its crossing cost against the TypeScript under the bench
   lock, and set a budget before porting more. Crossings too costly are evidence to flip sooner.

Port order is stability order:
- **Math first;** every Rust module depends on it.
  - **The crate's math serves Rust callers** and the parity check against `tests/math.test.js`. It does not
    replace `shared/math.ts` for JavaScript callers.
  - **Why not.** About 30 TypeScript modules in `shared/` and `map/` call `sin`, `cos`, `atan2` and `hypot` per
    scalar inside hot loops. Sending those through WASM would break the flat-buffer rule, and a browser cannot
    import an asynchronously instantiated module synchronously.
  - **When `shared/math.ts` goes.** It stays until its last JavaScript caller has moved. Since `map/` stays in
    Node, that may be a long time. Until then, both copies must keep the same digest.
- **Then sight casting,** the first per-tick module (#1175 stage 2).
  - **Why it comes first:** `visibilityPolygon` was about half of tick time in a 24x12 profile. The shape
    queries were under 1% each (#1175, comment 16306). That was one unlocked run of 1,500 ticks, a rough guide;
    stage 2 measures under the bench lock.
  - **The first step, done:** it moved out of `shared/movement.ts` into `shared/sight.ts` with its own segment index (#1184).
  - **Its input (agent recommendation, #1175 comment 16341).** Sight takes a derived flat index, not the map: the
    obstacle and gate segments with their buckets, built in JavaScript and uploaded once, plus a per-tick
    open-gate mask. The map's language-neutral format then waits for a consumer that needs the map itself.
  - **The port (#1175 stage 2).** `rust/core/src/sight.rs` is `visibilityPolygon`, and `shared/sight-core.ts` is
    its adapter. It matched the TypeScript cast bit for bit, on synthetic maps and on the room arena, and the
    TypeScript then retired (#1175). Its measurement, and the budget it sets, are in
    [42.58](42.58-sight-core-adapter.md).
  - **The reference after retirement (agent default, #1175; Corey may overrule).** A pinned digest of the core's
    polygons, as `tests/math.test.js` pins math: `tests/sight-core.test.js` digests every field of every point
    over the fixed synthetic cases in `tests/helpers/sight-cases.js`, taken where the TypeScript and the core
    agreed. The cases are synthetic so content changes never move them. A moved digest is a gameplay change and a
    fixture version decision (31), not a test update. Correctness beyond regression stays with
    `tests/visibility.test.js`, an independent brute-force cast on the room arena. **Limitation:** unlike math,
    no Rust-native test computes the sight digest; it is checked through the adapter only.
  - **How the game reaches it (Corey, 2026-11-18, #1175).** Loading and choosing are kept apart:
    - **Loading is per process.** `initCoreSight()` (`shared/sight-core.ts`) binds the process's one core once, as
      `initPhysics` (`shared/physics/world.ts`) binds it for physics. It decides nothing.
    - **Choosing is per game.** `createGame`, already async and already giving each game its physics world,
      awaits it and attaches it beside physics (`shared/simulation/sight-runtime.ts`). That is a side table, so
      snapshots and replays never carry it, and none of `createGame`'s callers supply it.
    - **The tick passes it.** `discover()` takes the game's core binding, `sightOf(s)`, for every contestant,
      since discovery itself runs in the core (#1210), and a flag for line of sight, set for bots. A record from
      `createGameRecord` alone has no binding: its contestants start with nothing discovered until a game steps.
    - **The client** awaits `initCoreSight()` before its scene and hands the scene the caster (`api.sight`). The
      fog keeps one gate list per map and rewrites only `open`, so the core indexes the gates once, not per frame.
    - **Why not a module-level switch in `sight.ts`:** which implementation a game runs would be hidden process
      state. **Why not a parameter from every caller:** `createGame` is the one door a stepping game comes
      through, and its callers (the server, the physics lab, tools and tests) have no say in it.
  - **Checks.** `tests/sight-core.test.js` pins the polygons in Node, and `tests/sight-core.browser.mjs` holds
    Chrome's equal to Node's, byte for byte, through the client page's own load.

The adapter's shape, as the sight port settled it (adapter version 3):
- **Memory.** `core_alloc`/`core_free` give JavaScript 8-byte-aligned buffers to fill. The core copies what it
  keeps, so the adapter frees its upload buffers at once.
- **Handles.** A long-lived input becomes a handle: a pointer to a boxed Rust value, made once and freed by a
  `FinalizationRegistry` when the JavaScript list it mirrors is collected. Sight has two: an index per obstacle
  list, and a gate set per gate list, each cached as `sight.ts` caches its own.
- **Per call.** Mutable inputs are written in place into buffers the core owns (the open-gate mask). Scalars
  that select the work (origin, radius) are arguments. Results stay in a buffer the core owns, which JavaScript
  reads through a view.
- **Views are made after each call,** since any allocation can grow the memory and detach `memory.buffer`.
- **One function, not one scalar, per crossing:** a crossing returns a whole polygon, never a point.
- **After it,** navigation ([22.6](22.6-hierarchical-navigation.md)) and the shape queries
  (`shared/shape-queries.ts`, [29](29-geometry-and-drawing.md)).
  - **Before navigation:** settle whether the free-space mesh's clipping has one owner (#1186).

Each module must match the current tests bit for bit before its TypeScript version is deleted. The TypeScript is
deleted once its JavaScript callers have moved too. Until then, a module whose callers remain is kept on purpose,
with a shared digest test, as math is. Otherwise both versions exist only while they are compared. A half-ported
module is not left in place.

The browser instantiates WASM asynchronously. Every host therefore loads the core once, before anything that uses
it, rather than through synchronous imports: `createGame` awaits it for a game, and the client before its scene.

## The state flip

**Decided 2026-11-19** (#1066). These were agent recommendations in brief 16852; Corey approved all nine
(D1–D9) in comment 16861. The sequence is tracked under #1173.

- **The route (D1).** Port the tick phase by phase while the state stays in JavaScript. Each port is a pure
  function in the core: the adapter packs what the phase reads, runs it, and unpacks what it wrote, each tick.
  The frozen fixture checks every step unchanged. Packing follows the actors and the entities a phase touches,
  not the map. Once every writing phase is in Rust, the core keeps the state between ticks and the packing goes.
  - **Rejected:** moving the store first, which leaves a crossing per field for every phase still in
    TypeScript; and a big-bang port of the whole tick, which has no checkpoint before its end.
- **Rapier first (D2).** Rapier compiling into the crate (#1192) is the first step, before the flip
  ([Physics](#physics)).
- **Phase 2 stays in Node across the flip (D3).** Bots and human input consumption only read the pre-movement
  state and produce one intent per actor. They move into the core later, with the map format (#1215).
- **After the flip, two calls a tick (D4).**
  1. `tick_begin()` runs phase 1 and returns a change list.
  2. Node runs phase 2 against its mirror.
  3. `tick_finish(intents)` runs phases 3–7 and returns a second change list.
  - **The mirror.** Node keeps a read-only copy built from the change lists. Projection, recording, the
    private snapshot and the bots read it. Unchanged records keep their identity (#655).
  - **Phase 2's state is Node-owned** while phase 2 is in Node (reviews 957 and 958 on PR #1216). It lives in
    Node, outside the core's state, and the mirror's player record overlays it on the core's fields, so the
    private snapshot, recording and projection read one record. The intents carry everything phases 3–7 read, so
    none of it crosses into the core. It is:
    - **input bookkeeping:** `inputQueue`, `input`, `inputTick`, `lastSeq`, `receivedSeq`, `inputStalled`,
      `inputMargin`/`inputMarginNext` and `inputLeadTicks`. `setInput` writes some between ticks; `consumeInput`
      writes the rest in phase 2.
    - **the bot route,** `route`, which intent collection shifts in place and replanning replaces
      (`bots.ts`, `bot-routes.ts`). Bot side tables keyed by player objects are re-keyed by ID (#1214).
  - **Core writes to those fields come back as ordered facts.** Each core-side write is reported in the change
    list of the call it happens in, in write order. Node applies the list to the mirror when the call returns,
    before anything else reads the mirror. No snapshot is taken inside a call, so every write appears at the same
    boundary as today. The writes today:

    | Write | Where | Phase | Fields | Reaches the mirror |
    | --- | --- | --- | --- | --- |
    | Gladiator death, entering respawning | `phase_three.rs` (`actions_run`'s elimination, mode 4), applied by `phase-three.ts` | Wherever damage lands, 5–6 | `input` cleared | `tick_finish` |
    | Respawn | `phase_one.rs`, applied by `phase-one.ts` | 1 | `input` cleared, `inputTick` set, `route` cleared | `tick_begin` |
    | Transit arrival | `phase_one.rs`, applied by `phase-one.ts` | 1 | `inputTick` set | `tick_begin` |
    | Delayed transit departure | `phase_six.rs` (`transit`), applied by `phase-six.ts` | 6 | `input` and `route` cleared | `tick_finish` |
    | Instant transit | `phase_six.rs` (`transit`, landing), applied by `phase-six.ts` | 6 | `route` cleared only | `tick_finish` |
    | A gate opened or closed by its user | `phase_six.rs` (`interact`), applied by `phase-six.ts` | 6 | that player's `route` cleared | `tick_finish` |
    | A cell picked up | `phase_six.rs` (`pickups`), applied by `phase-six.ts` | 6 | `route` cleared | `tick_finish` |

    `clearRoute` sets an existing route to empty and leaves an absent one absent; the fact keeps that
    distinction. A port that adds, moves or drops one of these writes updates this table in the same change.
  - **Between-tick commands write Node-owned fields in Node** (review 959). Their existing code stays the owner of
    what each does to those fields: `joinGame` and `changeSeat` (`shared/simulation/state.ts`), `resume` and
    `leave` (`server/match.js`), and `teleport` (`shared/simulation/dev.ts`). Only their writes to core-owned
    fields go through the core call, and Node applies the call's change list to the mirror before the command
    returns. The differences that must survive, as the code has them today:

    | Command | Input bookkeeping | `route` |
    | --- | --- | --- |
    | Join | `resetInput` | Emptied if present (`clearRoute`) |
    | Resume | `resetInput` | Emptied if present |
    | Leave | `resetInput` | Kept |
    | Choose, same role | Unchanged; only the kit changes, when one is given | Kept |
    | Choose, a seat move | `resetInput` on both seats | Deleted on the seat left (absent); emptied on the seat taken |
    | Teleport | Unchanged | Emptied if present |

    `resetInput` resets the queue, `input`, `lastSeq`, `receivedSeq`, `inputStalled`, `inputMargin`/`inputMarginNext`
    and `inputLeadTicks`, and leaves `inputTick` as it was.
  - **The same tick boundary.** Snapshot, recording and projection are built after `tick_finish`, from the
    mirror with both change lists and that tick's phase-2 writes applied. They see what one in-place `step` shows
    today. The fixture's private snapshots, which keep `input` and `route`, check this at every step.
- **Between-tick commands (D5).** Roster changes, teleport and view lag stay separate calls, applied at once.
  Each call returns its own change list, which Node applies to the mirror before the call returns (review 957).
  A command's effect is then visible at once: a paused room's teleport takes and broadcasts a snapshot before
  any further tick (`server/room.js`), and that snapshot shows the moved pose. View lag splits by reader:
  `viewLagTicks` goes into the core, since rewind (`shared/simulation/rewind.ts`) reads it in combat, while
  `inputLeadTicks` bounds input stamps and stays with the Node-owned input bookkeeping.
  #1066's single command queue drained at the start of the step is not part of the flip: it would change what
  a between-tick snapshot shows, and nothing needs it. It stays an option.
- **IDs (D6).** `serial`, `itemSerial` and `scatterSerial` move into the core with the same allocation points and
  order. There are no unified generational IDs; that would be a rules change of its own. The tick draws no
  randomness. The one stateless hash, `itemRoll` (seed and label), is match setup's, so it moves with setup, bit for
  bit (step 5e.2).
- **The state's layout (D7).** Plain Rust structs in ordered `Vec`s (players in roster order, lists in their
  current order), with no ECS library. The export layout is the versioned contract, under `ADAPTER_VERSION`; the
  internal layout is free.
  - **Corey (comment 16861):** the tick's costs dwarf the details ECS addresses, but "using ECS like strategies
    where appropriate is desired, and with the assistance of AI, bespoke solutions may serve us better than a
    library anyway."
- **Compatibility.** The seven phases, roster order and `ordered(s)` order are kept, and
  `tests/tick-phases.test.js` stays their contract. The `Snapshot` type and the recording frame are built in Node,
  unchanged: no schema or `WIRE_VERSION` change. Replays never resimulate ([26](26-recording-contract.md#playback)),
  so they are unaffected. Every step but Rapier's passes the fixture unchanged.
- **Rapier's continuity proof (D8).** If moving Rapier moves the fixture, a bit-level proof across engines is
  impossible. Instead:
  - every scripted label still does what it says;
  - each bot match still completes, with its outcome counts reported beside the old ones;
  - the digests are then recaptured in a separate commit.

| Step | Issue | Behaviour |
| --- | --- | --- |
| 1 | Rapier into the crate, behind `shared/physics/world.ts`'s interface; client prediction switches too, and rapier.js retires (#1192) | The one decided recapture, if needed |
| 2 | Discovery in the core (#1210) | Preserved |
| 3 | Live items, gates and traps off `s.map`, in TypeScript (#1211) | Preserved |
| 4 | Phase 1 and the ID counters in the core (#1212) | Preserved |
| 5 | Phases 3–7 in the core (#1213): actions; phase 4's floor drag and the solver around it, with the write-back of item and actor poses and `movedThisTick` and the contact drain; then 5–7 | Preserved |
| 6 | The flip: the core keeps the state, Node mirrors it (#1214) | Preserved |
| Later | Bots and navigation in the core, with the language-neutral map format (#1215) | Preserved |

**Step 2, discovery (#1210, adapter version 5).** `rust/core/src/discovery.rs` is the rule `discover` was; `discover`
in `shared/discovery.ts` is now its adapter, through the game's binding (`shared/sight-core.ts`).
- **Uploaded once per map:** the discovery grid with the rule's constants (which `discovery.ts` still owns), which
  cells' centres are playable ground (`insideMap`), the landmarks with their cells, and the roofs (`roofTables` in
  `shared/view.ts`). The handle is keyed on the map's playable area and rebuilt when another field it read differs.
- **Packed per sample, near the eye:** the items within reach (`itemsNear`), the remembered items near the eye,
  the boxes of the doors near it (`gatesNear`, `gateShape`) and the reach window's seen flags, so the polygon is
  still built only when something unseen needs it. JavaScript keeps the queries, which have other callers.
- **Applied in the rule's order:** discovered cells, surveyed cells, seen cells, then items remembered and
  forgotten, then doors (`observeGate`), so set and map insertion orders, and a bot's ties, are unchanged.
- **The roof rule has two copies on purpose.** `roofAt` keeps JavaScript callers (the fog, projection,
  `simulation/visibility.ts`), so the core's port is held equal to it by `tests/discovery.test.js` ("the core
  reads roofs as roofAt does"), as math is by its digests. `litPoint` stays in `sight.ts` for the fog too.
  Giving each one owner again, once its callers move, is #1222.
- **Cost:** [42.62](42.62-discovery-core-adapter.md). The crossing is about 2% of the TypeScript's cost.

**Step 3, the live stores (#1211).** The ground and the traps are the game's (`s.items`, `s.traps`), and the doors are
`s.gates`. `s.map` is the arena (`MatchMap` in `shared/types.ts`), which nothing in a match writes; its geometry is pinned once the game is prepared, as before.
- **One object, emptied.** `createGameRecord` takes the lists off the map it is given and keeps that map object, so
  caches keyed on it, and on its lists, still hit. The lists keep their identity and order; the ground's indexes
  (`ground-items.ts`) were already keyed on the list, not the map.
- **Doors are one list read two ways.** `s.gates` is `s.map.gates`, and preparation refuses a game where they differ.
  The game reads door state through `s.gates` (frames, physics, interactions); collision and sight read the same
  records as geometry through the map, as the core's gate set does. Only `open` and `locked` change in a match.
  Since step 6a (below) the core keeps that state and the records mirror it.
- **Stations and chargers stay on the map.** Nothing writes them in a match, so they are static data, and discovery's
  upload still reads them from there.
- **What is sent is unchanged.** The server rebuilds the whole map for a client or a recording with `wholeMap`
  (`shared/simulation/state.ts`), which puts the lists back in the map's own field order, so the payload's JSON is
  byte for byte what it was.
- **Discovery** takes the ground as an argument (`discover(..., lineOfSight, ground)`), which the tick and
  `createGameRecord` pass as `s.items`. A bare map's own `items` is the default, for tools and tests.

**Step 4, phase 1's rules (#1212, adapter version 6).** `rust/core/src/phase_one.rs` advances the tick, the hazard wall
and the effects' lives, then per player in roster order runs respawn, transit arrival and an active player's timers.
`beginTick` (`shared/simulation/phase-one.ts`) packs the players, effects and stations each tick and applies the result.
- **Facts in allocation order.** The core takes every ID it allocates from `serial`, which is packed in and out (D6),
  and reports each respawn and landing as a fact with its ID. `beginTick` applies them in order: the event and effect
  records, built by `event` and `effect` with the core's IDs, and the Node-owned writes of the change-list table above.
- **Both queries run in the core since #1234:** whether a station is clear for a respawn (`canOccupy` at
  `RESPAWN_CLEARANCE_RADIUS`) and where a transit lands (the placement search the body sync shares). Until then
  they stayed in JavaScript, and the run stopped before a player that needed one and resumed from it. Station
  clearance had been tied to the bots' port (#1215) because nothing in the core could answer `canOccupy`; the core's
  collision queries (step 5b.2) removed that reason. So Corey decided (2026-11-20, on #1233) that both stops retire
  together in #1234, which removed the yield and resume (the resume index, the "advanced" flag and the answer
  flags) in one change. A landing reads the players before it as the run has left them, as the TypeScript tick did.
- **The rest of phase 1** moved in step 5b.3 (#1234), except the hook revalidation and the trap spawns (below).
- **The item counters stay in TypeScript for now.** Phase 1 allocates no item IDs. `itemSerial` and `scatterSerial`
  are allocated only in phases 3 and 6 (`item-instances.ts`, the drop planner and pickups), so they move into the core
  with those phases (#1213), starting with the phase 3 loop (5c.2, #1238).
- **Cost:** [42.63](42.63-phase-one-core-adapter.md). About 1.8 µs a tick: over 42.58's relative budget, because the
  rules are tiny, and about 0.06% of the tick. It is accepted under
  [42.58's state-flip exception](42.58-sight-core-adapter.md#the-budget), which ends with the flip (#1214).

**Step 5 is staged** under #1213, each stage passing the fixture unchanged:
- #1226: phase 4's glue;
- #1227: the physics adapter's bookkeeping and phase 1's remainder, in three stages:
  - #1232: the world's records, generations, queues and ID order;
  - #1233: the map's collision queries (`canOccupy`, `reachClear`), which the landing placement and attachment
    admission need;
  - #1234: `synchronize`, the pending admission and the landing placement, which retires `NEED_LANDING`, and
    the station clearance, which retires `NEED_STATIONS` with it, so phase 1's yield and resume go in one change
    (Corey, 2026-11-20, on #1233). `prepareHooks` was planned here too but moved to #1229 (step 5b.3, below);
- #1228: phase 3 with the item counters, in two stages:
  - 5c.1 (#1228): the drop planner's spiral search, with its loot-body test;
  - 5c.2 (#1238): the phase 3 loop, the rest of the planner and the item counters;
- #1229: phase 5, in two stages:
  - 5d.1 (#1229): the swept queries, with the hook's rules after launch (`prepareHooks`, `finishHooks`, `reconcileHooks`),
    which share them;
  - 5d.2 (#1242): projectiles, the warden skill, damage and elimination, and rewind;
- #1230: phases 6 and 7, in two stages:
  - 5e.1 (#1230): phase 6's per-actor loop, which is interactions, transit, charging and pickups;
  - 5e.2 (#1245): phase 6's environment and traps, phase 7 and `itemRoll`.

The physics adapter goes before phase 3 because drops and attacks call into it (`launchPhysicalDrops`, impulses, attachments).

**Step 5a, phase 4's glue (#1226, adapter version 7).**
- **Floor drag runs in the core.** It lives in `rust/core/src/floor_drag.rs`, called by the world before the solve.
  - **Sent once per world:** the motor surfaces, in the motor's priority and ID order, and the loot and prop damping profiles. `applyFloorDrag` in `world-physics.ts` keys the upload on the surface list and the profile.
  - **Classes are fixed when a body is added:** a prop in the loot group follows loot's profile, any other prop follows prop's, and nothing else is dragged.
  - **Only changes come back.** The core holds each body's damping as `f64`, with unset read as 0, and reports only what changed. `world.ts` writes those values into the body specs as `setDamping` did, so the gameplay snapshot reads the same specs.
- **Poses come from the step's output.** The end of a body's path is its pose after the solve, so the write-back of items and actors (`p.x`, `p.y`, `movedThisTick`) reads the paths instead of one `getTransform` call per body. JavaScript still writes the records, which it owns until #1214.
- **The tick keeps no contacts.** `step({ discardContacts: true })` builds no contact records but still enforces the 8,192-fact capacity. Gameplay has no contact damage, so the tick drained and dropped them anyway.
- **Cost:** [42.64](42.64-phase-four-glue-core.md).

**Step 5b.1, the world's bookkeeping (#1232, adapter version 8).** `rust/core/src/world.rs` holds what
`shared/physics/world.ts` kept beside the engine. That is the body records (slot, generation, kind, speed cap, motor),
the mutation queues with their capacity checks and commit order, the constraints in insertion order, the retained
contacts, and every ordering by ID. It calls the engine (`physics.rs`) in the order world.ts did, so Rapier allocates
the same handles and slots.
- **IDs cross once.** world.ts interns each ID string to a key, sending its UTF-16 code units to the core the first
  time it is seen. The core compares those units, so its ID order is JavaScript's `<`. Every later call names keys.
- **JavaScript keeps** spec validation, the intern table, and the frozen spec, motor and lifetime objects that
  snapshots share (#655). A commit reports its facts (bodies removed and added, constraints added), and world.ts
  applies them to those records. JavaScript owns them until the flip (#1214), which removes them.
- **The same refusals.** The core returns a code, and world.ts throws the old message. Values are validated, and an
  unknown dynamic body refused, in world.ts's old order before the call.
- **The step packs nothing.** The core has the motors, caps, pushes and constraints. Its output names the dynamic
  bodies by key, followed by their paths.
- **Cost:** [42.65](42.65-world-bookkeeping-core.md).

**Step 5b.2, the map's collision queries (#1233, adapter version 9).** `rust/core/src/collision.rs` answers
`canOccupy` (`shared/movement.ts`, with `insideMap`), `lineClear` and `reachClear` (`shared/sight.ts`) bit for bit.
#1234 gave them their first callers in the tick (step 5b.3).
- **Uploaded once per map:** a collision map per obstacle list, holding the playable cells and each obstacle as a
  collider (bounds, see-through or not, shape), with movement's cells (`collisionTables`). It is rebuilt when the list
  grows or the map's size or playable area differs. Sight's two handles carry the rest: the sight index now also holds
  the see-through obstacles' edges, which stop hands, and the gate set each gate's box (`gateShape`).
- **Gate state is read live,** from the gate set's open mask. Until step 6a the adapter wrote it before each call, as
  for sight; since then a game's gate set holds it. A gate `lineClear` ignores is held open for the query.
- **The disk tests are SAT.js's,** `testCircleCircle` and `testCirclePolygon` as `diskPenetration` calls them,
  including SAT's `x || 0` on constructed vectors and its merging of repeated points. The 0.01 obstacle tolerance and
  contact-blocks-at-a-gate are `canOccupy`'s.
- **Two copies on purpose,** as the roof rule's are: the TypeScript keeps its callers (movement, bots, tools), and
  `tests/collision-core.test.js` holds the two equal, depth for depth on every collider of the room arena and answer
  for answer at the places tolerances decide, with gates toggled between calls. Giving each one owner again is #1215
  and #1222.
- **Cost:** [42.66](42.66-collision-queries-core.md). A query costs about a quarter of the TypeScript's; the open mask,
  about 0.55 µs for 421 gates, is the part to write once per batch.

**Step 5b.3, the tick boundary's body work (#1234, adapter version 10).** `rust/core/src/boundary.rs` runs the body
sync (`synchronize` in `game.ts`, with `synchronizePhysicalItems`) and phase 1's admission of the pending impulses and
attachments; `placement.rs` is the placement search that the sync, phase 1's landing and phase 6's instant transit
share. `shared/simulation/boundary.ts` is their adapter, and phase 1 (`phase_one.rs`) answers its station clearance
and landing itself, in one call a tick.
- **The core drives the world.** The sync queues, commits and teleports in `world.rs` itself, in the TypeScript's order,
  so Rapier allocates the same handles. JavaScript still owns the frozen spec records (step 5b.1), so the call returns a
  **log**: each write the TypeScript made to a JavaScript record, in order. That is a body queued (with the template its
  spec is built from), a commit's facts, a teleport, a discontinuity marker, the runtime's actor, item and gate state,
  and a player's pose or retry. `world.ts` takes the world's entries (`adoptQueued`, `adoptCommit`, `adoptTeleport`),
  building the specs `queueAddBody` built, and the adapter writes the rest.
- **The same refusals, at the same point.** The core emulates what made the TypeScript throw partway, including
  `markPhysicsDiscontinuity`'s capacity and `validateBody`'s checks on the values it sets. It stops there; JavaScript
  applies the log before the stop, then throws the old message. `tests/boundary-core.test.js` refuses a sync partway
  and checks that the records and the world agree and that the next sync finishes.
- **Two calls per sync.** The first does the actors, the gates and the removal of item bodies whose items left the
  ground, then reports whether any item could be admitted. Only then are the items awaiting a body packed, since a
  large map has thousands; a tick with no room packs none, as the TypeScript skipped ordering them.
- **The admission decides; JavaScript queues.** The core checks each pending impulse's and attachment's generations,
  transforms, reach and `reachClear`. The admitted are queued through `world.ts`, which keeps their specs. With
  nothing pending there is no call. The attachment queue is drained only after every admitted impulse has queued, as
  before, so an impulse the world refuses leaves the attachments pending (review 975).
- **The log's entries are typed in Rust** (`Entry`, with one encoder), so each kind's words are written in one place;
  the flat layout JavaScript reads is unchanged.
- **Handles are passed in.** Each call takes the collision map, sight index and gate set (`queryHandles` in
  `shared/sight-core.ts`) and writes the open mask once. Phase 1 writes it only when a player is respawning or in
  transit, and the admission only when an attachment is pending. `createGame` builds the three uploads with the map
  (`prepareCollision`), so no tick builds them.
- **What stays in JavaScript:**
  - the pending queues' generation filter at the end of the sync, which reads one generation per entry of queues
    this runtime owns;
  - the trap spawns, which are projectile records;
  - the hook's revalidation (`prepareHooks`, `reconcileHooks`), until step 5d.1 (below) moved it with the swept query
    it asks. `reconcileHooks` is still the sync's last step, so the order is unchanged.
- **The loot-body test has one owner,** `loot_fits` in `placement.rs`, since step 5c.1 (#1228, review 977): the sync's
  item admission and the drop planner's search both ask it. The TypeScript placement search is gone; the parity test
  keeps it as its reference.
- **Cost:** [42.67](42.67-boundary-core.md).

**Step 5c.1, the drop planner's spiral search (#1228, adapter version 11).** `rust/core/src/scatter.rs` is `scatterPoint`
(`shared/simulation/loot.ts`), with the loot-body test `physicalDropPlacementClear` was: 180 spots of the spiral, each
tested against the map (`can_occupy` at 16), the dropper's reach (`reach_clear`), the listed records and the drop's
earlier spots (more than 32), then the solid props and the active actors (`loot_fits`, which the body sync's item
admission shares), in the TypeScript's order. `scatterInCore`
(`shared/simulation/boundary.ts`) is its adapter, one call per search, through the world's boundary input.
- **Why this seam first.** #1228 held the whole action loop with the planner and item identity, about twice a stage
  (32, rule 4). The search is what the loop's drops need from the core, and it already has callers in phases 3, 5
  (elimination's mandatory drops) and 6 (a swap's outgoing drop). The loop, the rest of the planner and the item
  counters are 5c.2 (#1238), below.
- **Packed per search:** the active actors' disks and only the records within reach of the spiral (372 plus the 32
  spacing). On the ground list the grid finds them (`itemsNear`); a staged list, a swap's, is filtered whole, as the
  TypeScript read it whole. A record with a NaN coordinate is always packed, since it refuses every spot, as the grid
  always offers it (review 977).
- **Chosen per game, as sight is.** A game with a physics world searches in the core. A record without one, which is
  match setup's `seedAmmo` inside `createGameRecord` before `createGame` attaches the world, and tests on bare
  records, searches in TypeScript, where no body needs room, so that copy has no loot-body test.
- **Two copies on purpose,** as the roof rule's are: the TypeScript spiral keeps setup's caller. `tests/drop-scatter-core.test.js`
  holds the core equal to the TypeScript search it replaced, near crates, gates, a prop, actors, ground records and
  earlier spots, on the ground and on a staged list, and counts cases that the prop test and the actor test each
  decided. Each of the prop, actor and spacing tests was sabotaged in the core and caught. Giving the spiral one owner
  again needs setup to run with the core bound.
- **Cost:** [42.68](42.68-drop-scatter-core.md).

**Step 5c.2, phase 3 and item allocation (#1238, adapter version 13).** `phase_three.rs` runs the action loop in
`ordered(s)` order: heading, selection, rearrangement, utility use, slot and reserve drops, reload, non-warden
skills, contestant attack and motor. `action_equipment.rs` and `action_combat.rs` own its equipment, reload,
attack, skill and motor rules; the motor is set directly in the world's records. `phase-three.ts` packs and
applies their flat records and facts. Until 5d.2 the shared attack also served phase 5's gladiator through that
adapter, with a TypeScript damage callback; since 5d.2 (below) the gladiator attacks in phase 5's own run, and the
adapter's attack serves a contestant's scenario call only. Action and plan types live in the leaf `action-records.ts`,
and event and effect records in the leaf `event-records.ts`, so the core adapter does not import its callers.
- **A successful drop is a sync boundary.** The loop returns after committing a slot or reserve drop. Node applies
  its ground records through `addItems`, launches them and runs the existing chunked admission; the next call
  resumes at the next operation of the same player, with all poses repacked. A slot drop and an ammo drop in one
  input have separate syncs, and later actors see their committed bodies. This deliberately uses the stop option
  from #1238: admission reads Node's indexed ground records and may place actors again, so supplying it inside
  one call would require an upload of waiting ground items or another admission protocol. Phase 1's retired
  query stops had no such Node-owned input. Ticks without a successful drop use one loop call.
- **The planner runs directly over the core's queries.** `drop_planner.rs` validates, searches through
  `scatter_point`, checks uniqueness and stages every allocation before publishing a complete plan. Capacity is
  checked before search, uniqueness after it; mandatory fallback spots join the earlier spots. Callers in phases
  5 and 6 share this planner through the adapter, including staged swap lists with NaN coordinates.
- **IDs are allocated in the core.** `createGame` passes the `item_allocation.rs` binding into `createGameRecord`,
  before normalization and ammo seeding. The record's `itemAllocator` is copied into tentative allocation forks;
  an unbound record always uses its TypeScript setup allocator, regardless of other games' initialization.
  Node keeps the label registry and supplies free
  `instance-N` phases; the core reports registrations in allocation order. Forked plans publish only into their
  own registry layer. Bare synchronous records without an explicit binding retain their setup path; a bare record's
  planner and attack retain TypeScript because it has no physics world and cannot step.
- **Packing follows reads.** Only actors with an intent cross as action records. Inventories cross for selection,
  move, drops, reloads or an eligible attack; ground positions come from the drop origins' bounded grid queries,
  and registry checks concern only relevant identities. Hearing and specter targets use compact context rows.
  Content and motor surfaces upload once per world. An absence mask keeps a missing item field distinct from
  explicit NaN; object tokens retain carried object identity through moves, merges and consumption. The
  snapshot, recording frame and wire version are unchanged.
- **Shared parameters, retained arithmetic.** `movement.ts` owns `MOVEMENT_SPEED`; `rules.ts` owns `HZ`, and
  `action-records.ts` owns `UTILITY_RULES`. They upload with the content through `actions_configure`, so the core
  has no independent copy of the speed multipliers, utility amounts/cap or utility cooldown. `actorMotor`, the
  unused TypeScript reload advancement and TypeScript rearrangement have retired. Equipment tests now exercise
  the core action loop, and the prediction contract checks the actual core motor.
- **Two copies on purpose.** These remaining callers still need a TypeScript rule. Each row names its equality
  evidence and the issue that will resolve ownership; any rule change must update both implementations until then.

  | Rule and core owner | Remaining TypeScript caller | Equality evidence | One owner again |
  | --- | --- | --- | --- |
  | Motor, `action_combat::motor` | Client prediction's `movementSpeed` and `characterMotor` | `physics-prediction-contract` compares actual core motors across roles, boost/stun/sneak, zero input and surface ties; parameters are shared | #1241 decides a batched core caller versus retained prediction arithmetic with parity |
  | Utility outcome, `action_combat::attack` | Bots' `utilityOutcome` preview and bare-record attack | Shared `UTILITY_RULES`/`HZ`; `utility-use` compares preview with actual core use, including caps/refusal | #1215 moves bot previews; #1241 owns remaining setup callers |
  | Contestant attack/hearing, `action_combat::attack` and `phase_three.rs` | Bare-record/scenario fallback in `combat.ts` and `hearing.ts` | `action-parity` directly compares firearm, utility and heard-cue state/facts with the core; frozen characterization covers live calls. The gladiator's melee has had no TypeScript copy since 5d.2 | #1241 |
  | Non-warden skill and hook launch/cancel, `phase_three.rs`/`action_combat.rs` | Direct scenario entry points in `combat.ts` and `hook.ts` | `action-parity` compares specter/striker and hook launch/cancel with the core; `phase-three-core` covers key-zero capacity and refusal ordering | #1241. The hook's later rules (5d.1) and the warden skill (5d.2) moved with no TypeScript copy |
  | Drop plans, `drop_planner.rs` | Bare setup planners in `loot.ts` | `action-parity` compares complete plans, staged allocations and NaN/fallback refusals on common empty-world geometry; 5c.1 documents the intentional physics-only loot-body test | #1241 |
  | Item allocation, `item_allocation.rs` | Explicitly unbound setup records | `item-id-allocation` checks selection before/after another game initializes, actual Rust operations and fork isolation; setup/live suites check the same allocation expectations | #1241 |
  | Equipment access, validation and weapon selection, `action_equipment.rs` | Bot reads in `equipment.ts`/`item-instances.ts` | `equipment`, `item-instances`, `action-parity` and frozen characterization cover the core action and retained validation paths; weapon parameters remain content-owned | #1215 moves bot reads, #1241 owns remaining setup callers. Phase 6's writers moved in 5e.1 (next row) |
  | Pickup transfer, `phase_six.rs` (`collect_equipment`, `collect_ammo`) | `collectInstanceEquipment` and `collectAmmo` in `equipment.ts`, which tests and scenarios use to arrange inventories | `phase-six-core` compares each kind of pickup (new, merged, split, refilled, reserve, key, refused) on games with and without reloading: inventory as JSON, so key order counts, plus the reserves, the keys, the record left and both counters | #1241 |
  | Transit options and time, `phase_six.rs` (`transit`) | `transitOptions` (the client's menu) and `transitTicks` (gladiator bots' hunting) in `transit.ts` | `transit` covers each refused destination, plain interact's next station and a delayed arrival's tick against `transitTicks` | #1215 moves the bots' read; the client's menu stays a presentation copy |

- **Cost:** [42.69](42.69-phase-three-core.md), under 42.58's state-flip exception; remeasure at #1214.

**Step 5d.1, the swept queries and the hook's later rules (#1229, adapter version 14).** `rust/core/src/swept.rs` is
`geometryContact` (`shared/simulation/swept.ts`), with `firstContact` and `segmentShapeDistance` (`shape-queries.ts`).
`rust/core/src/hooks.rs` runs `prepareHooks`, `finishHooks` and `reconcileHooks` over it, and `hook.ts` is their adapter.
Launch and cancel are phase 3's, as before.
- **Uploaded once per map.** A swept map holds the solid static shapes in `buildPhysicsGeometry`'s order, which the
  bisection's last bits depend on, each with whether shots also meet it (a see-through obstacle does not), and every
  gate's closed shape. It is uploaded from `swept.ts`'s own caches (`sweptUpload`), so the core sweeps the very shapes
  the TypeScript does. It is its own handle (`sweptHandle`), not one of `queryHandles`, so calls that never sweep do not
  build it. `createGame` builds it (`prepareSwept`) after `prepareSweptGeometry` and `prepareSweptGates`, from the caches they
  built while yielding (review 982). It is rebuilt when the map's size, playable area or gate list differs, as the
  collision map is. Gates are read live from the gate set's open mask.
- **Solid props are read from the world.** `world.rs` keeps each solid prop's shape as queued, and the core builds
  `bodyShape` at the prop's current pose, reading again after every commit.
- **The hooks stay in JavaScript (D1).** Each call packs the hooks, the roster's keys, status, kit, role and pose and,
  for the tip, the actors' substep paths. The core reads generations, poses and constraints live and queues and commits
  where the TypeScript did, so the world's facts keep their order. It returns a log: each rope queued (`hook.ts` builds
  its frozen spec through `adoptQueuedConstraint`), each commit's facts and each hook removed, then each hook's fields.
  `hook.ts` writes those fields in the order the TypeScript first wrote them, so a hook's keys keep their order in the
  gameplay snapshot (`physicsState`). A refusal stops the call where the TypeScript threw. With no hook there is no
  call, only the commit each rule ended with.
- **No TypeScript copy of the hook's later rules.** They have no caller outside the tick. `characterization-physics`
  (its scripted `hook` label), the bots variant and `tests/physics-hook.test.js` cover flight, hits, attachment, the
  pull, standoff, gates, void, props and roster changes.
- **Two copies of the sweep, on purpose.** Projectiles swept in TypeScript until 5d.2 (#1242). The TypeScript
  `geometryContact` now has no caller in the game and stays as the reference, as 5c.1 kept the placement search:
  `tests/swept-core.test.js` holds `swept.rs` equal to it to the bit. It covers both policies on the
  room arena's statics and gates, with gates toggled between calls, rotated and degenerate extra shapes, and the
  world's solid props, rotated, against `solidContact`. `solidContact` keeps that test as its only caller. A sabotaged
  prop rotation is caught.
- **Cost:** [42.70](42.70-hook-core.md). A call costs 2–5 µs. That is less than the TypeScript for a pulling hook and
  more for a flying hook's reconciliation; at most about 0.1% of the tick, under 42.58's state-flip exception.

**Step 5d.2, the rest of phase 5 (#1242, adapter version 15).** `rust/core/src/combat.rs` runs projectile flight
(`solvePhysicsProjectiles`), the end-of-tick casters (the warden skill, then the gladiator attack, in `ordered(s)`
order) and `damage`, with the rewind reads (`asSeenBy`) the casters resolve against. The elimination (`eliminate`) is
`actions_run`'s mode 4 in `phase_three.rs`, beside the drop planner it calls. `shared/simulation/phase-five.ts` is the
adapter; `combat.ts`'s `damage` and `lifecycle.ts`'s `eliminate` are now entry points into it.
- **The order is 29.2's.** Projectiles first: every bullet is swept (the shot policy of `swept.rs`, radius 2, against
  each actor's substep path, `impact` and `hit_radius` now in `swept.rs`), then the hits apply by time of impact, bullet
  ID and target ID. `finishHooks` runs next, in Node as before, then the casters, each one's status read at its turn.
  A hit kills before the hook attaches, so a dead target never attaches.
- **A kill is a stop.** When damage kills, the run returns before anything of the elimination is written. Node runs
  the elimination, then resumes the run. The core keeps what the run needs across that: the sorted hits and the
  bullets spent, or the caster and target it stopped at. Everything else is repacked, so a resume reads what the
  elimination and its syncs left, as the TypeScript read the live records.
- **The elimination keeps 5c.2's sync boundary.** Its steps are the lifecycle, each slot's mandatory drop, each
  reserve family's, then the inventory's clear and the kill credit. Each committed drop returns, Node publishes and
  launches its records and admits them, and the next call resumes at the next step. The target leaves no disk for the
  loot-body test, since it is no longer active when its loot drops.
- **Writes keep their order.** The elimination reports its lifecycle as one fact (status, the event with its ID,
  `charging`, then a gladiator's `respawnAt` and the cleared `input`, D4's table), the `reload = null` that
  `dropReserves` wrote even where `reload` was absent, and the kill credit. Damage reports `aggressor` and
  `aggressionUntil` as a fact, in that order. Fields that always exist are written back where they changed.
- **Rewind's frames are read in the core.** Until 5e.2 `recordRewind` wrote `s.rewind` in Node, and a caster run
  packed the frames when a caster's view lagged. Since 5e.2 phase 7 records them in the core, so none cross.
- **Event and effect records** (`event`, `effect`, `participant`) moved from `loot.ts` to the leaf
  `event-records.ts`, so the adapters build the records the core's facts name without importing their callers.
- **No TypeScript copy.** `damage`, `eliminate`, the warden skill, the gladiator attack and the projectile sweep have
  no record-level copy: their only bare-record callers were tests, which now build real games
  (`tests/physics-projectiles.test.js`, the mine case in `tests/physics-explosion.test.js`), and `action-parity` no
  longer compares melee. Scenario `attack` and `skill` calls for a gladiator or warden run the caster run, which skips
  a caster that is not active, as the tick did. Phase 6's environment and traps call the core's damage directly
  since 5e.2 (#1245).
- **Cost:** [42.71](42.71-phase-five-core.md).

**Step 5e.1, phase 6's per-actor loop (#1230, adapter version 16).** `rust/core/src/phase_six.rs` runs, in `ordered(s)`
order, each active actor's `interact`, its chosen `transit`, then, while it is still active, `advanceCharging` and
`automaticPickups`. That covers extraction, the start of charging, the swap's staged pickup and drop, gates with their
keys, a gladiator's transit and the sensors' reveal. `shared/simulation/phase-six.ts` is the adapter. `interact`,
`transit`, `advanceCharging` and `automaticPickups` are now entry points into it.
- **Every write is an ordered fact.** Several writes create keys where they are absent, so the call writes no rows
  back. Each write returns as a fact, in the TypeScript's order, and Node applies the facts in turn. Those keys are a
  player's `charging`, `selectedSlot` and `transit`, a gate's `locked` and a carried cell's `charge`. Node-owned
  writes come back the same way (D4's table): a route cleared, and a delayed transit's `input`.
- **Stops keep 5c.2's sync boundary.** Three events end the call:
  - **A record taken whole.** Node removes it and synchronizes, as `automaticPickups` did.
  - **A committed swap.** Node removes the pickup, adds the outgoing drop and launches it.
  - **An instant transit's landing.** This actor's pickups must read the ground where it now stands.

  The next call resumes at the next step of the same actor, with everything repacked. After a pickup, Node also
  hands back the records still to visit, by the TypeScript's rule: the rest of the list or, when the sync placed the
  actor again, a fresh query of those after it.
- **A partial take is not a stop.** The record's draft returns as a fact, and later actors in the same call read the
  run's change. A gate opened or closed is written into the gate set's open mask at once, so later reach and sight
  tests see it.
- **The swap is staged in the core.** The pickup is collected into a draft of the player on a copy of the
  allocation. The outgoing item's drop is planned around the ground without the pickup (`drop_planner.rs`), and its
  bodies are preflighted with the pickup's body released. Only a complete swap commits. Node packs the swap's
  candidates, with their labels' rank, and the records within the spiral's reach.
- **The core finds the gates.** It queries its own gate set's buckets, which are `gateIndex`'s, for the gates near an
  interacting actor, then sorts them into map order as `gatesNear` does. A gate's position and kind never change in
  a match, so they cross once per gate set; the adapter asks the set whether it holds them (`gate_set_details`).
  Locks change, so each call with an interaction writes them into a mask beside the open mask (`gate_set_locked`).
  The adapter writes both masks in one pass over the gates. Node's string-keyed bucket query cost about 15 µs a tick
  in the bench, where bots interact on most ticks. `phase-six-core` holds the core's choice of gate equal to
  `nearbyGate` over a cluster of doors, including ties and a door behind another.
- **Packing follows reads.** An actor's inventory crosses only when the turn can read it: when it interacts, is
  charging, has records in reach or can swap. A gladiator with nothing to do crosses as one row.
  - **Near records are trimmed.** Of the records the grid offers, only those within a box one unit wider than the
    pickup reach cross. A record with a NaN coordinate always crosses, since the distance test does not refuse it. The
    core makes the exact test.
  - **Free label phases are counted.** Only as many cross as the call can allocate: one per carried item without an
    identity, one per record in reach, and ten for a swap.
  - **The open mask is written only when needed.** Only a call that tests reach, sight or a gate writes it.
  - **The input is written in place.** It goes into a reusable typed buffer, then into the core's buffer in one copy.
- **Two copies on purpose.** The pickup transfer and the transit rules keep TypeScript callers; see the ledger rows
  above.
- **Cost:** [42.72](42.72-phase-six-core.md).

**Step 5e.2, the rest of phase 6 and phase 7 (#1245, adapter version 17).** `rust/core/src/hazards.rs` runs
`applyEnvironment` (the hazard wall, then the hazard areas) for each active actor in `ordered(s)` order, then `stepTraps`
(mine, turret, flame and spider) in map order, in one call. `rust/core/src/phase_seven.rs` runs `finishMatch` and keeps
the rewind frames. `shared/simulation/hazards.ts` and `phase-seven.ts` are their adapters. `shared/traps.ts` and the
TypeScript `applyEnvironment`, `finishMatch`, `recordRewind` and `asSeenBy` are gone.
- **Damage is the core's, called directly** (`combat::Run::damage`). The hazards run packs the roster as phase 5's rows,
  plus each actor's `movedThisTick`, so the two phases share one row format and one write-back (`phase-five.ts`).
- **Two stops, both at a sync boundary.**
  - **A kill.** The run returns before anything of the elimination is written. Node runs it (`eliminateInCore`, 5d.2),
    whose mandatory drops each return at 5c.2's sync boundary. The run then resumes from the core's cursor with
    everything repacked, so the next actor or trap reads the live records, as the TypeScript did. A spider's grapple
    effect is placed after the elimination, where it left the target.
  - **A mine's explosion.** Its impulses (`enqueueExplosionImpulses`) are **kept in Node, at a stop.** They synchronize
    the world, read its body snapshot, and fill the pending-impulse queue. That queue is Node's until the flip (#1214),
    and phase 1's admission reads it there (5b.3). Porting them now would mean moving that queue into the core ahead of
    the flip, or adding a second admission protocol. A mine explodes at most once a match, so the stop costs nothing
    measurable. The impulses move with the queue at #1214.
- **Trap records keep their key order.** Authored traps carry only their kind's fields, and `stepTraps` creates keys:
  `cooldown` on every live trap each tick, `spent` when a mine fires, and `aiming`, `heading`, `targetId`, `firing`
  and `warning` where absent. The core returns each written trap with a mask of its writes, and Node writes them in
  one order that every kind's own order agrees with: `cooldown`, `spent`, `aiming`, `targetId`, `heading`, the
  position, `firing`, `warning`.
- **The turret's spawns go straight to `pendingSpawns`.** Each comes back in the log as a fact with the core's ID, and
  is admitted at the next tick's phase 1 as before. The tick no longer splices them off `s.projectiles`.
- **`finishMatch` reports, Node writes.** The match's phase, the stranded statuses and the `match_finished` event stay
  Node's records until the flip. The call reports whether the match finished, the event's ID and who is stranded.
  It runs after discovery and before the last sync, as before.
- **The rewind frames are the core's own.** `recordRewind` packs each player's position after the last sync, and the
  caster run reads the frames in place. `s.rewind` is gone from the game record; it never reached a snapshot or a
  recording. The window, `MAX_REWIND_TICKS`, is one constant in the core. `rewind.ts` keeps its own copy for
  `viewLagFrom`, which bounds a view's lag in Node.
- **`itemRoll` is not ported (D6).** No tick calls it. Its only caller is match setup (`assignWeaponQualities` in
  `createGameRecord`), which stays in TypeScript and hands the core finished qualities. A port now would be a second
  copy whose only caller is its parity test. It moves with setup, with a parity test then. #1214 holds the pickup.
- **No TypeScript copy.** `tests/physics-explosion.test.js` and `tests/traps.test.js` run real games. The bare-record
  mine case and `tests/player-relations.test.js`'s rewind case are gone: the core keeps frames by roster slot and never
  reads an ID, and `tests/rewind.test.js` covers lagged reads through the core.
- **Continuity.** The frozen fixture clears traps, and its maps place none, so it does not witness this stage's
  traps. An ad hoc trace did: bot matches on the fixture's two arenas with about 300 traps of all four kinds, about 85
  hazard areas and lagging gladiators. It hashed every tick's snapshot and projections, the trap records as JSON (so key
  order counts), the pending spawns and the pending impulses. Every hash matched between a pristine export of `main`
  and this change ([42.73](42.73-phase-six-seven-core.md)).
- **Cost:** [42.73](42.73-phase-six-seven-core.md).

**Step 6 is staged** under #1214, store by store, each stage passing the fixture unchanged.
Every writing phase runs in the core, so a store can move on its own: the core keeps it, the adapters stop packing
it, the facts they already apply become the mirror's only writes, and a write from outside the tick becomes a
between-tick command (D5). After 6a the six stages planned there were merged into three where stores depend on each
other, and each is a PR in sequence. That was claudecode's proposal, which Corey agreed to in the session that made 6a and 6b (2026-11-21):
- **6a (#1214): door state.** Below.
- **6b (#1214): the traps.** Below.
- **The players go next, before the queues and the ground** (claudecode's reassessment at 6c, which Corey accepted,
  2026-11-21). A mine's explosion impulses synchronize every body against the players, which Node packs, so moving the
  impulse queue alone could not retire `STOP_EXPLOSION`. The queues and the hooks gain nothing measurable on their
  own, and most of the remaining packing and stops come from the players.
- **6c: the players.** One store in the core (`players.rs`) that every run reads and writes. It is converted a group
  of runs at a time:
  - **6c.1 (#1214):** the store, with phase 5's combat and phase 6's environment and traps as its first readers. Below.
  - **6c.2 (#1214):** phase 1 reads the store, and every write to its fields inside a tick reaches it, so it is
    uploaded once a tick. Below.
  - **6c.3:** the remaining readers stop packing players from the records, in three PRs:
    - **6c.3a (#1214):** the readers of scalar fields only: phase 7, the hooks and the body sync. Below.
    - **6c.3b (#1214):** phase 3's and phase 6's player rows. Below.
    - **6c.3c:** the equipment, in two PRs, as 6c.2 came before 6c.3 (design: #1214 comment 17519):
      - **6c.3c.1 (#1214):** the store keeps each player's equipment, and every write to it inside a tick reaches the
        store. Below.
      - **6c.3c.2 (#1214):** the readers take equipment from the store, with tokens that name Node's carried records.
        Below.

  Replacing the uploads between ticks with between-tick commands is 6e's.
- **6d: the ground, the ID counters, the pending queues and the hooks,** with the explosion port. They depend on each
  other: phase 1's admission reads the queues and the ground, the drop and pickup stops hand Node ground records,
  launches and admissions, and a drop plan's item counters (`itemSerial`, `scatterSerial`, D6) travel in a tentative
  allocation across those stops. `serial` goes with the item counters. The ground goes first: a mine's explosion
  synchronizes every body, and the sync's item admission packs Node's ground, so the explosion port needs the ground
  in the core.
  - **6d.1 (#1214):** the core keeps a ground store, kept current. Below.
  - **6d.2 (#1214):** the body sync's bookkeeping is the core's: the actor and item bodies the world holds, each gate's
    body, and which item bodies' records left the ground. Below.
  - **6d.3 (#1214):** the item admission takes the records awaiting a body and the launches from the core. Below.
  - **Then, removing Node's mid-tick work stop by stop** (Corey's direction below). Node's whole sync (`synchronize`)
    also filters the pending queues by generation and reconciles the hooks, so no run can sync inside itself until
    those are the core's too:
    - **6d.4 (#1214):** the hooks. Below.
    - **6d.5:** the pending queues and the discontinuity markers, with a mine's explosion impulses enqueued in the core.
    - **6d.6:** the sync inside a run: the drops, pickups, swaps and the explosion stop syncing in Node.
- **The direction (Corey, 2026-11-21, on #1214):** "now the way this should work eventually is that essentially the core
  should just be receiving tick timed input events or roughly that at the interface betweeen it and JS". So from 6d.2
  the remaining work is ordered by the stops it removes, each a crossing gone for good, rather than reader by reader.
  6e ends at D4's two calls, with intents crossing; #1215, which moves phase 2 into the core, is the step after the flip
  and takes the interface to input events.
- **6e: the effects, events and projectiles, and the two calls** (`tick_begin`, `tick_finish`, D4), with bot side
  tables keyed by ID. The remaining packing goes, between-tick writes become commands, and the steps that used 42.58's
  exception are measured again.

**Step 6a, door state (#1214).** A game's doors' `open` and `locked` live in the core, in its gate set's masks
(`GateSet::open` and `::locked` in `sight.rs`), and the gate records are their mirror (`shared/simulation/doors.ts`).
- **Owned when the game is made.** `createGame` pins the gate list, then `ownDoors` hands the gate set the records'
  state once (`ownGates` in `shared/sight-core.ts`). A game's gate list is its own: a caller reusing a map passes a
  copy, and the list is pinned. The core's rules already wrote the masks where they change a door, phase 6's
  interaction and the body sync's refused close, so no rule changed.
- **No call writes the mask.** Before, sight, discovery, every phase's run, the hook's rules and the tick boundary's
  calls wrote the open mask from the records first, and phase 6's interactions wrote the lock mask too: one pass over
  every gate on the map per call, the last packing that grew with the map (42.62). `queryHandles` takes no flag now.
  A gate `lineClear` ignores is held open for that query and restored, as `phase_six.rs` does.
- **The mirror is written only by facts.** The records' door fields are pinned read-only, so a write from anywhere
  else throws at its site. `writeDoor` is the facts' write: an existing key keeps its place and an absent `locked` is
  added last, where an assignment added it, so frames and the wire are byte for byte as before (`frame-gates.ts`).
- **`setDoor` is the between-tick command** for tests, tools and labs; play never calls it. It writes the core, then
  the mirror, and leaves the gate's body to the next sync, as a write to the record did.
- **What stays.** A map no game owns, such as a client's remembered gates or a tool's, has its mask written per call
  from its records, as before. The gate records still hold shape and state together: they are the mirror, which
  frames and the wire read. The shapes cross once per map, as they did.
- **Cost:** [42.74](42.74-door-state-core.md).

**Step 6b, the traps (#1214, adapter version 18).** `Hazards` (`hazards.rs`) keeps the game's traps between calls,
and `s.traps` is their mirror. The rules did not change: they already reported each trap's writes with a mask.
- **Rows cross only on an upload.** A call uploads the trap list (a header flag, then the rows as before) when this
  runtime has not uploaded it: the first call, a replaced `s.traps` or a changed length, and after `setTrap`. Otherwise
  the call packs the roster and the hazard areas only, and the core runs on the traps it kept, writes included.
- **`setTrap` is the between-tick command.** Tests and tools use it, or replace `s.traps`, as scenarios do; play
  never calls it. It writes the mirror and marks the list for upload, so the core takes it at the next call, before
  any rule reads a trap.
- **The mirror is not pinned,** unlike the doors' (6a). Every live trap writes `cooldown` each tick, and a
  read-only field can be written only by `Object.defineProperty`, which cost about 37 µs a tick on 277 traps against
  1.3 µs for assignment. A direct write to a trap record therefore no longer reaches the rules. `traps.test.js`'s two
  writes showed this at once, and they now use `setTrap`.
- **Cost:** [42.75](42.75-trap-state-core.md).

**Step 6c.1, the player store (#1214, adapter version 19).** `rust/core/src/players.rs` keeps each world's players in
roster order, as phase 5's rows (`combat::Row`: role, status, kit, pose, heading, health, level, cooldowns, stun, rank in
ID order, view lag) with each one's `movedThisTick`. `shared/simulation/player-store.ts` uploads it, with `putPlayerRow`
and `idRanks` moved there from `phase-five.ts`.
- **Two readers.** Phase 5's combat runs (`combat.rs`) and phase 6's environment and traps (`hazards.rs`) take their rows
  from the store and give them back with their writes. Their inputs no longer carry player rows, and their outputs and
  the mirror's writes are unchanged.
- **Uploaded before each of their calls.** Every other phase still writes the records directly, so the store is
  current only right after an upload. A run's writes reach the store too, so the store is current again once the
  last writer converts (6c.3).
- **Cost.** One upload replaces each call's own packing, row for row, so no saving was planned. Measured as 42.75 was (24x12, seed
  4217, five rounds; current, base `b7433806`, current), `sim.environment` fell from 17.4 µs to 9.5–10.1 µs a tick without traps, and from
  52.4 µs to 43.9–45.0 µs with 277. The whole tick moved within run spread. The likely cause, not proven: `putPlayerRow` was fed both a
  JavaScript array (phase 5) and a typed array (the hazards), and now writes only a typed array. Phase 5 was not timed on its own.

**Step 6c.2, the store kept current through the tick (#1214, adapter version 20).** The store holds `players::Extra`
too (respawn and arrival times, the transit's destination, `railCd`, `cloak`, `revealed`, `boost`, the actor's world
key), and it is uploaded once a tick, by phase 1, and before a converted call between ticks (`playersStale`).
- **Phase 1 reads the store.** The core fills phase 1's player section from it and writes the results back. The adapter
  still reads the results from that section for the records, so its writes are unchanged.
- **Every write inside a tick reaches the store**, as each run reports it. The core applies to the store the same
  writes the adapters apply to the records:
  - phase 3's player rows, its reveals, its eliminations and its kill credit (`Players::apply_actions`);
  - phase 6's extraction, transit and landing, and its reveals (`apply_interactions`);
  - the body sync's poses and retries;
  - `finishMatch`'s stranded statuses.

  Phase 4's poses and `movedThisTick` are written from the step's own output (`players_after_step`), summed with the
  shared `hypot` as `world.ts` sums them. Phase 2 writes none of the store's fields.
- **Writes between ticks are the records'.** Tests, tools and the between-tick commands write the records directly.
  Phase 1's upload, or a converted call's between ticks, takes those writes.
- **The witness.** `tests/player-store.test.js` runs a bot match with traps, hazard areas, lagging views, kills,
  eliminations and respawns, and after every tick holds the store equal to a fresh upload of the records
  (`storeDrift`). With phase 4's store write disabled, it fails at tick 1.
- **Cost:** phase 5's calls and the environment's no longer pack or upload players inside a tick. Measured as 6c.1 was (24x12, seed 4217, five rounds; current, base `ea189c8c`, current),
  `sim.environment` fell from 10.0 µs to 5.7–5.9 µs a tick, and `sim.projectiles` read 10.7–12.8 µs against 12.3 µs. The new store
  writes cost too little to separate from run spread: `sim.actions`, which now includes walking phase 3's output into the store,
  read 49.1–56.7 µs against 48.2 µs, and `sim.poses` 23.9–26.7 µs against 27.0 µs. The whole tick moved within spread (4.87–4.91 ms
  against 5.06 ms). The larger saving comes at 6c.3, when the other readers stop packing.

**Step 6c.3a, the scalar readers (#1214, adapter version 21).** Phase 7, the hooks and the body sync read the
players from the store, and their adapters no longer pack them.
- **Phase 7.** `finishMatch` reads role and status, and `recordRewind` reads the poses. `phase_seven_run` fills both from
  the store, and the adapter sends the header alone.
- **The hooks.** Each player's key, activity, hook kit, role and pose, and `ordered(s)` (the rows' rank), come from the
  store. The hooks' own records and the actors' substep paths still cross.
- **The body sync.** The core builds the active actors' rows (key, roster index, role, pose, in ID order) from the store
  and places them where the adapter used to write them, so the rest of the sync is unchanged.
- **Between ticks** these calls upload first (`playersStale`), as phase 5's do. That covers `createGame`'s first sync,
  a teleport's, a scenario's hook call, and `recordRewind` called from a test.
- **Cost.** Measured as 6c.2 was (base `78df3853`): `sim.sync`, which times every body sync of the tick, fell from 53.1 µs to
  44.0–44.9 µs, and `sim.rewind` from 1.6 µs to 1.1 µs. The other labels and the whole tick (4.54–4.56 ms against 4.57 ms) moved
  within run spread. The hooks' saving does not show on this map, which has few hooks in flight.

**Step 6c.3b, phase 3's and phase 6's player rows (#1214, adapter version 22).** Their rows keep their layout. The
adapters write 0 in the store's words, and the core fills those words from the store by roster index after reading each row.
- **Phase 3** takes all the store's fields for an action player (`Players::fill_action`: key, role, status, kit, pose,
  heading, health, cooldowns, stun, level, cloak, reveal, boost), and role, status and pose for a context actor. Selection,
  weapon, inventory, reserves, reload and the intent still cross: they are 6c.3c's.
- **Phase 6** takes only the fields its adapter packed before: an actor's role, status, pose, `railCd` and `cloak`, and
  each roster player's status and pose. Its rows leave the rest at 0, which its rules expect, so filling more could
  change behaviour.
- **Between ticks** both upload first (`playersStale`), since scenarios call them directly.
- **Cost:** measured once, at the end of step 6, against the `main` before 6a (Corey, 2026-11-21: one bench at the end of
  the flip rather than per PR or per stage).

**Step 6c.3c.1, the equipment kept current (#1214, adapter version 23).** The store keeps each player's equipment
(`players::Equip`): `selectedSlot`, `weapon`, `keys`, `charging` (the charger's index), the inventory, reserves and reload.
Items are `action_types::Item` rows with their absence mask, so a record's absent fields and key order are known.
- **The upload** carries each player's equipment after every fixed row (`players::EQUIP_HEAD`, then ten words per item).
  `appendItem`, the one item packer, moved to `player-store.ts`, and `phase-three.ts` re-exports it.
- **Every write reaches the store,** mirroring the adapters:
  - phase 3's rows (selection, weapon, reserves, reload, inventory) when the mode writes rows, and its facts for
    charging cleared and reload cleared;
  - phase 6's extraction, charging, transit, unlocking a door with a key, a cell's charge, keys, a pickup's equipment
    and a committed swap.
- **Readers are unchanged.** Phases 3 and 6 still pack equipment from the records; 6c.3c.2 moves them to the store. The
  items' tokens in the store are the uploading call's and mean nothing yet, so the dump and the drift check write 0.
- **The witness.** `storeDrift` also compares each player's equipment. With phase 6's pickup write disabled it fails at
  tick 1, and with phase 3's inventory write disabled at tick 2.


## One math library on both sides

"Native on the server, WebAssembly in the browser" is not bit-identical by itself. Native Rust's `sin`, `cos` and
`atan2` come from the platform's math library, which differs between systems. That is the failure #566 found in
V8 across ARM and x86. It would put the authoritative server and the predicting client on different bits. The two
options:

1. **Run the same WASM on the server.** Node instantiates the binary the browser runs, so there is no native
   server. Rapier already works this way. **This is the chosen form for the core.**
2. **Use one pure-Rust math library everywhere**, native and WASM alike (the `libm` crate is the candidate), never
   the platform's or whatever the toolchain links. Needed only if the core ever runs natively.

Either way, never let the compiler fuse operations: no `mul_add`, no fast-math intrinsics, and no relaxed SIMD,
whose fused multiply-add is implementation-defined. `+ - * /` and `sqrt` are IEEE-exact in WASM, and in Rust on
ordinary 64-bit targets. Everything else is a library's choice.

The reference is what TypeScript computes today: `shared/math.ts`, ports of fdlibm 5.3 and V8's `hypot` using
exact operations only ([22.1](22.1-shared-simulation.md)). The crate ports `shared/math.ts` itself. Do not change
the TypeScript to match a library, because that moves the frozen fixture. Every crate is third-party code under
[21.1](21.1-third-party-licenses.md), checked by #1174's licence audit.

## The workspace

`rust/` is one Cargo workspace, set up by #1174. Cargo runs from that directory.
- **Toolchain.** `rust/rust-toolchain.toml` pins Rust 1.100.0 with `clippy`, `rustfmt` and the `wasm32-unknown-unknown`
  target. CI installs the toolchain from that file. `rust/Dockerfile`'s builder tag names the same version, and
  `rust/Cargo.toml`'s `rust-version` names its minor, so the three are bumped together.
- **Crates.** `rust/edge/` is the package `last-exit-edge`, a binary. `rust/core/` is the package `last-exit-core`.
  It is not named `core` because that would shadow Rust's own `core` crate.
  - **The edge** is #1095's stage 1 ([24.5](24.5-transport.md#stage-1s-contracts)): `src/lib.rs` runs it,
    `src/frame.rs` frames both of its connections, and `src/origin.rs` checks origins. `tests/edge.rs` drives it
    with a real `wtransport` client against a fake Node.
  - **The core** holds `src/math.rs`, the port of `shared/math.ts` (#1175). Its tests compute the same digest as
    `tests/math.test.js`. `src/sight.rs` is sight casting, `src/discovery.rs` discovery (#1210), `src/phase_one.rs` tick phase 1's
    rules (#1212), and `src/physics.rs` holds Rapier (#1192).
- **Lockfile.** `rust/Cargo.lock` is committed, because the workspace builds a binary and a module that ship.
- **Checks.** `rust/deny.toml` holds the licence policy ([21.1](21.1-third-party-licenses.md#the-rust-workspace)).
  [31](31-verification.md#continuous-integration) lists the checks and what they cost.
- **The math guard.** `rust/core/clippy.toml` forbids `mul_add` in the core. It also forbids every platform
  transcendental on `f64` and `f32`: the trigonometric and hyperbolic functions, exponentials and logarithms, powers,
  `cbrt` and `hypot`. `sqrt` and `+ - * /` stay allowed. CI's clippy treats a use as an error. This is the
  Rust form of "never call `Math.sin` in `shared/`" ([22.1](22.1-shared-simulation.md)).
- **The order guard.** The same file forbids `std`'s `HashMap`, `HashSet` and `RandomState`, which seed themselves
  randomly per process, and its clocks. Use ordered collections or a fixed hasher.
  - **Why not `no_std`,** which would rule these out structurally (Antigravity's notes on #1175, comment 16252). On stable Rust
    a `no_std` crate has no `f64::floor` or `sqrt`, and WASM's own instructions for them are unstable. It would
    need the `libm` crate or a hand-written correctly rounded `sqrt`.

**How the WASM is built and loaded.** These are agent recommendations made under #1174:
- **Plain exports, not `wasm-bindgen`.** The core compiles as a `cdylib` with `extern "C"` exports.
  - **Why.** Rule 1 keeps inputs and outputs in flat buffers in WASM memory, so `wasm-bindgen`'s generated glue would
    have nothing to do. Its command-line tool must also match the crate's version exactly, and it adds crates to the
    tree.
  - **When to revisit.** Only if an export ever needs JavaScript strings or objects, which rule 1 rules out.
- **One loader.** One JavaScript loader instantiates the module.
  - **Where the bytes come from (agent recommendation, accepted by Corey 2026-11-18, #1175).** `buildCore` also
    writes them as base64 into `shared/core-wasm.generated.ts`, ignored by git. `shared/core.ts`'s `initCore`
    imports that module, so Node and the browser load the core the same way, as Rapier's `-compat` package
    embeds its own. There is no file read in one host and fetch in the other, and no route to serve the file:
    `/shared` serves the generated module like any other. It is about 55 KB of WASM, 73 KB as text.
  - **When.** `initCore` instantiates once per process (per thread in the server's room workers), memoized, before
    anything that uses the core.
  - **The first call.** The loader reads `adapter_version` before anything else. That is the version of the contract
    between the module and its adapter.
  - **The loader** is `shared/core.ts`'s `loadCore`. It takes the bytes and checks the version; `initCore` and
    tests that build their own module both call it.
  - **Its contract** is `CoreExports`: memory and buffer entry points. The math's per-scalar exports are a separate
    `MathParityExports`, for the parity check only.
  - **Evidence.** The math digests match through the module in Node 24 on Windows and in headless Chrome 157
    (2026-11-17, #1175), and in CI's Linux arm64. `tests/math.test.js` holds the Node half.
- **The module is built, never committed** (Corey, 2026-11-18, PR #1178). Each host builds its own.
  - **How.** `tools/build-core.mjs`'s `buildCore` runs Cargo and returns the module's path in `rust/target`.
    Cargo makes it a no-op when nothing changed. `npm run core:build` runs it by hand.
  - **Who calls it.** The test runner's global setup (`tests/helpers/test-lock-setup.mjs`), so every test file
    finds the module; `serveWithBrowser`, for the browser scripts; and `npm run dev`/`dev:lan` before the server
    starts. Anything else that runs a game, such as a physics tool, needs `npm run core:build` once; `initCore`
    names that command when the module is missing.
  - **CI.** `tools/ci/rust-toolchain.sh` installs the toolchain `rust/rust-toolchain.toml` names, for `rust.yml`
    and for `ci.yml`'s `verify` and `slow`: every stepping game loads the core, so the slow characterization
    tests build it too.
  - **Why not committed.** That was tried first under #1175. A committed binary must match every host's rebuild
    byte for byte. That held for Windows x64 against Linux arm64 (run 1243), but a reachable panic embeds its source
    path with the host's separator (`core\src\lib.rs`), which no `--remap-path-prefix` rewrites. What must agree
    is behaviour, not bytes: WASM's exact operations give every host the same results, and the server and its
    clients run one file by construction. `tests/math.test.js`'s digests check the behaviour.
  - **The cost.** Every machine that runs the Node tests needs `cargo`. `verify` spends about 1 min installing the
    toolchain cold, until the runner offers a cache.

**The edge on a Linux host.** `rust/Dockerfile` builds the edge in the official Rust image and runs it on
`debian:bookworm-slim` as `nobody`, for whichever architecture builds it: x64 was checked under Docker on the
development machine. CI builds the same binary on its arm64 runner. No image is published: a host
builds its own. Distributing an image would redistribute what it contains
([21.1](21.1-third-party-licenses.md#the-rust-workspace)).

## Tests and the frozen fixture

The acceptance tests exist already:
- `tests/math.test.js` pins a digest of the math module's output bits. The crate must produce the same digest
  before anything is built on it.
- `behavior-physics-1.v8.gz` pins every tick's snapshot, the private engine state included, and the projections of
  its bot matches ([31](31-verification.md#the-frozen-fixture)).
- Generation's target is the chain's seed sweep (`map/tools/fixtures/chain-baseline.json`), which stays in Node.

Corey's rule for this effort (17.4 #18):
- **First,** get as close as possible to passing every test unchanged.
- **Then,** case by case, rework tests for the new architecture: change them for intent, add new ones, remove old
  ones.
- **Not matching every test perfectly is not a failure** (Corey's correction of his own wording, 17.4 #18).

The project invariant still holds. The fixture is never regenerated to make a port pass. A mismatch is first
treated as a port bug. Only an architectural change that cannot preserve it is a decided recapture: a separate
commit, with a continuity proof like `tools/closure-continuity.mjs`.

## Physics

Rapier is already WASM and the selected engine ([21](21-stack.md), [29.1](29.1-physics-design.md)). Its
JavaScript/WASM build is documented as cross-platform deterministic for the same version, the same initial
conditions and insertion order, and inputs that are themselves deterministic. The page names `Math.sin` and
`Math.cos` as the usual way to break that, which is the gap above
([Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)). The repository's own evidence
is repeatability on supported Node ([42.21](42.21-jelly-squish.md)).

As the flip's first step (D2), Rapier compiles into the crate as a Rust dependency rather than through rapier.js.
That removes the wrapper's per-collider costs, but it is a different binary, possibly with different features
(`enhanced-determinism`). If the fixture's digests move then, it is the decided recapture above: Corey accepted it
in advance (17.4 #18). If physics ever runs natively instead of as the shared WASM, that determinism needs its own
evidence.

Why it comes first (D2, #1066). This text used to say Rapier waits for the flip, because the tick calls the world
many times a tick and the move would only trade the wrapper's crossings for the adapter's. The wrapper's cost is
not its crossings, though: rapier.js re-syncs its handle maps per collider on `step` (PR #731), while a crossing
costs 0.03 µs ([42.58](42.58-sight-core-adapter.md)). `shared/physics/world.ts` is already a queue-and-commit
interface, so the adapter batches behind it. Going first also isolates the one decided recapture, and the world
has to leave JavaScript before the state can.

Two checks the move needs, which the core's own guards do not give. Both were done before any adapter (#1192, first
PR); the results follow each:
- **The math guard stops at the crate.** `rust/core/clippy.toml` forbids platform transcendentals and `mul_add` in
  our code only; clippy does not lint dependencies. Rapier and its math crates (`nalgebra`, `parry2d`, and what
  they pull in) must be shown to compile to WASM without platform `sin`/`cos` or fused operations, by their
  feature flags or by inspecting the built module.
  - **By inspection, because the flags do not settle it.** `glam`, `simba`, `wide` and `num-traits` all carry
    `mul_add` paths in their source, so what counts is what reaches the module. `tools/core-wasm-audit.mjs` decodes
    every instruction of the built module, and `tests/core-wasm-audit.test.js` runs it on each test run:
    - **No imports.** A host's `Math.sin` or a platform libm can only enter through one, and the module has none.
    - **No SIMD.** WASM's only fused multiply-add is relaxed SIMD's. The module has no `0xFD` instruction, and its
      target features name none.
    - **No software fma.** No function named `fma`, `fmaf` or `mul_add` is linked.
    - **The transcendentals it has are compiled in:** the `libm` crate's `sinf`, `cosf`, `atanf`, `atan2f` and
      `sincosf`, and the Rust standard library's own libm port (`compiler_builtins`), with `expf` and `log2f`. Being
      in the module, they give Node and every browser the same bits, as rapier.js's did.
  - **The features (settled).** Rapier's defaults (2D, `f32`, `std`, the block solver) plus `enhanced-determinism`,
    which routes `simba`'s and `parry2d`'s math through the `libm` crate. `parallel`, `simd8` and the debug
    features stay off. `f32` matches rapier.js.
  - **The version.** `rapier2d` 0.36.1 links `parry2d` 0.31.1 and `nalgebra` 0.35.0, the versions found in rapier.js
    0.21.0's module (21.1), so the engine is the same generation.
  - **Its size.** The module grew from about 55 KB to about 1.95 MB (2.6 MB as base64), close to rapier.js's
    2.4 MB, which then retired.
- **The licence record.** Rapier is Apache-2.0, compatible with the MIT licence, but as a crate it passes
  `cargo deny` and is recorded in [21.1](21.1-third-party-licenses.md#the-rust-workspace), with its dependencies.
  The npm package's record goes when the wrapper does.
  - **Done.** `cargo deny` passes. One crate, `foldhash`, is Zlib alone, a permissive notice licence, added to the
    allow-list and recorded in 21.1. The core's WASM has its `components.json` entry, and the npm package's record
    retired with the package (#1192).

**The adapter (#1192, adapter version 4).** `shared/physics/world.ts` keeps its queue-and-commit interface and
everything that is not the engine; `rust/core/src/physics.rs` holds Rapier's sets. The tick stays in TypeScript.
- **What crosses, and how often.** One call commits each body or constraint and one reads each pose, as rapier.js's
  calls did. A step is one call: it runs all four substeps, with the motors, queued forces and impulses, bounded
  constraints and speed caps the adapter used to apply between rapier.js calls. Its input is one flat buffer the
  core owns (rows of dynamic bodies, forces, impulses and constraints), and its output is another: each dynamic
  body's position before and after every substep, then the collision events, then the constraints that broke.
- **Slots, not handles.** A body is a slot; a collider's user data is its slot, so events name slots, and the
  adapter maps them to IDs. Removed colliders' late events find no slot and are dropped, as rapier.js's unmapped
  handles were.
- **The same arithmetic.** World units are divided by the scale in `f64` and rounded once to Rapier's `f32`, as
  rapier.js's arguments were; results are widened before scaling. The motor, speed cap and bounded constraint use
  the core's port of `shared/math.ts` (`hypot`, `sin`, `cos`), bit-equal to what the adapter called.
- **The fixture did not move.** `behavior-physics-1.v8.gz` passed unchanged: the scripted snapshots and both bot
  matches. The decided recapture (D8) was not needed. rapier.js 0.21.0 was built from the same parry2d and nalgebra.
- **Client prediction** (`public/physics-prediction.js`) builds its worlds through the same adapter, so it runs
  the same core as the server with no change of its own. The browser loads the core before its scene.
- **Retired with rapier.js:** the P0 comparison lab's engine harness (`tools/physics/rapier.mjs`, its runner,
  report, queries and lab prediction, and the jelly lab), which used rapier.js features the game never did
  (snapshots, shape casts, native springs, contact impulses). Their evidence stays in `docs/reports` and the 42.x
  documents.
- **Cost:** [42.61](42.61-rapier-core-adapter.md).
