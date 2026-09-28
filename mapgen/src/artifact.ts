/**
 * The serialized form of a map.
 *
 * In memory a map is convenient: names are strings, geometry is objects, and
 * every tile and region is its own record. On the wire that is mostly repeated
 * key names and repeated enum members. The wire form fixes both. Every
 * enumerated value — region class, template id, seam kind, feature kind — is
 * interned once into a shared string table and stored as an integer; every bulk
 * field becomes a packed typed array laid out column by column; and anything
 * derivable (a tile's id and position, a region's id and area, every seam
 * between tiles) is dropped and rebuilt on read.
 *
 * A V2 map stores its layout and its interiors. Its structure is derived again
 * on read with the library the layout names, and the final grid, region
 * partition and walls from layout plus interiors (docs/DESIGN_DECISIONS.md "Map
 * layers"). A planned map has no layers yet and stores its tiles, anchors,
 * final grid and regions.
 *
 * The same form serializes to JSON, where typed arrays become plain number
 * arrays, and to BSON, where they stay binary.
 */
import {
  DEFAULT_LIBRARY,
  composeLayers,
  deriveEdges,
  deriveStructure,
  deriveWalls,
  libraryFingerprint,
  macroFeatures,
  makeZones,
  validateMap,
} from "./core.ts";
import { decodeBson, encodeBson, looksLikeBson } from "./bson.ts";
import type { BsonValue } from "./bson.ts";
import type { CodedGrid } from "./coding.ts";
import type {
  GeneratedMap,
  Library,
  MapFeature,
  MapInteriors,
  MapLayout,
  MapParams,
  MapRegion,
  PrimitiveGrid,
  RegionManifest,
  PlacedTile,
  Span,
  ValidationResult,
  Wall,
} from "./types.ts";

export const WIRE_VERSION = 2;
/** Out-of-range marker for a fully closed segment. */
const BARRIER = -1;
/** Out-of-range marker for a segment interiors state nothing about. */
const UNSTATED = -2;

class Strings {
  private list: string[] = [];
  private index = new Map<string, number>();
  id(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.list.length;
    this.index.set(value, next);
    this.list.push(value);
    return next;
  }
  optional(value: string | undefined): number {
    return value === undefined ? -1 : this.id(value);
  }
  get table(): string[] {
    return this.list;
  }
}

type Packed = Float64Array | number[];
/**
 * A run of integers in the narrowest lane that holds it. `w` is the byte width,
 * so a reader can view the bytes correctly no matter which encoding carried
 * them; in JSON the values arrive as plain numbers and `w` is redundant.
 */
interface PackedInts {
  w: number;
  v: Int8Array | Int16Array | Int32Array | Uint8Array | number[];
}

/** Most of a map is small numbers, so pick the lane each array actually needs. */
function packInts(values: Iterable<number>): PackedInts {
  const list = Array.from(values);
  let min = 0,
    max = 0;
  for (const value of list) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min >= -128 && max <= 127) return { w: 1, v: Int8Array.from(list) };
  if (min >= -32768 && max <= 32767) return { w: 2, v: Int16Array.from(list) };
  return { w: 4, v: Int32Array.from(list) };
}
function unpackInts(packed: PackedInts | undefined): Int32Array {
  if (!packed || packed.v === undefined)
    throw new Error("expected packed integer data");
  const value = packed.v;
  if (Array.isArray(value)) return Int32Array.from(value);
  if (value instanceof Uint8Array) {
    const buffer = copyBuffer(value);
    if (packed.w === 1) return Int32Array.from(new Int8Array(buffer));
    if (packed.w === 2) return Int32Array.from(new Int16Array(buffer));
    return new Int32Array(buffer);
  }
  return Int32Array.from(value as Int32Array);
}

