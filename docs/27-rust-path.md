# 27. Rust path

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
    its adapter. `tests/sight-core.test.js` holds them equal to `shared/sight.ts` bit for bit, on synthetic maps
    and on the room arena. Its measurement, and the budget it sets, are in [42.58](42.58-sight-core-adapter.md).
  - **How the game reaches it (Corey, 2026-11-18, #1175).** Loading and choosing are kept apart:
    - **Loading is per process.** `initCoreSight()` (`shared/sight-core.ts`) binds the process's one core once, as
      `initRapier` loads Rapier. It decides nothing.
    - **Choosing is per game.** `createGame`, already async and already giving each game its physics world,
      awaits it and attaches it beside physics (`shared/simulation/sight-runtime.ts`). That is a side table, so
      snapshots and replays never carry it, and none of `createGame`'s callers supply it.
    - **The tick passes it.** `discover()` takes the `SightCaster` to observe through in place of a flag; the
      tick passes `sightOf(s)` for bots. A record from `createGameRecord` alone has no sight: its bots discover
      as people do until a game steps.
    - **The client** awaits `initCoreSight()` before its scene and hands the scene the caster (`api.sight`). The
      fog keeps one gate list per map and rewrites only `open`, so the core indexes the gates once, not per frame.
    - **Why not a module-level switch in `sight.ts`:** which implementation a game runs would be hidden process
      state. **Why not a parameter from every caller:** `createGame` is the one door a stepping game comes
      through, and its callers (the server, the physics lab, tools and tests) have no say in it.
  - **Checks.** `tests/sight-core.test.js` holds parity in Node, and `tests/sight-core.browser.mjs` holds it in
    Chrome through the client page's own load. The TypeScript `visibilityPolygon` stays as the reference
    until its remaining callers, tests and benches, have moved.

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
  - **Input bookkeeping is Node-owned** while phase 2 is in Node (review 957 on PR #1216). `consumeInput` writes
    the player's `inputQueue`, `input`, `lastSeq`, `inputStalled` and `inputMargin`/`inputMarginNext`, and the
    owning client's projection reads the last three. Those fields live in Node, outside the core's state, and
    the mirror's player record overlays them on the core's fields. The intents carry everything phases 3–7
    read, so none of these fields crosses into the core.
    - **The core's resets come back as facts.** Respawn (phase 1) and transit (phase 6) clear `input` and set
      `inputTick`. They report it in their change list, and Node applies it before the next phase 2 that could
      read it: the same tick's for respawn, from `tick_begin`; the next tick's for transit, from `tick_finish`.
    - **The same tick boundary.** Snapshot, recording and projection are built after `tick_finish`, from the
      mirror with both the change lists and that tick's phase-2 writes applied. They see what one in-place
      `step` shows today.
- **Between-tick commands (D5).** Roster changes, teleport and view lag stay separate calls, applied at once.
  Each call returns its own change list, which Node applies to the mirror before the call returns (review 957).
  A command's effect is then visible at once: a paused room's teleport takes and broadcasts a snapshot before
  any further tick (`server/room.js`), and that snapshot shows the moved pose. View lag splits by reader:
  `viewLagTicks` goes into the core, since rewind (`shared/simulation/rewind.ts`) reads it in combat, while
  `inputLeadTicks` bounds input stamps and stays with the Node-owned input bookkeeping.
  #1066's single command queue drained at the start of the step is not part of the flip: it would change what
  a between-tick snapshot shows, and nothing needs it. It stays an option.
- **IDs (D6).** `serial`, `itemSerial` and `scatterSerial` move into the core with the same allocation points and
  order. There are no unified generational IDs; that would be a rules change of its own. Randomness in the tick
  is stateless (`itemRoll` hashes seed and label) and is ported bit for bit.
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
    `tests/math.test.js`.
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

Two checks the move needs, which the core's own guards do not give (tracked with the move in #1192):
- **The math guard stops at the crate.** `rust/core/clippy.toml` forbids platform transcendentals and `mul_add` in
  our code only; clippy does not lint dependencies. Rapier and its math crates (`nalgebra`, `parry2d`, and what
  they pull in) must be shown to compile to WASM without platform `sin`/`cos` or fused operations, by their
  feature flags or by inspecting the built module.
- **The licence record.** Rapier is Apache-2.0, compatible with the MIT licence, but as a crate it passes
  `cargo deny` and is recorded in [21.1](21.1-third-party-licenses.md#the-rust-workspace), with its dependencies.
  The npm package's record goes when the wrapper does.
