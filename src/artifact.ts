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
 * The same form serializes to JSON, where typed arrays become plain number
 * arrays, and to BSON, where they stay binary.
 */
import {
  ZONE_COLUMNS,
  deriveEdges,
  deriveWalls,
  makeZones,
  validateMap,
} from "./core.ts";
import { decodeBson, encodeBson, looksLikeBson } from "./bson.ts";
import type { BsonValue } from "./bson.ts";
import type {
  GeneratedMap,
  MapEdge,
  MapFeature,
  MapParams,
  MapRegion,
  PlacedTile,
  PortKind,
  Span,
  ValidationResult,
  Wall,
} from "./types.ts";

export const WIRE_VERSION = 1;
/** Out-of-range marker for a fully closed segment. */
const BARRIER = -1;

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
export interface WireArtifact {
  format: "last-exit-map";
  wire: number;
  version: number;
  seed: string;
  params: MapParams;
  width: number;
  height: number;
  strings: string[];
  tiles: {
    count: number;
    col: PackedInts;
    row: PackedInts;
    template: PackedInts;
    orientation: PackedInts;
    layout: PackedInts;
    anchor: PackedInts;
  };
  features: Array<Record<string, BsonValue>>;
  grid: {
    width: number;
    height: number;
    cells: {
      class: WireGrid;
      level?: WireGrid;
      spawns: { cell: PackedInts; kind: PackedInts };
    };
    segments: { open: WireGrid };
    vertices: Array<Record<string, BsonValue>>;
  };
  regions: {
    count: number;
    class: PackedInts;
    seed: PackedInts;
    cellOffsets: PackedInts;
    cells: PackedInts;
    obstacleOffsets: PackedInts;
    obstacles: Packed;
    generator: PackedInts;
    spawnsPlaced: PackedInts;
    obstaclesPlaced: PackedInts;
    corridorsHonored: PackedInts;
  };
  metrics: Record<string, number>;
  validation: ValidationResult;
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

export function encodeArtifact(map: GeneratedMap): WireArtifact {
  const strings = new Strings();
  const tileIndex = new Map(map.tiles.map((t, i) => [t.id, i]));

  const tiles = {
    count: map.tiles.length,
    col: packInts(map.tiles.map((t) => t.col)),
    row: packInts(map.tiles.map((t) => t.row)),
    template: packInts(map.tiles.map((t) => strings.id(t.templateId))),
    orientation: packInts(map.tiles.map((t) => t.orientation)),
    layout: packInts(map.tiles.map((t) => strings.optional(t.layoutId))),
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
    if (f.layoutId !== undefined) doc.layout = strings.id(f.layoutId);
    if (f.tileIds)
      doc.tiles = packInts(
        f.tileIds.map((id) => tileIndex.get(id) ?? -1),
      ) as unknown as BsonValue;
    return doc;
  });

  const classGrid = map.grid.cells.class;
  const cells = {
    class: {
      palette: packInts(classGrid.palette.map((name) => strings.id(name))),
      runs: packInts(classGrid.runs),
      count: classGrid.count,
    },
    ...(map.grid.cells.level
      ? {
          level: {
            palette: Float64Array.from(map.grid.cells.level.palette),
            runs: packInts(map.grid.cells.level.runs),
            count: map.grid.cells.level.count,
          },
        }
      : {}),
    spawns: {
      cell: packInts(map.grid.cells.spawns.map((s) => s.cell)),
      kind: packInts(map.grid.cells.spawns.map((s) => strings.id(s.kind))),
    },
  };
  // A span is two numbers in 0..1; a barrier is the out-of-range pair -1, -1.
  // A sentinel rather than NaN, because JSON cannot carry NaN.
  const spanPalette = new Float64Array(
    map.grid.segments.open.palette.length * 2,
  );
  map.grid.segments.open.palette.forEach((span, i) => {
    spanPalette[i * 2] = span ? span[0] : BARRIER;
    spanPalette[i * 2 + 1] = span ? span[1] : BARRIER;
  });
  // Vertices are few and their fields optional, so they stay small documents.
  const vertices = map.grid.vertices.map((v) => {
    const doc: Record<string, BsonValue> = { vertex: v.vertex };
    if (v.class !== undefined) doc.class = strings.id(v.class);
    if (v.height !== undefined) doc.height = v.height;
    return doc;
  });