function asFloat64(value: unknown): Float64Array {
  if (value instanceof Float64Array) return value;
  if (Array.isArray(value)) return Float64Array.from(value as number[]);
  if (value instanceof Uint8Array) return new Float64Array(copyBuffer(value));
  throw new Error("expected packed float64 data");
}
function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** A run-length grid whose palette has been reduced to numbers. */
interface WireGrid {
  palette: PackedInts | Packed;
  runs: PackedInts;
  count: number;
}
/** A V2 map's layout. Slot positions follow from the params, so they aren't here. */
interface WireLayout {
  library: string;
  template: PackedInts;
  orientation: PackedInts;
  setPiece: PackedInts;
  spawn: number;
  hunter: number;
  exits: PackedInts;
  class: WireGrid;
  segments: WireGrid;
}
export interface WireArtifact {
  format: "last-exit-map";
  wire: number;
  version: number;
  seed: string;
  params: MapParams;
  width: number;
  height: number;
  strings: string[];
  /** V2 maps. */
  layout?: WireLayout;
  /** Planned maps, until their layout is its own layer (#50). */
  tiles?: {
    count: number;
    col: PackedInts;
    row: PackedInts;
    template: PackedInts;
    orientation: PackedInts;
    layout: PackedInts;
    anchor: PackedInts;
  };
  /** V2 maps: what micro made, stated over the layout. */
  interiors?: WireInteriors;
  /** Planned maps only. On a V2 map, micro's features are in its interiors. */
  features?: Array<Record<string, BsonValue>>;
  /** Planned maps only: the final grid. A V2 map derives it from its layers. */
  grid?: {
    width: number;
    height: number;
    cells: {
      class: WireGrid;
      level?: WireGrid;
      spawns: WireSpawns;
    };
    segments: { open: WireGrid };
    vertices: Array<Record<string, BsonValue>>;
  };
  /** Planned maps only: the final regions. A V2 map derives them from its layers. */
  regions?: {
    count: number;
    class: PackedInts;
    seed: PackedInts;
    cellOffsets: PackedInts;
    cells: PackedInts;
    obstacleOffsets: PackedInts;
    obstacles: Packed;
  } & WireManifests;
  metrics: Record<string, number>;
  validation: ValidationResult;
}
interface WireSpawns {
  cell: PackedInts;
  kind: PackedInts;
}
/** Per-region manifests, one column per field. */
interface WireManifests {
  generator: PackedInts;
  spawnsPlaced: PackedInts;
  obstaclesPlaced: PackedInts;
  corridorsHonored: PackedInts;
}
/** A V2 map's interiors. Each region is named by its index in the final partition. */
interface WireInteriors {
  class: WireGrid;
  level?: WireGrid;
  spawns: WireSpawns;
  segments: WireGrid;
  vertices: Array<Record<string, BsonValue>>;
  features: Array<Record<string, BsonValue>>;
  regions: {
    count: number;
    region: PackedInts;
    propOffsets: PackedInts;
    props: Packed;
  } & WireManifests;
}

function packWalls(walls: Wall[]): Float64Array {
  const out = new Float64Array(walls.length * 4);
  walls.forEach((w, i) => {
    out[i * 4] = w.x1;
    out[i * 4 + 1] = w.y1;
    out[i * 4 + 2] = w.x2;
    out[i * 4 + 3] = w.y2;
  });
  return out;
}
function unpackWalls(packed: Float64Array): Wall[] {
  const out: Wall[] = [];
  for (let i = 0; i + 3 < packed.length; i += 4)
    out.push({
      x1: packed[i]!,
      y1: packed[i + 1]!,
      x2: packed[i + 2]!,
      y2: packed[i + 3]!,
    });
  return out;
}

