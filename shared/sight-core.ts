import { count } from './profiler.ts';
import { initCore, type CoreExports } from './core.ts';
import { gateTables, sightTables, VISION, type SightCaster, type VisibilityPoint } from './sight.ts';
import { collisionTables } from './movement.ts';
import type { CollisionMap, GameMap, Gate, GateId, ItemId, Obstacle, PlayableArea, Vec2, World } from './types.ts';

// The adapter between `shared/sight.ts` and the Rust core's port of `visibilityPolygon`
// (`rust/core/src/sight.rs`, #1175 stage 2, docs/27).
//
// - **Uploaded once:** a sight index per obstacle list and a gate set per gate list, as flat
//   arrays `sight.ts` derives from its own index. Each is cached on its list as `sight.ts` caches,
//   and freed when the list is collected.
// - **Per call:** the open-gate mask is written into the gate set, then origin and radius go in and
//   the points come back in a buffer the core owns.
// - **Collision (#1233)** is the same binding's: `canOccupy`, `lineClear` and `reachClear` in the core
//   (`rust/core/src/collision.rs`), from a collision map per obstacle list beside the sight index and
//   gate set. They answer scalars, and `tests/collision-core.test.js` holds them equal to the TypeScript,
//   which keeps its other callers (movement, bots, tools).
// - **The tick boundary (#1234)** takes the three handles (`queryHandles`) into calls that query them many
//   times: phase 1, the body sync, the pending admission and the placement search. The mask is written
//   once per such call.
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
  /** `canOccupy` (`shared/movement.ts`) in the core, with the gates as they stand now. */
  canOccupy(map: CollisionMap, x: World, y: World, radius?: World, ignoreGates?: boolean, projectile?: boolean): boolean;
  /** `lineClear` (`shared/sight.ts`) in the core. */
  lineClear(map: CollisionMap, a: Vec2, b: Vec2, ignoreGateId?: GateId | null): boolean;
  /** `reachClear` (`shared/sight.ts`) in the core. */
  reachClear(map: CollisionMap, a: Vec2, b: Vec2): boolean;
  /** `insideMap` over the core's copy of the playable cells: for the parity check only. */
  insideMap(map: CollisionMap, x: World, y: World, radius?: World): boolean;
  /** The depth of the disk in the map's collider `i` as the core's SAT port reads it, or -1: for the parity check only. */
  colliderDepth(map: CollisionMap, i: number, x: World, y: World, radius: World): number;
  /**
   * The map's collision upload, sight index and gate set, for a core call that queries them many times
   * (`shared/simulation/boundary.ts`, #1234). `openMask` writes the gates as they stand now, once for the call;
   * without it the mask is as the last call left it, for a call that makes no gate-reading query.
   */
  queryHandles(map: CollisionMap, openMask: boolean): { core: CoreExports; collision: Handle; index: Handle; gates: Handle };
  /** Builds the map's collision upload, sight index and gate set now, so no tick builds them (42.66). */
  prepareCollision(map: CollisionMap): void;
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
  // Keyed on the obstacle list, as movement's colliders are; rebuilt when the list grows or the map's
  // size or playable area differs.
  const collisionMaps = new WeakMap<readonly Obstacle[], { count: number; width: World; height: World; area: PlayableArea | undefined; handle: Handle }>();
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
    const { segments, grid, through } = sightTables(map);
    const handle = withBuffers([segments, grid, through.edges, through.offsets, through.grid], ([s, g, te, to, tg]) =>
      core.sight_index_new(s, segments.length / 4, g, grid.length, te, through.edges.length / 4, to, through.offsets.length - 1, tg, through.grid.length) >>> 0);
    const entry = { count: map.obstacles.length, handle };
    indexes.set(map.obstacles, entry);
    release.register(map.obstacles, () => core.sight_index_free(handle), entry);
    return handle;
  }

  function gateSetFor(map: CollisionMap): { handle: Handle; open: number } {
    const cached = gateSets.get(map.gates);
    if (cached && cached.count === map.gates.length) return cached;
    supersede(cached, handle => core.gate_set_free(handle));
    const { edges, offsets, boxes, grid } = gateTables(map);
    const handle = withBuffers([edges, offsets, boxes, grid],
      ([e, o, b, g]) => core.gate_set_new(e, edges.length / 4, o, offsets.length - 1, b, g, grid.length) >>> 0);
    const entry = { count: map.gates.length, handle, open: core.gate_set_open(handle) >>> 0 };
    gateSets.set(map.gates, entry);
    release.register(map.gates, () => core.gate_set_free(handle), entry);
    return entry;
  }

  /** The map's gate set, with the open mask written as the gates stand now; a gate `lineClear` ignores is written open. */
  function openGates(map: CollisionMap, ignore: GateId | null = null): Handle {
    const gates = gateSetFor(map);
    if (map.gates.length) {
      const open = new Uint8Array(core.memory.buffer, gates.open, map.gates.length), list = map.gates;
      if (ignore === null) for (let i = 0; i < list.length; i++) open[i] = list[i].open ? 1 : 0;
      else for (let i = 0; i < list.length; i++) open[i] = list[i].open || list[i].id === ignore ? 1 : 0;
    }
    return gates.handle;
  }

  function collisionFor(map: CollisionMap): Handle {
    const cached = collisionMaps.get(map.obstacles);
    if (cached && cached.count === map.obstacles.length && cached.width === map.width && cached.height === map.height
      && cached.area === map.playableArea) return cached.handle;
    // Built before the stale handle is freed, so a map without a playable area throws as `canOccupy` does and keeps it.
    const { constants, occupied, colliders, offsets, grid } = collisionTables(map);
    supersede(cached, handle => core.collision_map_free(handle));
    const handle = withBuffers([constants, occupied, colliders, offsets, grid], ([c, o, w, f, g]) =>
      core.collision_map_new(c, o, occupied.length, w, colliders.length, f, offsets.length - 1, g, grid.length) >>> 0);
    const entry = { count: map.obstacles.length, width: map.width, height: map.height, area: map.playableArea, handle };
    collisionMaps.set(map.obstacles, entry);
    release.register(map.obstacles, () => core.collision_map_free(handle), entry);
    return handle;
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
    canOccupy(map, x, y, radius = 12, ignoreGates = false, projectile = false) {
      count('calls.canOccupy');
      const handle = collisionFor(map), gates = ignoreGates ? gateSetFor(map).handle : openGates(map);
      return core.can_occupy(handle, gates, x, y, radius, (ignoreGates ? 1 : 0) | (projectile ? 2 : 0)) === 1;
    },
    lineClear(map, a, b, ignoreGateId = null) {
      count('calls.lineClear');
      const index = indexFor(map), gates = openGates(map, ignoreGateId);
      const answer = core.line_clear(index, gates, a.x, a.y, b.x, b.y) >>> 0;
      count('work.rayEdgeTests', answer >>> 1);
      return (answer & 1) === 1;
    },
    reachClear(map, a, b) {
      count('calls.lineClear');
      const index = indexFor(map), gates = openGates(map);
      const answer = core.reach_clear(index, gates, a.x, a.y, b.x, b.y) >>> 0;
      count('work.rayEdgeTests', answer >>> 1);
      return (answer & 1) === 1;
    },
    insideMap(map, x, y, radius = 0) {
      return core.collision_inside(collisionFor(map), x, y, radius) === 1;
    },
    colliderDepth(map, i, x, y, radius) {
      return core.collision_depth(collisionFor(map), i, x, y, radius);
    },
    queryHandles(map, openMask) {
      const collision = collisionFor(map), index = indexFor(map);
      return { core, collision, index, gates: openMask ? openGates(map) : gateSetFor(map).handle };
    },
    prepareCollision(map) {
      collisionFor(map); indexFor(map); gateSetFor(map);
    },
  };
}
