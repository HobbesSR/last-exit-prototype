/**
 * The one loader for the Rust core (`rust/core`, docs/27), shared by Node and the browser.
 * `initCore` instantiates the module `tools/build-core.mjs` embeds, once per process (per thread in
 * the server's room workers), before anything uses it: shared code cannot await mid-tick.
 * `loadCore` takes bytes directly, for tests that load a module of their own.
 *
 * The module is a build output, never committed: each host builds its own (docs/27).
 */

/** The adapter contract this loader speaks: `ADAPTER_VERSION` in `rust/core/src/lib.rs`. */
export const CORE_ADAPTER_VERSION = 27;

// The project's lib is ES2023 without the DOM, which is where TypeScript declares WebAssembly.
// Both hosts have it; this names only what the loader uses.
declare const WebAssembly: {
  instantiate(bytes: ArrayBuffer | ArrayBufferView, imports: object): Promise<{ instance: { exports: object } }>;
};

/** The production contract: memory and buffer entry points only, never per-scalar calls (docs/27). */
export interface CoreExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  adapter_version(): number;
  /** A buffer of `bytes` in WASM memory for JavaScript to fill, and its release. */
  core_alloc(bytes: number): number;
  core_free(pointer: number, bytes: number): void;
  // Sight casting (`rust/core/src/sight.rs`), driven by `shared/sight-core.ts`.
  sight_index_new(segments: number, segmentCount: number, grid: number, gridLength: number,
    through: number, throughCount: number, throughOffsets: number, obstacleCount: number, throughGrid: number, throughGridLength: number): number;
  sight_index_free(index: number): void;
  sight_index_points(index: number): number;
  sight_index_tests(index: number): number;
  gate_set_new(edges: number, edgeCount: number, offsets: number, gateCount: number, boxes: number, grid: number, gridLength: number): number;
  gate_set_free(gates: number): void;
  gate_set_open(gates: number): number;
  gate_set_locked(gates: number): number;
  // The player store (`rust/core/src/players.rs`, #1214 stage 6c), driven by `shared/simulation/player-store.ts`.
  players_input(world: number, words: number): number;
  players_load(world: number, count: number): void;
  players_after_step(world: number): void;
  // The ground store (`rust/core/src/ground.rs`, #1214 stage 6d.1), driven by `shared/simulation/ground-store.ts`.
  ground_input(world: number, count: number): number;
  ground_write(world: number, op: number, at: number): void;
  ground_dump(world: number): number;
  ground_count(world: number): number;
  players_dump(world: number): number;
  players_count(world: number): number;
  visibility_polygon(index: number, gates: number, x: number, y: number, radius: number): number;
  // Discovery (`rust/core/src/discovery.rs`), driven by `shared/discovery.ts` through `shared/sight-core.ts`.
  discovery_map_new(constants: number, inside: number, cellCount: number, landmarks: number, landmarkCount: number,
    roofs: number, roofWords: number, buildings: number, buildingCount: number): number;
  discovery_map_free(map: number): void;
  discovery_input(map: number, len: number): number;
  discovery_sample(map: number, index: number, gates: number): number;
  /** `roofAt`'s interned id at a point, or -1: for `tests/discovery-core.test.js`'s parity check with `shared/view.ts`. */
  discovery_roof_at(map: number, x: number, y: number): number;
  // Collision (`rust/core/src/collision.rs`, #1233), through `shared/sight-core.ts`, with sight's index and gate set.
  collision_map_new(constants: number, occupied: number, cellCount: number, colliders: number, colliderWords: number,
    offsets: number, colliderCount: number, grid: number, gridLength: number): number;
  collision_map_free(map: number): void;
  /** 1 when clear; `flags` bit 1 ignores gates, bit 2 is a projectile's test. */
  can_occupy(map: number, gates: number, x: number, y: number, radius: number, flags: number): number;
  /** `lineClear` and `reachClear`: the ray-edge tests made, doubled, plus 1 when clear. */
  line_clear(index: number, gates: number, ax: number, ay: number, bx: number, by: number): number;
  reach_clear(index: number, gates: number, ax: number, ay: number, bx: number, by: number): number;
  /** For the parity check with `shared/playable-area.ts` and `shared/shape-queries.ts` only. */
  collision_inside(map: number, x: number, y: number, radius: number): number;
  collision_depth(map: number, collider: number, x: number, y: number, radius: number): number;
  // Swept contact (`rust/core/src/swept.rs`, #1229): shape rows are `kind, x, y, a, b, n`, then `n` point pairs.
  swept_map_new(statics: number, staticsLength: number, shots: number, staticCount: number, gates: number, gatesLength: number): number;
  swept_map_free(map: number): void;
  /** `geometryContact`: the first contact, Infinity when clear; `passSeeThrough` nonzero is the shot policy. */
  swept_contact(map: number, gates: number, passSeeThrough: number, ax: number, ay: number, bx: number, by: number, radius: number,
    extra: number, extraLength: number): number;
}

/**
 * The crate's port of shared/math.ts, exported per scalar for tests/math.test.js's parity check
 * only. JavaScript callers keep shared/math.ts (docs/27, "Port order").
 */
export interface MathParityExports extends CoreExports {
  math_sin(x: number): number;
  math_cos(x: number): number;
  math_atan(x: number): number;
  math_atan2(y: number, x: number): number;
  math_hypot(x: number, y: number): number;
}

/** The generated module holding the core's bytes; named through a variable so tsc need not find it. */
const EMBEDDED = './core-wasm.generated.ts';
let embedded: Promise<CoreExports> | undefined;

/**
 * The process's one core: the module `tools/build-core.mjs` embeds, instantiated once and shared by
 * every caller, as `initPhysics` shares it with physics. Node and the browser import it the same way, so neither
 * host supplies the bytes. It only loads; which sight a game uses is given to the game (`createGame`).
 */
export function initCore(): Promise<CoreExports> {
  return embedded ??= (import(EMBEDDED) as Promise<{ CORE_WASM_BASE64: string }>).then(
    ({ CORE_WASM_BASE64 }) => loadCore(Uint8Array.from(atob(CORE_WASM_BASE64), c => c.charCodeAt(0))),
    error => { throw new Error(`the core module is not built (npm run core:build): ${(error as Error).message}`); });
}

/** Instantiates the core and checks its adapter version before anything else is called. */
export async function loadCore(bytes: ArrayBuffer | ArrayBufferView): Promise<CoreExports> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const core = instance.exports as unknown as CoreExports;
  const version = core.adapter_version();
  if (version !== CORE_ADAPTER_VERSION)
    throw new Error(`the core module speaks adapter version ${version}, this loader ${CORE_ADAPTER_VERSION}: rust/core/src/lib.rs's ` +
      `ADAPTER_VERSION and CORE_ADAPTER_VERSION here disagree, or the module predates a change; rebuild it (npm run core:build)`);
  return core;
}
