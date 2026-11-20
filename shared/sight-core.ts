import { count } from './profiler.ts';
import { initCore, type CoreExports } from './core.ts';
import { gateTables, sightTables, VISION, type SightCaster, type VisibilityPoint } from './sight.ts';
import type { CollisionMap, GameMap, Gate, ItemId, Obstacle, PlayableArea, Vec2, World } from './types.ts';

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

/** The map fields a discovery upload reads: `DiscoveryMap` in `shared/discovery.ts`. */
type DiscoveryMap = CollisionMap & Pick<GameMap, 'buildings'> & Partial<Pick<GameMap<ItemId>, 'chargers' | 'stations' | 'exit' | 'roofs'>>;
/** What discovery uploads for a map, built by `discoveryTables` in `shared/discovery.ts`, which owns the rule's inputs. */
export interface DiscoveryTables { constants: Float64Array; inside: Uint8Array; landmarks: Float64Array; roofs: Float64Array; buildings: Float64Array }

/** A live handle, which is a pointer into WASM memory. */
type Handle = number;

export interface CoreSight extends SightCaster {
  /** `visibilityPolygon` computed by the core, pinned by `tests/sight-core.test.js`'s digests (#1175). */
  visibilityPolygon(map: CollisionMap, origin: Vec2, radius?: World): VisibilityPoint[];
  /**
   * The same polygon left in WASM memory as `x, y, angle, length` per point, without building
   * objects. It is valid until the next call into the core; for measuring the crossing alone.
   */
  visibilityPolygonFlat(map: CollisionMap, origin: Vec2, radius?: World): Float64Array;
  /**
   * One discovery sample in the core (`rust/core/src/discovery.rs`, #1210), the transport `discover` in
   * `shared/discovery.ts` packs and unpacks around. `fill` writes the `words` of input; the result is the
   * core's output, valid until the next call into the core. A sample with line of sight builds the
   * map's sight index and gate set, and writes the open-gate mask, first. `tables` builds the map's upload
   * the first time the map is met.
   */
  sampleDiscovery<M extends DiscoveryMap>(map: M, tables: (map: M) => DiscoveryTables, lineOfSight: boolean, words: number,
    fill: (input: Float64Array) => void): Uint32Array;
  /** `roofAt`'s interned id at a point as the core reads the map's roofs, or -1: for the parity check only. */
  roofIdAt<M extends DiscoveryMap>(map: M, tables: (map: M) => DiscoveryTables, x: World, y: World): number;
}

let processSight: Promise<CoreSight> | undefined;
/**
 * Sight through the process's one core (`initCore`), bound once: its uploaded indexes are shared by
 * every game and scene in the process, as the core's memory is. Games receive it from `createGame`.
 */
export const initCoreSight = (): Promise<CoreSight> => processSight ??= initCore().then(coreSight);

/** Bind a loaded core to sight. Instantiate once per core. */
export function coreSight(core: CoreExports): CoreSight {
  const indexes = new WeakMap<readonly Obstacle[], { count: number; handle: Handle }>();
  const gateSets = new WeakMap<Gate[], { count: number; handle: Handle; open: number }>();
  // Keyed on the playable area, which every match map has and a spread copy of the map keeps; the
  // other fields the upload reads are checked, so a map that shares the area but not them rebuilds.
  const discoveryMaps = new WeakMap<PlayableArea, { source: unknown[]; handle: Handle }>();
  const release = new FinalizationRegistry<() => void>(free => free());
  /** Free a handle a grown list superseded now, rather than when the list is collected. */
  const supersede = (entry: { handle: Handle } | undefined, free: (handle: Handle) => void) => {
    if (!entry) return;
    release.unregister(entry);
    free(entry.handle);
  };

  /** Copy the arrays into fresh WASM buffers, call `use` with their pointers, then free them. */
  function withBuffers<T>(arrays: (Float64Array | Int32Array | Uint32Array | Uint8Array)[], use: (pointers: number[]) => T): T {
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
    supersede(cached, handle => core.sight_index_free(handle));
    const { segments, grid } = sightTables(map);
    const handle = withBuffers([segments, grid], ([s, g]) => core.sight_index_new(s, segments.length / 4, g, grid.length) >>> 0);
    const entry = { count: map.obstacles.length, handle };
    indexes.set(map.obstacles, entry);
    release.register(map.obstacles, () => core.sight_index_free(handle), entry);
    return handle;
  }

  function gateSetFor(map: CollisionMap): { handle: Handle; open: number } {
    const cached = gateSets.get(map.gates);
    if (cached && cached.count === map.gates.length) return cached;
    supersede(cached, handle => core.gate_set_free(handle));
    const { edges, offsets, grid } = gateTables(map);
    const handle = withBuffers([edges, offsets, grid],
      ([e, o, g]) => core.gate_set_new(e, edges.length / 4, o, offsets.length - 1, g, grid.length) >>> 0);
    const entry = { count: map.gates.length, handle, open: core.gate_set_open(handle) >>> 0 };
    gateSets.set(map.gates, entry);
    release.register(map.gates, () => core.gate_set_free(handle), entry);
    return entry;
  }

  /** The map's gate set, with the open mask written as the gates stand now. */
  function openGates(map: CollisionMap): Handle {
    const gates = gateSetFor(map);
    if (map.gates.length) {
      const open = new Uint8Array(core.memory.buffer, gates.open, map.gates.length);
      for (let i = 0; i < map.gates.length; i++) open[i] = map.gates[i].open ? 1 : 0;
    }
    return gates.handle;
  }

  function discoveryMapFor<M extends DiscoveryMap>(map: M, tables: (map: M) => DiscoveryTables): Handle {
    const area = map.playableArea;
    if (!area) throw new RangeError('Map has no playableArea');
    const source = [map.width, map.height, map.buildings, map.roofs, map.chargers, map.stations, map.exit];
    const cached = discoveryMaps.get(area);
    if (cached && cached.source.every((v, i) => v === source[i])) return cached.handle;
    supersede(cached, handle => core.discovery_map_free(handle));
    const { constants, inside, landmarks, roofs, buildings } = tables(map);
    const handle = withBuffers([constants, inside, landmarks, roofs, buildings], ([c, i, l, r, b]) =>
      core.discovery_map_new(c, i, inside.length, l, landmarks.length / 3, r, roofs.length, b, buildings.length / 5) >>> 0);
    const entry = { source, handle };
    discoveryMaps.set(area, entry);
    release.register(area, () => core.discovery_map_free(handle), entry);
    return handle;
  }

  function cast(map: CollisionMap, origin: Vec2, radius: World): { index: Handle; points: Float64Array } {
    count('calls.visibilityPolygon');
    const index = indexFor(map), gates = openGates(map);
    const n = core.visibility_polygon(index, gates, origin.x, origin.y, radius);
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
    sampleDiscovery(map, tables, lineOfSight, words, fill) {
      const handle = discoveryMapFor(map, tables);
      const index = lineOfSight ? indexFor(map) : 0, gates = lineOfSight ? openGates(map) : 0;
      // Resizing the input may grow the memory, so the view is made from the buffer after the call.
      const input = core.discovery_input(handle, words) >>> 0;
      fill(new Float64Array(core.memory.buffer, input, words));
      const out = core.discovery_sample(handle, index, gates) >>> 0;
      // The output's length follows from its own counts, so the view runs to the end of memory.
      return new Uint32Array(core.memory.buffer, out, (core.memory.buffer.byteLength - out) >>> 2);
    },
    roofIdAt(map, tables, x, y) {
      return core.discovery_roof_at(discoveryMapFor(map, tables), x, y);
    },
  };
}