  const cellOffsets = new Int32Array(map.regions.length + 1);
  const obstacleOffsets = new Int32Array(map.regions.length + 1);
  map.regions.forEach((r, i) => {
    cellOffsets[i + 1] = cellOffsets[i]! + r.cells.length;
    obstacleOffsets[i + 1] = obstacleOffsets[i]! + r.obstacles.length;
  });
  const regionCells = new Int32Array(cellOffsets[map.regions.length]!);
  const regionObstacles = new Float64Array(
    obstacleOffsets[map.regions.length]! * 4,
  );
  map.regions.forEach((r, i) => {
    regionCells.set(r.cells, cellOffsets[i]!);
    regionObstacles.set(packWalls(r.obstacles), obstacleOffsets[i]! * 4);
  });

  return {
    format: "last-exit-map",
    wire: WIRE_VERSION,
    version: map.version,
    seed: map.seed,
    params: map.params,
    width: map.width,
    height: map.height,
    strings: strings.table,
    tiles,
    features,
    grid: {
      width: map.grid.width,
      height: map.grid.height,
      cells,
      segments: {
        open: {
          palette: spanPalette,
          runs: packInts(map.grid.segments.open.runs),
          count: map.grid.segments.open.count,
        },
      },
      vertices,
    },
    regions: {
      count: map.regions.length,
      class: packInts(map.regions.map((r) => strings.id(r.cellClass))),
      // Seeds are 32-bit hashes, so they ride in an int32 lane unchanged.
      seed: packInts(map.regions.map((r) => r.seed | 0)),
      cellOffsets: packInts(cellOffsets),
      cells: packInts(regionCells),
      obstacleOffsets: packInts(obstacleOffsets),
      obstacles: regionObstacles,
      generator: packInts(
        map.regions.map((r) => strings.optional(r.manifest.generator)),
      ),
      spawnsPlaced: packInts(map.regions.map((r) => r.manifest.spawnsPlaced)),
      obstaclesPlaced: packInts(
        map.regions.map((r) => r.manifest.obstaclesPlaced),
      ),
      corridorsHonored: packInts(
        map.regions.map((r) => (r.manifest.corridorsHonored ? 1 : 0)),
      ),
    },
    metrics: map.metrics as Record<string, number>,
    validation: map.validation,
  };
}

/** A tile's zone follows from its grid position and the zone dimensions. */
function zoneIdAt(col: number, row: number, params: MapParams): string {
  return `z-${Math.floor(col / params.zoneWidth)}-${Math.floor(row / params.zoneHeight)}`;
}