function packClassGrid(grid: CodedGrid<string>, strings: Strings): WireGrid {
  return {
    palette: packInts(grid.palette.map((name) => strings.id(name))),
    runs: packInts(grid.runs),
    count: grid.count,
  };
}
function unpackClassGrid(
  grid: WireGrid,
  name: (id: number) => string,
): CodedGrid<string> {
  return {
    palette: [...unpackInts(grid.palette as PackedInts)].map(name),
    runs: [...unpackInts(grid.runs)],
    count: grid.count,
  };
}
// A span is two numbers in 0..1; a barrier is the out-of-range pair -1, -1.
// A sentinel rather than NaN, because JSON cannot carry NaN.
function packSpanGrid(grid: CodedGrid<Span>): WireGrid {
  const palette = new Float64Array(grid.palette.length * 2);
  grid.palette.forEach((span, i) => {
    palette[i * 2] = span ? span[0] : BARRIER;
    palette[i * 2 + 1] = span ? span[1] : BARRIER;
  });
  return { palette, runs: packInts(grid.runs), count: grid.count };
}
function unpackSpanGrid(grid: WireGrid): CodedGrid<Span> {
  const packed = asFloat64(grid.palette);
  const palette: Span[] = [];
  for (let i = 0; i + 1 < packed.length; i += 2)
    palette.push(packed[i]! < 0 ? null : [packed[i]!, packed[i + 1]!]);
  return { palette, runs: [...unpackInts(grid.runs)], count: grid.count };
}
// A stated span grid adds a second out-of-range pair, -2, -2, for `any`.
function packStatedSpanGrid(grid: CodedGrid<Span | "any">): WireGrid {
  const palette = new Float64Array(grid.palette.length * 2);
  grid.palette.forEach((span, i) => {
    const pair = span === "any" ? [UNSTATED, UNSTATED] : span ? span : [BARRIER, BARRIER];
    palette[i * 2] = pair[0]!;
    palette[i * 2 + 1] = pair[1]!;
  });
  return { palette, runs: packInts(grid.runs), count: grid.count };
}
function unpackStatedSpanGrid(grid: WireGrid): CodedGrid<Span | "any"> {
  const packed = asFloat64(grid.palette);
  const palette: Array<Span | "any"> = [];
  for (let i = 0; i + 1 < packed.length; i += 2)
    palette.push(
      packed[i] === UNSTATED ? "any" : packed[i]! < 0 ? null : [packed[i]!, packed[i + 1]!],
    );
  return { palette, runs: [...unpackInts(grid.runs)], count: grid.count };
}
function packLevelGrid(grid: CodedGrid<number>): WireGrid {
  return { palette: Float64Array.from(grid.palette), runs: packInts(grid.runs), count: grid.count };
}
function unpackLevelGrid(grid: WireGrid): CodedGrid<number> {
  return { palette: [...asFloat64(grid.palette)], runs: [...unpackInts(grid.runs)], count: grid.count };
}
function packSpawns(spawns: Array<{ cell: number; kind: string }>, strings: Strings): WireSpawns {
  return {
    cell: packInts(spawns.map((s) => s.cell)),
    kind: packInts(spawns.map((s) => strings.id(s.kind))),
  };
}
function unpackSpawns(wire: WireSpawns, name: (id: number) => string): Array<{ cell: number; kind: string }> {
  const kinds = unpackInts(wire.kind);
  return [...unpackInts(wire.cell)].map((cell, i) => ({ cell, kind: name(kinds[i]!) }));
}
// Vertices are few and their fields optional, so they stay small documents.
function packVertices(vertices: PrimitiveGrid["vertices"], strings: Strings): Array<Record<string, BsonValue>> {
  return vertices.map((v) => {
    const doc: Record<string, BsonValue> = { vertex: v.vertex };
    if (v.class !== undefined) doc.class = strings.id(v.class);
    if (v.height !== undefined) doc.height = v.height;
    return doc;
  });
}
function unpackVertices(docs: Array<Record<string, BsonValue>>, name: (id: number) => string): PrimitiveGrid["vertices"] {
  return docs.map((doc) => {
    const v = doc as Record<string, number>;
    const entry: { vertex: number; class?: string; height?: number } = { vertex: v.vertex! };
    if (v.class !== undefined) entry.class = name(v.class);
    if (v.height !== undefined) entry.height = v.height;
    return entry;
  });
}
function packManifests(manifests: RegionManifest[], strings: Strings): WireManifests {
  return {
    generator: packInts(manifests.map((m) => strings.optional(m.generator))),
    spawnsPlaced: packInts(manifests.map((m) => m.spawnsPlaced)),
    obstaclesPlaced: packInts(manifests.map((m) => m.obstaclesPlaced)),
    corridorsHonored: packInts(manifests.map((m) => (m.corridorsHonored ? 1 : 0))),
  };
}
function unpackManifests(wire: WireManifests, count: number, name: (id: number) => string): RegionManifest[] {
  const generator = unpackInts(wire.generator),
    spawnsPlaced = unpackInts(wire.spawnsPlaced),
    obstaclesPlaced = unpackInts(wire.obstaclesPlaced),
    corridors = unpackInts(wire.corridorsHonored);
  const manifests: RegionManifest[] = [];
  for (let i = 0; i < count; i++) {
    const manifest: RegionManifest = {
      spawnsPlaced: spawnsPlaced[i]!,
      obstaclesPlaced: obstaclesPlaced[i]!,
      corridorsHonored: corridors[i] === 1,
    };
    if (generator[i]! >= 0) manifest.generator = name(generator[i]!);
    manifests.push(manifest);
  }
  return manifests;
}
/** Lists of walls as one packed column and the offset each list starts at. */
function packWallLists(lists: Wall[][]): { offsets: PackedInts; walls: Float64Array } {
  const offsets = new Int32Array(lists.length + 1);
  lists.forEach((list, i) => (offsets[i + 1] = offsets[i]! + list.length));
  const walls = new Float64Array(offsets[lists.length]! * 4);
  lists.forEach((list, i) => walls.set(packWalls(list), offsets[i]! * 4));
  return { offsets: packInts(offsets), walls };
}
function unpackWallLists(offsets: PackedInts, packed: Packed, count: number): Wall[][] {
  const at = unpackInts(offsets),
    walls = asFloat64(packed);
  const lists: Wall[][] = [];
  for (let i = 0; i < count; i++) lists.push(unpackWalls(walls.subarray(at[i]! * 4, at[i + 1]! * 4)));
  return lists;
}
/** A final region's id is its index in the partition, so the wire stores the index. */
function regionIndex(id: string): number {
  const match = /^r-(\d+)$/.exec(id);
  if (!match) throw new Error(`interiors name region ${id}, which is not a final region id`);
  return Number(match[1]);
}

