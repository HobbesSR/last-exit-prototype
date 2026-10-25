# 21. Stack decision

Phaser renders the browser client. Node hosts an authoritative 20 Hz simulation over WebSockets. SAT.js supplies circle/polygon collision; PathFinding.js supplies bot route search. The map generator assembles generated sections with world-space geometry. Its coarse navigation sampling is private implementation detail and does not constrain human movement or rendering.

This first implementation uses a shared JavaScript core to make iteration and browser prediction direct. It is not a Rust implementation. The user allowed either Rust or an appropriate free/open-source ecosystem. Phaser's MIT-licensed browser focus fits this initial client; there is no engine editor or export pipeline to operate.

Phaser, SAT.js, and PathFinding.js are the current free/open-source components. They are replaceable only when a replacement improves correctness, determinism, licensing, performance, or browser support. The simulation must remain separable from the renderer so a Rust/WASM core can replace the shared JavaScript implementation if the game validates.

The authoritative simulation and browser prediction share movement and geometry code. Simulation state is fixed-tick and serializable. Rendering is independent of simulation rate, and splits by who is being drawn. The viewer's own player is predicted forward from unacknowledged input, with camera, sprite, fog and cover reading one eased eye. Everyone else is drawn from a receive buffer held a fixed delay behind the newest frame and interpolated between the two states bracketing it, because arrival is uneven and a renderer that chases the newest position turns that unevenness into stutter. See [25](25-pacing-and-rendering.md).

Profiling is off by default. `shared/profiler.ts` keeps frame-scoped timing/counters separate from event-scoped packet and pacing observations. The server exposes `/api/profile`, `PROFILE=1` enables server profiling, `P` toggles browser profiling, and the benchmark scripts must remain runnable without opening a public server.

Navigation's free-space mesh ([22.6.1](22.6.1-portal-graph-and-mesh.md#bottom-level-free-space-triangulation)) uses three more: Clipper (`clipper-lib` 6.4.2, Boost licence) to cut and erode polygons on an integer grid, Delaunator (`delaunator` 5.1.0, ISC) to triangulate, and Constrainautor (`@kninnug/constrainautor` 4.1.0, ISC) to constrain that triangulation to the outlines. Constrainautor's published types are TypeScript source this project's settings reject, so `tsconfig.json` maps it to `shared/constrainautor.d.ts`. No browser module loads the mesh yet; one that does needs them wrapped as `sat` and `pathfinding` are (`server/vendor-modules.js`).

References: [Phaser](https://github.com/phaserjs/phaser), [SAT.js collision response](https://github.com/jriecken/sat-js), [PathFinding.js](https://github.com/qiao/PathFinding.js), [Clipper](https://github.com/junmer/clipper-lib), [Delaunator](https://github.com/mapbox/delaunator), [Constrainautor](https://github.com/kninnug/Constrainautor).

Physics uses Rapier 2D/WASM as the selected development direction, pinned at
Apache-2.0 `@dimforge/rapier2d-compat` **0.21.0**. This selection does not activate
physics in default matches or replace SAT.js in production. The custom solver is
retired as a candidate; its code and tests remain only as an archival comparison
baseline. Planck.js is the reserve if Rapier integration fails or becomes
unsustainable. The P0 comparison and retained failures are in
[42.6](42.6-physics-comparison.md); reviewed remediation gates are in
[42.9](42.9-physics-remediation.md). The explicit experimental P1 adapter is a
production dependency, initialized only by the async physics factory; it retains
legacy defaults. Its boundaries/evidence are [42.11](42.11-physics-p1.md), with
remaining promotion work in [41.1](41.1-physics-plan.md). P9's developer-only local
playtest and measured integration checkpoint are in [42.20](42.20-physics-p9.md);
default selection remains a separate reviewed checkpoint.
