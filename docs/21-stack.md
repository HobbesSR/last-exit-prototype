# 21. Stack decision

Phaser renders the browser client. Node hosts an authoritative 20 Hz simulation over WebSockets. SAT.js supplies circle/polygon collision; PathFinding.js supplies bot route search. The map generator assembles generated sections with world-space geometry. Its coarse navigation sampling is private implementation detail and does not constrain human movement or rendering.

This first implementation uses a shared JavaScript core to make iteration and browser prediction direct. It is not a Rust implementation. The user allowed either Rust or an appropriate free/open-source ecosystem. Phaser's MIT-licensed browser focus fits this initial client; there is no engine editor or export pipeline to operate.

Phaser, SAT.js, and PathFinding.js are the current free/open-source components. They are replaceable only when a replacement improves correctness, determinism, licensing, performance, or browser support. The simulation must remain separable from the renderer so a Rust/WASM core can replace the shared JavaScript implementation if the game validates.

The authoritative simulation and browser prediction share movement and geometry code. Simulation state is fixed-tick and serializable. Rendering is independent of simulation rate, and splits by who is being drawn. The viewer's own player is predicted forward from unacknowledged input, with camera, sprite, fog and cover reading one eased eye. Everyone else is drawn from a receive buffer held a fixed delay behind the newest frame and interpolated between the two states bracketing it, because arrival is uneven and a renderer that chases the newest position turns that unevenness into stutter. See [25](25-pacing-and-rendering.md).

Profiling is off by default. `shared/profiler.ts` keeps frame-scoped timing/counters separate from event-scoped packet and pacing observations. The server exposes `/api/profile`, `PROFILE=1` enables server profiling, `P` toggles browser profiling, and the benchmark scripts must remain runnable without opening a public server.

References: [Phaser](https://github.com/phaserjs/phaser), [SAT.js collision response](https://github.com/jriecken/sat-js), [PathFinding.js](https://github.com/qiao/PathFinding.js).