function packInteriors(interiors: MapInteriors, strings: Strings): WireInteriors {
  const { cells, regions } = interiors;
  const props = packWallLists(regions.map((entry) => entry.props));
  return {
    class: packClassGrid(cells.class, strings),
    ...(cells.level ? { level: packLevelGrid(cells.level) } : {}),
    spawns: packSpawns(cells.spawns, strings),
    segments: packStatedSpanGrid(interiors.segments.open),
    vertices: packVertices(interiors.vertices, strings),
    features: interiors.features.map((f) => ({
      id: strings.id(f.id),
      kind: strings.id(f.kind),
      x: f.x,
      y: f.y,
    })),
    regions: {
      count: regions.length,
      region: packInts(regions.map((entry) => regionIndex(entry.region))),
      propOffsets: props.offsets,
      props: props.walls,
      ...packManifests(regions.map((entry) => entry.manifest), strings),
    },
  };
}
function unpackInteriors(wire: WireInteriors, name: (id: number) => string): MapInteriors {
  const r = wire.regions;
  const region = unpackInts(r.region);
  const props = unpackWallLists(r.propOffsets, r.props, r.count);
  const manifests = unpackManifests(r, r.count, name);
  return {
    cells: {
      class: unpackClassGrid(wire.class, name),
      ...(wire.level ? { level: unpackLevelGrid(wire.level) } : {}),
      spawns: unpackSpawns(wire.spawns, name),
    },
    segments: { open: unpackStatedSpanGrid(wire.segments) },
    vertices: unpackVertices(wire.vertices, name),
    features: wire.features.map((doc) => {
      const f = doc as Record<string, number>;
      return { id: name(f.id!), kind: name(f.kind!) as MapFeature["kind"], x: f.x!, y: f.y! };
    }),
    regions: manifests.map((manifest, i) => ({ region: `r-${region[i]}`, manifest, props: props[i]! })),
  };
}

