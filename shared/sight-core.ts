import { count } from './profiler.ts';
import { initCore, type CoreExports } from './core.ts';
import { gateTables, sightTables, VISION, type SightCaster, type VisibilityPoint } from './sight.ts';
import { collisionTables } from './movement.ts';
import { sweptUpload } from './simulation/swept.ts';
import type { Shape } from './shape.ts';
import type { CollisionMap, GameMap, Gate, GateId, ItemId, Obstacle, PlayableArea, Vec2, World } from './types.ts';

// The adapter between `shared/sight.ts` and the Rust core's port of `visibilityPolygon`
// (`rust/core/src/sight.rs`, #1175 stage 2, docs/27).
//
// - **Uploaded once:** a sight index per obstacle list and a gate set per gate list, as flat
//   arrays `sight.ts` derives from its own index. Each is cached on its list as `sight.ts` caches,
//   and freed when the list is collected.
// - **Per call:** origin and radius go in and the points come back in a buffer the core owns. A map's
//   open-gate mask is written into the gate set first, from its gate records, unless a game owns the
//   gate set (below).
// - **A game's doors are the core's (#1214 stage 6a).** `ownGates` hands a game's gate set its door state
//   once, when `createGame` prepares the map: from then on the gate set's open and lock masks are the doors'
//   state, written only by the core's rules and by `writeGate`, and the gate records are their mirror
//   (`shared/simulation/doors.ts`). Nothing writes the masks per call. A map no game owns, such as a
//   client's remembered gates or a tool's, is written per call as before.
// - **Collision (#1233)** is the same binding's: `canOccupy`, `lineClear` and `reachClear` in the core
//   (`rust/core/src/collision.rs`), from a collision map per obstacle list beside the sight index and
//   gate set. They answer scalars, and `tests/collision-core.test.js` holds them equal to the TypeScript,
//   which keeps its other callers (movement, bots, tools).
// - **The tick boundary (#1234)** takes the three handles (`queryHandles`) into calls that query them many
//   times: phase 1, the body sync, the pending admission, the placement search and the drop scatter, and every
//   later phase's run. Those are a game's, so they read the doors' state where the core keeps it and write no mask.
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
   * (`shared/simulation/boundary.ts`, #1234). Every caller is a game's, whose gate set holds its doors' state
   * (`ownGates`), so nothing is written.
   */
  queryHandles(map: CollisionMap): { core: CoreExports; collision: Handle; index: Handle; gates: Handle };
  /**
   * Hand the map's gate set its doors' state, read once from the gate records: open, and the lock (absent,
   * locked or unlocked). From then on the core's rules and `writeGate` write it, and no call writes the masks
   * from the records. `createGame` calls it once the map's gate list is pinned (#1214 stage 6a).
   */
  ownGates(map: CollisionMap): void;
  /** A between-tick write of one owned gate's state into the core: `locked` is 0 absent, 1 locked, 2 unlocked. */
  writeGate(map: CollisionMap, index: number, open: boolean, locked: 0 | 1 | 2): void;
  /** One owned gate's state as the core holds it: for tests that hold the mirror equal to it. */
  readGate(map: CollisionMap, index: number): { open: boolean; locked: 0 | 1 | 2 };
  /**
   * The map's swept upload (`rust/core/src/swept.rs`, #1229), for the hook's rules (`shared/simulation/hook.ts`), which pair
   * it with `queryHandles`' gate set. Built only when first asked or by `prepareSwept`, so no call that never sweeps builds it.
   */
  sweptHandle(map: CollisionMap): Handle;
  /** `geometryContact` (`shared/simulation/swept.ts`) in the core, with the gates as they stand now: for the parity check and later callers. */
  sweptContact(map: CollisionMap, passSeeThrough: boolean, a: Vec2, b: Vec2, radius: World, extra?: readonly Shape[]): number;
  /** Builds the map's collision upload, sight index and gate set now, so no tick builds them (42.66). */
  prepareCollision(map: CollisionMap): void;
  /**
   * Builds the map's swept upload now. `createGame` calls it after `prepareSweptGeometry` and `prepareSweptGates`, so the
   * upload reads the caches they built while yielding, rather than building them again without yielding.
   */
  prepareSwept(map: CollisionMap): void;
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
  // `owned` once a game holds its doors' state in the set (`ownGates`); the masks are then never written from the records.
  const gateSets = new WeakMap<Gate[], { count: number; handle: Handle; open: number; locked: number; owned: boolean }>();
  // Keyed on the playable area, which every match map has and a spread copy of the map keeps; the
  // other fields the upload reads are checked, so a map that shares the area but not them rebuilds.
  const discoveryMaps = new WeakMap<PlayableArea, { source: unknown[]; handle: Handle }>();
  // Keyed on the obstacle list, as movement's colliders are; rebuilt when the list grows or the map's
  // size or playable area differs.
  const collisionMaps = new WeakMap<readonly Obstacle[], { count: number; width: World; height: World; area: PlayableArea | undefined; handle: Handle }>();
  // Keyed on the obstacle list as the collision map is; rebuilt when that list grows, the map's size or playable area
  // differs (the boundary walls and voids come from them), or the gate list is another list or grew.
  const sweptMaps = new WeakMap<readonly Obstacle[], { count: number; width: World; height: World; area: PlayableArea | undefined;
    gateList: readonly Gate[]; gates: number; handle: Handle }>();
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

  function gateSetFor(map: CollisionMap): { handle: Handle; open: number; locked: number; owned: boolean } {
    const cached = gateSets.get(map.gates);
    if (cached && cached.count === map.gates.length) return cached;
    // An owned list is pinned, so it never grows; a set rebuilt here would lose the doors' state.
    if (cached?.owned) throw new Error('an owned gate list changed length');
    supersede(cached, handle => core.gate_set_free(handle));
    const { edges, offsets, boxes, grid } = gateTables(map);
    const handle = withBuffers([edges, offsets, boxes, grid],
      ([e, o, b, g]) => core.gate_set_new(e, edges.length / 4, o, offsets.length - 1, b, g, grid.length) >>> 0);
    const entry = { count: map.gates.length, handle, open: core.gate_set_open(handle) >>> 0, locked: core.gate_set_locked(handle) >>> 0, owned: false };
    gateSets.set(map.gates, entry);
    release.register(map.gates, () => core.gate_set_free(handle), entry);
    return entry;
  }

  /** A view of a gate set's mask, made after any call that may have grown the memory. */
  const maskOf = (pointer: number, count: number): Uint8Array => new Uint8Array(core.memory.buffer, pointer, count);
  const lockByte = (locked: boolean | null | undefined): 0 | 1 | 2 => locked == null ? 0 : locked ? 1 : 2;

  /**
   * The map's gate set. Unless a game owns it, the open mask is written as the gate records stand now, and a gate
   * `lineClear` ignores is written open; an owned set's mask is the doors' state, which `lineClear` handles itself.
   */
  function openGates(map: CollisionMap, ignore: GateId | null = null): Handle {
    const gates = gateSetFor(map);
    if (gates.owned) return gates.handle;
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

  /** Shape rows for the core: `kind, x, y, a, b, n`, then `n` point pairs. */
  function shapeRows(shapes: readonly Shape[]): Float64Array {
    let words = 0;
    for (const shape of shapes) words += 6 + (shape.kind === 'polygon' ? shape.points.length * 2 : 0);
    const rows = new Float64Array(words);
    let i = 0;
    for (const shape of shapes) {
      if (shape.kind === 'circle') rows.set([0, shape.x, shape.y, shape.r, 0, 0], i);
      else if (shape.kind === 'rect') rows.set([1, shape.x, shape.y, shape.w, shape.h, 0], i);
      else {
        rows.set([2, shape.x, shape.y, 0, 0, shape.points.length], i);
        shape.points.forEach((point, k) => rows.set([point.x, point.y], i + 6 + 2 * k));
      }
      i += 6 + (shape.kind === 'polygon' ? shape.points.length * 2 : 0);
    }
    return rows;
  }

  function sweptFor(map: CollisionMap): Handle {
    const cached = sweptMaps.get(map.obstacles);
    if (cached && cached.count === map.obstacles.length && cached.width === map.width && cached.height === map.height
      && cached.area === map.playableArea && cached.gateList === map.gates && cached.gates === map.gates.length) return cached.handle;
    const { statics, shots, gates } = sweptUpload(map);
    supersede(cached, handle => core.swept_map_free(handle));
    const staticRows = shapeRows(statics), gateRows = shapeRows(gates), shotBytes = Uint8Array.from(shots, shot => shot ? 1 : 0);
    const handle = withBuffers([staticRows, shotBytes, gateRows], ([s, t, g]) =>
      core.swept_map_new(s, staticRows.length, t, shotBytes.length, g, gateRows.length) >>> 0);
    const entry = { count: map.obstacles.length, width: map.width, height: map.height, area: map.playableArea,
      gateList: map.gates, gates: map.gates.length, handle };
    sweptMaps.set(map.obstacles, entry);
    release.register(map.obstacles, () => core.swept_map_free(handle), entry);
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
      const index = indexFor(map), gates = openGates(map, ignoreGateId), set = gateSetFor(map);
      // An owned set's ignored gate is held open for the query and restored, as phase 6's rule does in the core.
      const held = set.owned && ignoreGateId !== null ? map.gates.findIndex(g => g.id === ignoreGateId) : -1;
      const was = held >= 0 ? maskOf(set.open, map.gates.length)[held]! : 0;
      if (held >= 0) maskOf(set.open, map.gates.length)[held] = 1;
      const answer = core.line_clear(index, gates, a.x, a.y, b.x, b.y) >>> 0;
      if (held >= 0) maskOf(set.open, map.gates.length)[held] = was;
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
    sweptContact(map, passSeeThrough, a, b, radius, extra = []) {
      const handle = sweptFor(map), gates = openGates(map), rows = shapeRows(extra);
      return withBuffers([rows], ([e]) => core.swept_contact(handle, gates, passSeeThrough ? 1 : 0, a.x, a.y, b.x, b.y, radius, e, rows.length));
    },
    queryHandles(map) {
      const collision = collisionFor(map), index = indexFor(map);
      return { core, collision, index, gates: openGates(map) };
    },
    ownGates(map) {
      const set = gateSetFor(map);
      if (set.owned) return;
      const open = maskOf(set.open, map.gates.length), locked = maskOf(set.locked, map.gates.length);
      for (let i = 0; i < map.gates.length; i++) { const gate = map.gates[i]!; open[i] = gate.open ? 1 : 0; locked[i] = lockByte(gate.locked); }
      set.owned = true;
    },
    writeGate(map, index, open, locked) {
      const set = gateSetFor(map);
      if (!set.owned) throw new Error('writeGate needs a gate set a game owns');
      if (!(index >= 0 && index < map.gates.length)) throw new RangeError(`no gate ${index}`);
      maskOf(set.open, map.gates.length)[index] = open ? 1 : 0;
      maskOf(set.locked, map.gates.length)[index] = locked;
    },
    readGate(map, index) {
      const set = gateSetFor(map);
      if (!set.owned) throw new Error('readGate needs a gate set a game owns');
      if (!(index >= 0 && index < map.gates.length)) throw new RangeError(`no gate ${index}`);
      return { open: maskOf(set.open, map.gates.length)[index] !== 0, locked: maskOf(set.locked, map.gates.length)[index] as 0 | 1 | 2 };
    },
    sweptHandle(map) {
      return sweptFor(map);
    },
    prepareCollision(map) {
      collisionFor(map); indexFor(map); gateSetFor(map);
    },
    prepareSwept(map) {
      sweptFor(map);
    },
  };
}
