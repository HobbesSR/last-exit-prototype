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
- **When.** That format is part of the core's first consumer of map data, not of the math port.
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
     JavaScript then reads projections rather than feeding functions. #1066's functional tick and ECS-style state
     are the design for the flip, decided before it.
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
- **Then** shape geometry (`shared/shape.ts`, [29.3](29.3-shape-construction-and-assembly.md)) and navigation
  ([22.6](22.6-hierarchical-navigation.md)).

Each module must match the current tests bit for bit before its TypeScript version is deleted. The TypeScript is
deleted once its JavaScript callers have moved too. Until then, a module whose callers remain is kept on purpose,
with a shared digest test, as math is. Otherwise both versions exist only while they are compared. A half-ported
module is not left in place.

The browser instantiates WASM asynchronously. The client therefore loads the core once at startup, before anything
that uses it, rather than through synchronous imports.

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
  It is not named `core` because that would shadow Rust's own `core` crate. Both are placeholders until #1095 and
  #1175.
- **Lockfile.** `rust/Cargo.lock` is committed, because the workspace builds a binary and a module that ship.
- **Checks.** `rust/deny.toml` holds the licence policy ([21.1](21.1-third-party-licenses.md#the-rust-workspace)).
  [31](31-verification.md#continuous-integration) lists the checks and what they cost.
- **The math guard.** `rust/core/clippy.toml` forbids `mul_add` in the core. It also forbids every platform
  transcendental on `f64` and `f32`: the trigonometric and hyperbolic functions, exponentials and logarithms, powers,
  `cbrt` and `hypot`. `sqrt` and `+ - * /` stay allowed. CI's clippy treats a use as an error. This is the
  Rust form of "never call `Math.sin` in `shared/`" ([22.1](22.1-shared-simulation.md)).

**How the WASM is built and loaded.** These are agent recommendations made under #1174:
- **Plain exports, not `wasm-bindgen`.** The core compiles as a `cdylib` with `extern "C"` exports.
  - **Why.** Rule 1 keeps inputs and outputs in flat buffers in WASM memory, so `wasm-bindgen`'s generated glue would
    have nothing to do. Its command-line tool must also match the crate's version exactly, and it adds crates to the
    tree.
  - **When to revisit.** Only if an export ever needs JavaScript strings or objects, which rule 1 rules out.
- **One loader.** One JavaScript loader instantiates the module from bytes that its host supplies.
  - **Where the bytes come from.** Node reads the file. The browser fetches it from a served path.
  - **When.** Both call `WebAssembly.instantiate` once at startup, before anything that uses the core.
  - **The first call.** The loader reads `adapter_version` before anything else. That is the version of the contract
    between the module and its adapter.
  - **Evidence.** The placeholder loads in Node 24 on Windows and in CI's Linux image.
- **Open for #1175.** Where the built `.wasm` comes from for `npm test` and the server is not settled. Either
  `verify` builds it, or it is committed and CI checks that a rebuild reproduces it byte for byte. #1175 decides it
  with its first JavaScript caller.

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

When the core owns the tick, Rapier compiles into the crate as a Rust dependency rather than through rapier.js.
That removes the wrapper's per-collider costs, but it is a different binary, possibly with different features
(`enhanced-determinism`). If the fixture's digests move then, it is the decided recapture above: Corey accepted it
in advance (17.4 #18). If physics ever runs natively instead of as the shared WASM, that determinism needs its own
evidence.
