# 27. Rust path

If the prototype validates the game, move geometry and simulation into an engine-independent Rust crate with serializable state, fixed-tick input, and explicit randomness. Compile it to WebAssembly for the browser and the server, and keep the renderer and transport outside the crate. This avoids maintaining separate Rust and JavaScript gameplay implementations.

This is a plan, not scheduled work. The core is TypeScript in `shared/` and `map/` ([21](21-stack.md), [22.1](22.1-shared-simulation.md)), and its rules still change weekly, so a port started now would chase a moving target. This document records what we have learned for when it is picked up.

## When to start

Any one of these justifies starting:

- Playtests show the game works, and the core rules stop changing week to week.
- The server hits a CPU ceiling in JavaScript: tick time, bots or navigation, or map generation for many rooms.
- A native or self-contained server becomes a requirement.

None holds yet (checked for #568, 2026-10-27).

## One math library on both sides

"Native on the server, WebAssembly in the browser" is not bit-identical by itself. Native Rust's `sin`, `cos` and `atan2` come from the platform's math library, which differs between systems. That is the failure #566 found in V8 across ARM and x86, and it would put the authoritative server and the predicting client on different bits. Choose one of:

1. **Run the same WASM on the server.** Node instantiates the binary the browser runs, so there is no native server. This is how Rapier already works.
2. **Use one pure-Rust math library everywhere**, native and WASM alike (the `libm` crate is the candidate), and never the platform's or whatever the toolchain links.

Either way, never let the compiler fuse operations: no `mul_add`, no fast-math intrinsics, and no relaxed SIMD, whose fused multiply-add is implementation-defined. `+ - * /` and `sqrt` are IEEE-exact in WASM, and in Rust on ordinary 64-bit targets. Everything else is a library's choice.

The reference is what TypeScript computes today: `shared/math.ts`, ports of fdlibm 5.3 and V8's `hypot` using exact operations only ([22.1](22.1-shared-simulation.md)). `libm` descends from the same fdlibm lineage, but nobody has checked that it returns the same bits, and descent does not guarantee it. If it differs, port `shared/math.ts` into the crate instead. Do not change the TypeScript to match, because that moves the frozen fixture. A crate added for this is third-party code under [21.1](21.1-third-party-licenses.md).

## Prerequisite and acceptance

#566 is the prerequisite, and it is met: the TypeScript simulation computes exact bits on every platform, and kept the frozen fixture unchanged. A Rust port of the same algorithms must now reproduce those bits, so the port has a fixed target.

The acceptance tests already exist:

- `tests/math.test.js` pins a digest of the math module's output bits. The crate's math must produce the same digest before anything is built on it.
- `behavior-nav-1.json.gz` is the port's acceptance test for the simulation: every tick's snapshot and projections of its bot matches must equal the stored digests ([31](31-verification.md#the-frozen-fixture)). Its arenas are stored, so it does not exercise generation. Generation's target is the chain's seed sweep, `map/tools/fixtures/chain-baseline.json` ([31](31-verification.md), [53](53-map-artifacts-and-tools.md)).

A port never regenerates either to pass. A mismatch is a bug in the port or a decision about the TypeScript, taken separately from the extraction ([31](31-verification.md#the-frozen-fixture)).

## Port incrementally

Move stable, self-contained parts first, not the simulation in one step. The candidates are shape geometry (`shared/shape.ts`, [29.3](29.3-shape-construction-and-assembly.md)), navigation ([22.6](22.6-hierarchical-navigation.md)) and the map kernel (`map/kernel/`, which imports nothing outside itself), in the order their rules stop changing.

Each becomes a WASM module that both the Node server and the browser call, which is option 1 above and so closes the determinism gap for that module. Each must match the current tests bit for bit before its TypeScript version is deleted. Both exist while they are compared, and no module is deleted on a partial match. Whether to move the server to a native build afterwards is a separate decision, and it needs option 2 first.

## Physics

Rapier is already WASM and already the selected engine ([21](21-stack.md), [29.1](29.1-physics-design.md)), so physics is not part of the port. Its JavaScript/WASM build is documented as cross-platform deterministic for the same version, the same initial conditions and insertion order, and inputs that are themselves deterministic. The page names `Math.sin` and `Math.cos` as the usual way to break that, which is the gap above. [Rapier determinism](https://rapier.rs/docs/user_guides/javascript/determinism/). That statement covers the WASM build. The repository's own evidence is repeatability on supported Node ([42.21](42.21-jelly-squish.md)). If the Rust core ever runs physics natively instead of through the same WASM, that determinism needs its own evidence.