function packLayout(layout: MapLayout, strings: Strings): WireLayout {
  const { placements, features } = layout;
  return {
    library: layout.library,
    template: packInts(placements.map((p) => strings.id(p.templateId))),
    orientation: packInts(placements.map((p) => p.orientation)),
    setPiece: packInts(placements.map((p) => strings.optional(p.setPieceId))),
    spawn: features.spawn,
    hunter: features.hunter,
    exits: packInts(features.exits),
    class: packClassGrid(layout.grid.cells.class, strings),
    segments: packSpanGrid(layout.grid.segments.open),
  };
}
function unpackLayout(
  wire: WireLayout,
  seed: string,
  params: MapParams,
  width: number,
  height: number,
  name: (id: number) => string,
): MapLayout {
  const template = unpackInts(wire.template),
    orientation = unpackInts(wire.orientation),
    setPiece = unpackInts(wire.setPiece);
  return {
    seed,
    params,
    library: wire.library,
    placements: [...template].map((id, i) => ({
      templateId: name(id),
      orientation: orientation[i]!,
      ...(setPiece[i]! >= 0 ? { setPieceId: name(setPiece[i]!) } : {}),
    })),
    grid: {
      width,
      height,
      cells: { class: unpackClassGrid(wire.class, name) },
      segments: { open: unpackSpanGrid(wire.segments) },
    },
    features: {
      spawn: wire.spawn,
      hunter: wire.hunter,
      exits: [...unpackInts(wire.exits)],
    },
  };
}

/**
 * Refuses a V2 map whose features aren't what its layout and interiors imply:
 * the layout's spawn, hunter spawn and exits, then micro's own. Reading it
 * back would silently change them.
 */
function checkFeatures(map: GeneratedMap, layout: MapLayout, interiors: MapInteriors): void {
  const implied = macroFeatures(layout, map.tiles);
  const leading = map.features.slice(0, implied.length);
  if (JSON.stringify(leading) !== JSON.stringify(implied))
    throw new Error("the map's spawn, hunter spawn and exits don't match its layout");
  const micro = map.features.slice(implied.length).map(({ tileId: _, ...rest }) => rest);
  if (JSON.stringify(micro) !== JSON.stringify(interiors.features))
    throw new Error("the map's micro features don't match its interiors");
}

export function encodeArtifact(map: GeneratedMap): WireArtifact {
  const strings = new Strings();
  const head = {
    format: "last-exit-map" as const,
    wire: WIRE_VERSION,
    version: map.version,
    seed: map.seed,
    params: map.params,
    width: map.width,
    height: map.height,
  };
  const report = {
    metrics: map.metrics as Record<string, number>,
    validation: map.validation,
  };

  if (map.layout || map.interiors) {
    if (!map.layout || !map.interiors)
      throw new Error("a map with a layout has interiors, and one with interiors has a layout");
    checkFeatures(map, map.layout, map.interiors);
    const layout = packLayout(map.layout, strings);
    const interiors = packInteriors(map.interiors, strings);
    return { ...head, strings: strings.table, layout, interiors, ...report };
  }

  // A planned map, until its layers are separated.
  const tileIndex = new Map(map.tiles.map((t, i) => [t.id, i]));
  const tiles = {
    count: map.tiles.length,
    col: packInts(map.tiles.map((t) => t.col)),
    row: packInts(map.tiles.map((t) => t.row)),
    template: packInts(map.tiles.map((t) => strings.id(t.templateId))),
    orientation: packInts(map.tiles.map((t) => t.orientation)),
    layout: packInts(map.tiles.map((t) => strings.optional(t.setPieceId))),
    // Anchors sit on the half-cell lattice, so doubling makes them exact ints.
    anchor: packInts(
      map.tiles.flatMap((t) => {
        const doubled = [t.anchor.x * 2, t.anchor.y * 2];
        if (!doubled.every(Number.isInteger))
          throw new Error("anchor is not on the half-cell lattice");
        return doubled;
      }),
    ),
  };
  const features = map.features.map((f) => {
    const doc: Record<string, BsonValue> = {
      id: strings.id(f.id),
      kind: strings.id(f.kind),
      tile: tileIndex.get(f.tileId) ?? -1,
      x: f.x,
      y: f.y,
    };
    if (f.setPieceId !== undefined) doc.layout = strings.id(f.setPieceId);
    if (f.tileIds)
      doc.tiles = packInts(
        f.tileIds.map((id) => tileIndex.get(id) ?? -1),
      ) as unknown as BsonValue;
    return doc;
  });

  const cells = {
    class: packClassGrid(map.grid.cells.class, strings),
    ...(map.grid.cells.level ? { level: packLevelGrid(map.grid.cells.level) } : {}),
    spawns: packSpawns(map.grid.cells.spawns, strings),
  };

  const cellOffsets = new Int32Array(map.regions.length + 1);
  map.regions.forEach((r, i) => {
    cellOffsets[i + 1] = cellOffsets[i]! + r.cells.length;
  });
  const regionCells = new Int32Array(cellOffsets[map.regions.length]!);
  map.regions.forEach((r, i) => regionCells.set(r.cells, cellOffsets[i]!));
  const obstacles = packWallLists(map.regions.map((r) => r.obstacles));

  return {
    ...head,
    strings: strings.table,
    tiles,
    features,
    grid: {
      width: map.grid.width,
      height: map.grid.height,
      cells,
      segments: { open: packSpanGrid(map.grid.segments.open) },
      vertices: packVertices(map.grid.vertices, strings),
    },
    regions: {
      count: map.regions.length,
      class: packInts(map.regions.map((r) => strings.id(r.cellClass))),
      // Seeds are 32-bit hashes, so they ride in an int32 lane unchanged.
      seed: packInts(map.regions.map((r) => r.seed | 0)),
      cellOffsets: packInts(cellOffsets),
      cells: packInts(regionCells),
      obstacleOffsets: obstacles.offsets,
      obstacles: obstacles.walls,
      ...packManifests(map.regions.map((r) => r.manifest), strings),
    },
    ...report,
  };
}