export function decodeArtifact(input: unknown): GeneratedMap {
  const wire = input as WireArtifact;
  if (
    !wire ||
    wire.format !== "last-exit-map" ||
    !Array.isArray(wire.strings) ||
    !wire.params
  )
    throw new Error("not a last-exit-map artifact");
  if (wire.wire !== WIRE_VERSION)
    throw new Error(`unsupported wire version ${wire.wire}`);
  const names = wire.strings;
  const name = (id: number): string => {
    const value = names[id];
    if (value === undefined)
      throw new Error(`string ${id} is not in the table`);
    return value;
  };
  const params = wire.params as MapParams;
  const size = params.tileSize;

  const t = wire.tiles;
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
    if (layout[i]! >= 0) tile.layoutId = name(layout[i]!);
    tiles.push(tile);
  }

  const features: MapFeature[] = wire.features.map((doc) => {
    const f = doc as Record<string, number | Packed>;
    const feature: MapFeature = {
      id: name(f.id as number),
      kind: name(f.kind as number) as MapFeature["kind"],
      tileId: tiles[f.tile as number]!.id,
      x: f.x as number,
      y: f.y as number,
    };
    if (f.layout !== undefined) feature.layoutId = name(f.layout as number);
    if (f.tiles !== undefined)
      feature.tileIds = [...unpackInts(f.tiles as unknown as PackedInts)].map(
        (i) => tiles[i]!.id,
      );
    return feature;
  });

  const gc = wire.grid.cells;
  const spanPalette = asFloat64(wire.grid.segments.open.palette);
  const spans: Span[] = [];
  for (let i = 0; i + 1 < spanPalette.length; i += 2)
    spans.push(
      spanPalette[i]! < 0 ? null : [spanPalette[i]!, spanPalette[i + 1]!],
    );
  const spawnCells = unpackInts(gc.spawns.cell),
    spawnKinds = unpackInts(gc.spawns.kind);

  const grid: GeneratedMap["grid"] = {
    width: wire.grid.width,
    height: wire.grid.height,
    cells: {
      class: {
        palette: [...unpackInts(gc.class.palette as PackedInts)].map(name),
        runs: [...unpackInts(gc.class.runs)],
        count: gc.class.count,
      },
      ...(gc.level
        ? {
            level: {
              palette: [...asFloat64(gc.level.palette)],
              runs: [...unpackInts(gc.level.runs)],
              count: gc.level.count,
            },
          }
        : {}),
      spawns: [...spawnCells].map((cell, i) => ({
        cell,
        kind: name(spawnKinds[i]!),
      })),
    },
    segments: {
      open: {
        palette: spans,
        runs: [...unpackInts(wire.grid.segments.open.runs)],
        count: wire.grid.segments.open.count,
      },
    },
    vertices: wire.grid.vertices.map((doc) => {
      const v = doc as Record<string, number>;
      const entry: { vertex: number; class?: string; height?: number } = {
        vertex: v.vertex!,
      };
      if (v.class !== undefined) entry.class = name(v.class);
      if (v.height !== undefined) entry.height = v.height;
      return entry;
    }),
  };

  const r = wire.regions;
  const rclass = unpackInts(r.class),
    rseed = unpackInts(r.seed),
    cellOffsets = unpackInts(r.cellOffsets),
    regionCells = unpackInts(r.cells),
    obstacleOffsets = unpackInts(r.obstacleOffsets),
    regionObstacles = asFloat64(r.obstacles),
    generator = unpackInts(r.generator),
    spawnsPlaced = unpackInts(r.spawnsPlaced),
    obstaclesPlaced = unpackInts(r.obstaclesPlaced),
    corridors = unpackInts(r.corridorsHonored);
  const regions: MapRegion[] = [];
  for (let i = 0; i < r.count; i++) {
    const cells = [
      ...regionCells.subarray(cellOffsets[i]!, cellOffsets[i + 1]!),
    ];
    const obstacles = unpackWalls(
      regionObstacles.subarray(
        obstacleOffsets[i]! * 4,
        obstacleOffsets[i + 1]! * 4,
      ),
    );
    const manifest: MapRegion["manifest"] = {
      spawnsPlaced: spawnsPlaced[i]!,
      obstaclesPlaced: obstaclesPlaced[i]!,
      corridorsHonored: corridors[i] === 1,
    };
    if (generator[i]! >= 0) manifest.generator = name(generator[i]!);
    regions.push({
      id: `r-${i}`,
      cellClass: name(rclass[i]!),
      area: cells.length,
      cells,
      seed: rseed[i]! >>> 0,
      obstacles,
      manifest,
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
    metrics: wire.metrics as GeneratedMap["metrics"],
    validation: wire.validation,
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
export function artifactFromBson(bytes: Uint8Array): GeneratedMap {
  return decodeArtifact(decodeBson(bytes));
}
/** Read either encoding, decided by the bytes rather than by a file name. */
export function readArtifact(bytes: Uint8Array): GeneratedMap {
  if (looksLikeBson(bytes)) return artifactFromBson(bytes);
  return decodeArtifact(JSON.parse(new TextDecoder().decode(bytes)));
}
export { validateMap };
