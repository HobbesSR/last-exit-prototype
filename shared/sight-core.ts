import { count } from './profiler.ts';
import type { CoreExports } from './core.ts';
import { gateTables, sightTables, VISION, type VisibilityPoint } from './sight.ts';
import type { CollisionMap, Gate, Obstacle, Vec2, World } from './types.ts';

// The adapter between `shared/sight.ts` and the Rust core's port of `visibilityPolygon`
// (`rust/core/src/sight.rs`, #1175 stage 2, docs/27).
//
// - **Uploaded once:** a sight index per obstacle list and a gate set per gate list, as flat
//   arrays `sight.ts` derives from its own index. Each is cached on its list as `sight.ts` caches,
//   and freed when the list is collected.
// - **Per call:** the open-gate mask is written into the gate set, then origin and radius go in and
//   the points come back in a buffer the core owns.
// - **Views are made after each call,** because any allocation may grow the memory and detach the
//   old `memory.buffer`.

/** A live handle, which is a pointer into WASM memory. */
type Handle = number;

export interface CoreSight {
  /** `visibilityPolygon` computed by the core: equal to the TypeScript's bit for bit. */
  visibilityPolygon(map: CollisionMap, origin: Vec2, radius?: World): VisibilityPoint[];
  /**
   * The same polygon left in WASM memory as `x, y, angle, length` per point, without building
   * objects. It is valid until the next call into the core; for measuring the crossing alone.
   */
  visibilityPolygonFlat(map: CollisionMap, origin: Vec2, radius?: World): Float64Array;
}

/** Bind a loaded core to sight. Instantiate once per core. */
export function coreSight(core: CoreExports): CoreSight {
  const indexes = new WeakMap<readonly Obstacle[], { count: number; handle: Handle }>();
  const gateSets = new WeakMap<Gate[], { count: number; handle: Handle; open: number }>();
  const release = new FinalizationRegistry<() => void>(free => free());

  /** Copy the arrays into fresh WASM buffers, call `use` with their pointers, then free them. */
  function withBuffers<T>(arrays: (Float64Array | Int32Array | Uint32Array)[], use: (pointers: number[]) => T): T {
    const pointers = arrays.map(array => core.core_alloc(array.byteLength) >>> 0);
    try {
      arrays.forEach((array, i) => new Uint8Array(core.memory.buffer, pointers[i], array.byteLength)
        .set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)));
      return use(pointers);
    } finally {
      arrays.forEach((array, i) => core.core_free(pointers[i], array.byteLength));
    }
  }

  function indexFor(map: CollisionMap): Handle {
    const cached = indexes.get(map.obstacles);
    if (cached && cached.count === map.obstacles.length) return cached.handle;
    const { segments, grid } = sightTables(map);
    const handle = withBuffers([segments, grid], ([s, g]) => core.sight_index_new(s, segments.length / 4, g, grid.length) >>> 0);
    indexes.set(map.obstacles, { count: map.obstacles.length, handle });
    release.register(map.obstacles, () => core.sight_index_free(handle));
    return handle;
  }

  function gateSetFor(map: CollisionMap): { handle: Handle; open: number } {
    const cached = gateSets.get(map.gates);
    if (cached && cached.count === map.gates.length) return cached;
    const { edges, offsets, grid } = gateTables(map);
    const handle = withBuffers([edges, offsets, grid],
      ([e, o, g]) => core.gate_set_new(e, edges.length / 4, o, offsets.length - 1, g, grid.length) >>> 0);
    const entry = { count: map.gates.length, handle, open: core.gate_set_open(handle) >>> 0 };
    gateSets.set(map.gates, entry);
    release.register(map.gates, () => core.gate_set_free(handle));
    return entry;
  }

  function cast(map: CollisionMap, origin: Vec2, radius: World): { index: Handle; points: Float64Array } {
    count('calls.visibilityPolygon');
    const index = indexFor(map), gates = gateSetFor(map);
    if (map.gates.length) {
      const open = new Uint8Array(core.memory.buffer, gates.open, map.gates.length);
      for (let i = 0; i < map.gates.length; i++) open[i] = map.gates[i].open ? 1 : 0;
    }
    const n = core.visibility_polygon(index, gates.handle, origin.x, origin.y, radius);
    count('work.visibilityRays', core.sight_index_tests(index));
    return { index, points: new Float64Array(core.memory.buffer, core.sight_index_points(index) >>> 0, n * 4) };
  }

  return {
    visibilityPolygon(map, origin, radius = VISION) {
      const { points } = cast(map, origin, radius), out: VisibilityPoint[] = new Array(points.length / 4);
      for (let i = 0, j = 0; j < points.length; i++, j += 4) out[i] = { x: points[j], y: points[j + 1], angle: points[j + 2], length: points[j + 3] };
      return out;
    },
    visibilityPolygonFlat(map, origin, radius = VISION) {
      return cast(map, origin, radius).points;
    },
  };
}