/** A tile's zone follows from its grid position and the zone dimensions. */
function zoneIdAt(col: number, row: number, params: MapParams): string {
  return `z-${Math.floor(col / params.zoneWidth)}-${Math.floor(row / params.zoneHeight)}`;
}

/** A planned map's tiles, stored with their anchors until #50. */
function unpackTiles(
  t: NonNullable<WireArtifact["tiles"]>,
  params: MapParams,
  name: (id: number) => string,
): PlacedTile[] {
  const size = params.tileSize;
  const col = unpackInts(t.col),
    row = unpackInts(t.row),
    template = unpackInts(t.template),
    orientation = unpackInts(t.orientation),
    layout = unpackInts(t.layout),
    anchor = unpackInts(t.anchor);
  const tiles: PlacedTile[] = [];
  for (let i = 0; i < t.count; i++) {
    const tile: PlacedTile = {
      // Identity and position follow from the grid coordinates.
      id: `t-${col[i]}-${row[i]}`,
      x: col[i]! * size,
      y: row[i]! * size,
      col: col[i]!,
      row: row[i]!,
      zoneId: zoneIdAt(col[i]!, row[i]!, params),
      templateId: name(template[i]!),
      orientation: orientation[i]!,
      anchor: { x: anchor[i * 2]! / 2, y: anchor[i * 2 + 1]! / 2 },
    };
    if (layout[i]! >= 0) tile.setPieceId = name(layout[i]!);
    tiles.push(tile);
  }
  return tiles;
}

/**
 * A map from its wire form. A V2 map's structure is derived from its layout
 * with `library`, which must be the library the map was generated with, and
 * its final grid, regions and walls from layout plus interiors.
 */
export function decodeArtifact(
  input: unknown,
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  const wire = input as WireArtifact;
  if (
    !wire ||
    wire.format !== "last-exit-map" ||
    !Array.isArray(wire.strings) ||
    !wire.params
  )
    throw new Error("not a last-exit-map artifact");
  if (wire.wire === 1)
    throw new Error(
      `wire version 1 is no longer read: it stored derived structure instead of the layout. ` +
        `Regenerate the map; this reader takes wire version ${WIRE_VERSION}`,
    );
  if (wire.wire !== WIRE_VERSION)
    throw new Error(
      `unsupported wire version ${wire.wire}; this reader takes wire version ${WIRE_VERSION}`,
    );
  const names = wire.strings;
  const name = (id: number): string => {
    const value = names[id];
    if (value === undefined)
      throw new Error(`string ${id} is not in the table`);
    return value;
  };
  const params = wire.params as MapParams;
  const report = {
    metrics: wire.metrics as GeneratedMap["metrics"],
    validation: wire.validation,
  };

  if (wire.layout) {
    if (!wire.interiors) throw new Error("artifact has a layout and no interiors");
    const layout = unpackLayout(wire.layout, wire.seed, params, wire.width, wire.height, name);
    const expected = libraryFingerprint(library);
    if (layout.library !== expected)
      throw new Error(
        `this map was generated with a different library (${layout.library}, not ${expected}); ` +
          `read it with the library it was generated from`,
      );
    const derived = deriveStructure(layout, library);
    if (!derived)
      throw new Error("the stored layout has no street network, so no generator made it");
    const map = composeLayers(layout, derived, unpackInteriors(wire.interiors, name), report);
    map.version = wire.version;
    return map;
  }
  if (!wire.tiles || !wire.grid || !wire.regions || !wire.features)
    throw new Error("artifact has neither a layout nor tiles");

  // A planned map, until its layers are separated.
  const tiles = unpackTiles(wire.tiles, params, name);
  const features: MapFeature[] = wire.features.map((doc) => {
    const f = doc as Record<string, number | Packed>;
    const feature: MapFeature = {
      id: name(f.id as number),
      kind: name(f.kind as number) as MapFeature["kind"],
      tileId: tiles[f.tile as number]!.id,
      x: f.x as number,
      y: f.y as number,
    };
    if (f.layout !== undefined) feature.setPieceId = name(f.layout as number);
    if (f.tiles !== undefined)
      feature.tileIds = [...unpackInts(f.tiles as unknown as PackedInts)].map(
        (i) => tiles[i]!.id,
      );
    return feature;
  });

  const gc = wire.grid.cells;
  const grid: GeneratedMap["grid"] = {
    width: wire.grid.width,
    height: wire.grid.height,
    cells: {
      class: unpackClassGrid(gc.class, name),
      ...(gc.level ? { level: unpackLevelGrid(gc.level) } : {}),
      spawns: unpackSpawns(gc.spawns, name),
    },
    segments: { open: unpackSpanGrid(wire.grid.segments.open) },
    vertices: unpackVertices(wire.grid.vertices, name),
  };

  const r = wire.regions;
  const rclass = unpackInts(r.class),
    rseed = unpackInts(r.seed),
    cellOffsets = unpackInts(r.cellOffsets),
    regionCells = unpackInts(r.cells);
  const obstacles = unpackWallLists(r.obstacleOffsets, r.obstacles, r.count);
  const manifests = unpackManifests(r, r.count, name);
  const regions: MapRegion[] = [];
  for (let i = 0; i < r.count; i++) {
    const cells = [
      ...regionCells.subarray(cellOffsets[i]!, cellOffsets[i + 1]!),
    ];
    regions.push({
      id: `r-${i}`,
      cellClass: name(rclass[i]!),
      area: cells.length,
      cells,
      seed: rseed[i]! >>> 0,
      obstacles: obstacles[i]!,
      manifest: manifests[i]!,
    });
  }

  const map: GeneratedMap = {
    version: wire.version,
    seed: wire.seed,
    params,
    width: wire.width,
    height: wire.height,
    zones: makeZones(params),
    tiles,
    // Seams and geometry are both measurements of the primitives below, so
    // neither is carried on the wire; both are derived once the grid is back.
    edges: [],
    walls: [],
    features,
    grid,
    regions,
    ...report,
  };
  // Geometry is derived, never stored, so it cannot drift from the primitives.
  map.walls = deriveWalls(map);
  map.edges = deriveEdges(map);
  return map;
}

/** Typed arrays are binary in BSON and plain number arrays in JSON. */
function widen(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(widen);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, widen(inner)]),
    );
  return value;
}

export function artifactToJson(map: GeneratedMap, space?: number): string {
  return JSON.stringify(widen(encodeArtifact(map)), null, space);
}
export function artifactToBson(map: GeneratedMap): Uint8Array {
  return encodeBson(
    encodeArtifact(map) as unknown as Record<string, BsonValue>,
  );
}
export function artifactFromBson(
  bytes: Uint8Array,
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  return decodeArtifact(decodeBson(bytes), library);
}
/** Read either encoding, decided by the bytes rather than by a file name. */
export function readArtifact(
  bytes: Uint8Array,
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  if (looksLikeBson(bytes)) return artifactFromBson(bytes, library);
  return decodeArtifact(JSON.parse(new TextDecoder().decode(bytes)), library);
}
export { validateMap };
