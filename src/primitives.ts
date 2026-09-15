/**
 * The cell / segment / vertex model for one tile.
 *
 * Every primitive is addressable and every one has metadata, but only what an
 * author actually states is stored. A segment with no declaration is derived
 * from the cells beside it; a vertex with no declaration defers. Interior
 * vertices carry nothing a flat map cannot derive, so they are not stored at
 * all — only perimeter vertices can be given metadata, because only they are
 * part of an adjacency contract.
 *
 * Perimeter primitives are that contract. Their deferring value is "any": it
 * carries no requirement of its own and adopts whatever the seam contract and
 * the neighbouring tile ask for. A concrete value is a requirement, and a tile
 * is only placeable where that requirement is met.
 */
import type {
  InteriorWall,
  PrimitiveOverrides,
  SegmentDeclaration,
  Side,
  Span,
  TileDesign,
  VertexDeclaration,
} from "./types.ts";

export const TILE_SIZE = 6;
export const INTERIOR_MARGIN = 0;
export const ANY_CLASS = "any";
/**
 * Filled material: what a cell's class says when nothing can stand there. Cells
 * of this class state a wall against each neighbour that is not also material,
 * and aggregate into regions like any other class.
 *
 * The name is reserved so tile validation recognises material without consulting
 * the library. Author-declared material classes are a later generalisation.
 */
export const SOLID_CLASS = "solid";
export const SIDES: Side[] = ["N", "E", "S", "W"];

export const CELL_COUNT = TILE_SIZE * TILE_SIZE; // 36
export const VERTEX_COUNT = (TILE_SIZE + 1) * (TILE_SIZE + 1); // 49
const AXIS_COUNT = (TILE_SIZE + 1) * TILE_SIZE; // 42 per axis
export const SEGMENT_COUNT = AXIS_COUNT * 2; // 84

const EPS = 1e-9;

export interface CellMeta {
  class: string;
  height: number;
}
export const isSolidClass = (name: string): boolean => name === SOLID_CLASS;
export interface VertexMeta {
  height: number | "any";
  class: string;
}
/** Cells are dense because each one genuinely differs; the rest is by exception. */
export interface TilePrimitives {
  cells: CellMeta[];
  segments: Map<number, SegmentDeclaration>;
  vertices: Map<number, VertexMeta>;
}
/** A tile frozen against a seam contract; `open` is dense because it is geometry. */
export interface ResolvedPrimitives {
  cells: CellMeta[];
  open: Span[];
  vertices: Map<number, VertexMeta>;
}
/**
 * What a seam asks of one side, once any neighbour is known. A segment entry of
 * `undefined` asks nothing: nobody has committed to that part of the seam, so
 * the tile's own declaration stands. `null` is a committed barrier, which is a
 * requirement like any other span.
 */
export interface SideContract {
  segments: Array<Span | undefined>;
  vertices: VertexMeta[];
}

export function cellAt(col: number, row: number): number {
  return row * TILE_SIZE + col;
}
export function vertexAt(vx: number, vy: number): number {
  return vy * (TILE_SIZE + 1) + vx;
}
/** Vertical segment on the line x = vx, spanning y from row to row + 1. */
export function vSeg(vx: number, row: number): number {
  return vx * TILE_SIZE + row;
}
/** Horizontal segment on the line y = vy, spanning x from col to col + 1. */
export function hSeg(vy: number, col: number): number {
  return AXIS_COUNT + vy * TILE_SIZE + col;
}
export function isVertical(segment: number): boolean {
  return segment < AXIS_COUNT;
}
/** Line coordinate and offset along it for a tile-local segment index. */
export function segmentPlace(segment: number): {
  vertical: boolean;
  line: number;
  offset: number;
} {
  const vertical = segment < AXIS_COUNT;
  const local = vertical ? segment : segment - AXIS_COUNT;
  return {
    vertical,
    line: Math.floor(local / TILE_SIZE),
    offset: local % TILE_SIZE,
  };
}
/** The i-th perimeter segment of a side, 0..5. */
export function sideSegment(side: Side, i: number): number {
  if (side === "N") return hSeg(0, i);
  if (side === "S") return hSeg(TILE_SIZE, i);
  if (side === "W") return vSeg(0, i);
  return vSeg(TILE_SIZE, i);
}
/** The i-th perimeter vertex of a side, 0..6. */
export function sideVertex(side: Side, i: number): number {
  if (side === "N") return vertexAt(i, 0);
  if (side === "S") return vertexAt(i, TILE_SIZE);
  if (side === "W") return vertexAt(0, i);
  return vertexAt(TILE_SIZE, i);
}
/** Only perimeter vertices take part in an adjacency contract. */
export function isPerimeterVertex(index: number): boolean {
  const vx = index % (TILE_SIZE + 1),
    vy = Math.floor(index / (TILE_SIZE + 1));
  return vx === 0 || vy === 0 || vx === TILE_SIZE || vy === TILE_SIZE;
}

export const OPEN: Span = [0, 1];
export const DEFERRED_VERTEX: VertexMeta = { height: "any", class: ANY_CLASS };
export function spanEquals(a: Span, b: Span): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
}
export function spanLength(span: Span): number {
  return span ? span[1] - span[0] : 0;
}
export function spanFrom(declaration: SegmentDeclaration): Span {
  if (declaration === "wall") return null;
  if (declaration === "open" || declaration === "any") return [0, 1];
  return [declaration[0], declaration[1]];
}

/**
 * What a tile says about one segment. A wall is a micro detail a tile may state
 * explicitly; anything unstated defers and settles as clear, so a path is never
 * blocked by accident.
 */
export function segmentDeclaration(
  primitives: TilePrimitives,
  index: number,
): SegmentDeclaration {
  return primitives.segments.get(index) ?? "any";
}
/** What a tile says about one vertex; anything unstated defers. */
export function vertexMeta(
  primitives: TilePrimitives,
  index: number,
): VertexMeta {
  return primitives.vertices.get(index) ?? DEFERRED_VERTEX;
}

/**
 * Does a template's declaration admit what the seam asks for? "any" admits
 * anything; a concrete declaration must match the requirement exactly.
 */
export function segmentAdmits(
  declaration: SegmentDeclaration,
  required: Span,
): boolean {
  if (declaration === "any") return true;
  return spanEquals(spanFrom(declaration), required);
}
export function vertexAdmits(
  declared: VertexMeta,
  required: VertexMeta,
): boolean {
  if (
    declared.class !== ANY_CLASS &&
    required.class !== ANY_CLASS &&
    declared.class !== required.class
  )
    return false;
  return !(
    declared.height !== "any" &&
    required.height !== "any" &&
    declared.height !== required.height
  );
}
/** Combine two declarations of the same shared primitive; "any" adopts. */
export function vertexResolve(a: VertexMeta, b: VertexMeta): VertexMeta {
  return {
    class: a.class === ANY_CLASS ? b.class : a.class,
    height: a.height === "any" ? b.height : a.height,
  };
}
function isDeferred(meta: VertexMeta): boolean {
  return meta.class === ANY_CLASS && meta.height === "any";
}

function parseSide(
  value: string | SegmentDeclaration[] | undefined,
): SegmentDeclaration[] {
  const out: SegmentDeclaration[] = new Array(TILE_SIZE).fill("any");
  if (value === undefined) return out;
  if (typeof value === "string")
    for (let i = 0; i < Math.min(TILE_SIZE, value.length); i++)
      out[i] = value[i] === "o" ? "open" : value[i] === "#" ? "wall" : "any";
  else
    for (let i = 0; i < Math.min(TILE_SIZE, value.length); i++)
      out[i] = value[i] ?? "any";
  return out;
}
function parseCorner(
  value: string | VertexDeclaration | undefined,
): VertexMeta {
  if (value === undefined || value === ".") return DEFERRED_VERTEX;
  if (typeof value === "string") return { height: "any", class: value };
  return { height: value.height ?? "any", class: value.class ?? ANY_CLASS };
}

/** Closed portions each authored wall contributes, as [vertical, line, lo, hi]. */
function wallRuns(
  walls: InteriorWall[],
): Array<[boolean, number, number, number]> {
  const runs: Array<[boolean, number, number, number]> = [];
  for (const wall of walls) {
    const vertical = wall.x1 === wall.x2;
    const line = vertical ? wall.x1 : wall.y1;
    const lo = vertical
      ? Math.min(wall.y1, wall.y2)
      : Math.min(wall.x1, wall.x2);
    const hi = vertical
      ? Math.max(wall.y1, wall.y2)
      : Math.max(wall.x1, wall.x2);
    if (!wall.gap) {
      runs.push([vertical, line, lo, hi]);
      continue;
    }
    const mid = (lo + hi) / 2;
    runs.push([vertical, line, lo, mid - wall.gap / 2]);
    runs.push([vertical, line, mid + wall.gap / 2, hi]);
  }
  return runs;
}

const primitiveCache = new WeakMap<TileDesign, Map<number, TilePrimitives>>();

/** Everything a template states, in its own frame, turned into the model. */
export function tilePrimitives(
  tile: TileDesign,
  orientation = 0,
): TilePrimitives {
  const turns = (((orientation / 90) % 4) + 4) % 4;
  let byTurn = primitiveCache.get(tile);
  if (!byTurn) {
    byTurn = new Map();
    primitiveCache.set(tile, byTurn);
  }
  const cached = byTurn.get(turns);
  if (cached) return cached;

  const legend = tile.legend ?? {};
  const rows =
    tile.cells ??
    Array.from({ length: TILE_SIZE }, () => ".".repeat(TILE_SIZE));
  const cells: CellMeta[] = [];
  for (let row = 0; row < TILE_SIZE; row++)
    for (let col = 0; col < TILE_SIZE; col++) {
      const mark = rows[row]![col]!;
      // "#" is shorthand for the reserved material class; "." takes the
      // template's default, and any other mark resolves through the legend.
      cells.push({
        class:
          mark === "#"
            ? SOLID_CLASS
            : mark === "."
              ? tile.defaultCellClass
              : (legend[mark] ?? tile.defaultCellClass),
        height: 0,
      });
    }

  applyCellOverrides(tile.primitives?.cells, cells);

  // Only stated barriers are stored. A filled cell states the walls that face
  // its unfilled neighbours; two filled cells share a clear edge, since the
  // material between them is not a surface anything can reach.
  const segments = new Map<number, SegmentDeclaration>();
  const solidAt = (col: number, row: number) =>
    col >= 0 &&
    row >= 0 &&
    col < TILE_SIZE &&
    row < TILE_SIZE &&
    isSolidClass(cells[cellAt(col, row)]!.class);
  for (let row = 0; row < TILE_SIZE; row++)
    for (let col = 0; col < TILE_SIZE; col++) {
      if (!solidAt(col, row)) continue;
      if (!solidAt(col - 1, row)) segments.set(vSeg(col, row), "wall");
      if (!solidAt(col + 1, row)) segments.set(vSeg(col + 1, row), "wall");
      if (!solidAt(col, row - 1)) segments.set(hSeg(row, col), "wall");
      if (!solidAt(col, row + 1)) segments.set(hSeg(row + 1, col), "wall");
    }
  const closed = new Map<number, Array<[number, number]>>();
  for (const [vertical, line, lo, hi] of wallRuns(tile.walls ?? [])) {
    if (hi - lo < EPS) continue;
    for (let k = Math.floor(lo + EPS); k < Math.ceil(hi - EPS); k++) {
      const index = vertical ? vSeg(line, k) : hSeg(line, k);
      const piece: [number, number] = [
        Math.max(lo, k) - k,
        Math.min(hi, k + 1) - k,
      ];
      if (!closed.has(index)) closed.set(index, []);
      closed.get(index)!.push(piece);
    }
  }
  for (const [index, pieces] of closed) {
    let lo = 0,
      hi = 1;
    for (const [a, b] of pieces) {
      if (a <= lo + EPS) lo = Math.max(lo, b);
      if (b >= hi - EPS) hi = Math.min(hi, a);
    }
    segments.set(index, hi - lo < EPS ? "wall" : [lo, hi]);
  }

  const vertices = new Map<number, VertexMeta>();
  for (const side of SIDES) {
    parseSide(tile.edges?.[side]).forEach((declaration, i) => {
      if (declaration !== "any")
        segments.set(sideSegment(side, i), declaration);
    });
    const corners = tile.corners?.[side];
    if (!corners) continue;
    for (let i = 0; i <= TILE_SIZE; i++) {
      const meta = parseCorner(corners[i]);
      if (isDeferred(meta)) continue;
      const index = sideVertex(side, i);
      vertices.set(
        index,
        vertexResolve(meta, vertexMeta({ cells, segments, vertices }, index)),
      );
    }
  }
  applyOverrides(tile.primitives, segments, vertices);

  const base: TilePrimitives = { cells, segments, vertices };
  const value = turns ? rotate(base, turns) : base;
  byTurn.set(turns, value);
  return value;
}

function applyOverrides(
  overrides: PrimitiveOverrides | undefined,
  segments: Map<number, SegmentDeclaration>,
  vertices: Map<number, VertexMeta>,
): void {
  if (!overrides) return;
  for (const [addr, value] of Object.entries(overrides.segments ?? {})) {
    const [axis, rest] = addr.split(":");
    const [line, offset] = (rest ?? "").split(",").map(Number);
    if (line === undefined || offset === undefined) continue;
    const index = axis === "v" ? vSeg(line, offset) : hSeg(line, offset);
    if (value === "any") segments.delete(index);
    else segments.set(index, value);
  }
  for (const [addr, value] of Object.entries(overrides.vertices ?? {})) {
    const [vx, vy] = addr.split(",").map(Number);
    const index = vertexAt(vx!, vy!);
    if (!isPerimeterVertex(index)) continue;
    const meta: VertexMeta = {
      height: value.height ?? "any",
      class: value.class ?? ANY_CLASS,
    };
    if (isDeferred(meta)) vertices.delete(index);
    else vertices.set(index, meta);
  }
}

function applyCellOverrides(
  overrides: PrimitiveOverrides["cells"] | undefined,
  cells: CellMeta[],
): void {
  for (const [addr, value] of Object.entries(overrides ?? {})) {
    const [col, row] = addr.split(",").map(Number);
    const cell = cells[cellAt(col!, row!)];
    if (!cell) continue;
    if (value.class !== undefined) cell.class = value.class;
    if (value.height !== undefined) cell.height = value.height;
  }
}

/** A quarter turn clockwise, in the primitive address space. */
function rotate(base: TilePrimitives, turns: number): TilePrimitives {
  let current = base;
  for (let t = 0; t < turns; t++) {
    const cells: CellMeta[] = new Array(CELL_COUNT);
    for (let row = 0; row < TILE_SIZE; row++)
      for (let col = 0; col < TILE_SIZE; col++)
        cells[cellAt(TILE_SIZE - 1 - row, col)] =
          current.cells[cellAt(col, row)]!;
    const segments = new Map<number, SegmentDeclaration>();
    for (const [index, declaration] of current.segments) {
      const { vertical, line, offset } = segmentPlace(index);
      // A vertical segment becomes horizontal and reverses its parameter; a
      // horizontal one becomes vertical and keeps its direction.
      if (vertical)
        segments.set(hSeg(line, TILE_SIZE - 1 - offset), reverse(declaration));
      else segments.set(vSeg(TILE_SIZE - line, offset), declaration);
    }
    const vertices = new Map<number, VertexMeta>();
    for (const [index, meta] of current.vertices) {
      const vx = index % (TILE_SIZE + 1),
        vy = Math.floor(index / (TILE_SIZE + 1));
      vertices.set(vertexAt(TILE_SIZE - vy, vx), meta);
    }
    current = { cells, segments, vertices };
  }
  return current;
}
function reverse(declaration: SegmentDeclaration): SegmentDeclaration {
  if (Array.isArray(declaration))
    return [1 - declaration[1], 1 - declaration[0]];
  return declaration;
}

/**
 * Freeze a tile against a known seam contract: every deferral adopts what the
 * contract asks, and interior deferrals settle as clear. Returns null when a
 * concrete declaration contradicts the contract.
 */
export function resolvePrimitives(
  primitives: TilePrimitives,
  contract: Partial<Record<Side, SideContract>>,
): ResolvedPrimitives | null {
  const open: Span[] = new Array(SEGMENT_COUNT);
  for (let index = 0; index < SEGMENT_COUNT; index++)
    open[index] = spanFrom(segmentDeclaration(primitives, index));
  const vertices = new Map(primitives.vertices);
  for (const side of SIDES) {
    const required = contract[side];
    if (!required) continue;
    for (let i = 0; i < TILE_SIZE; i++) {
      const want = required.segments[i];
      // Nothing is asked here, so nothing overrides what the tile itself says.
      if (want === undefined) continue;
      const index = sideSegment(side, i);
      if (!segmentAdmits(segmentDeclaration(primitives, index), want))
        return null;
      open[index] = want;
    }
    for (let i = 0; i <= TILE_SIZE; i++) {
      const want = required.vertices[i];
      if (!want || isDeferred(want)) continue;
      const index = sideVertex(side, i);
      const declared = vertexMeta(primitives, index);
      if (!vertexAdmits(declared, want)) return null;
      vertices.set(index, vertexResolve(declared, want));
    }
  }
  return { cells: primitives.cells, open, vertices };
}

/** The side contract a solved aperture implies, before any tile is chosen. */
export function apertureContract(width: number): Span[] {
  const start = (TILE_SIZE - width) / 2,
    end = start + width;
  return Array.from({ length: TILE_SIZE }, (_, i) => {
    const lo = Math.max(start, i),
      hi = Math.min(end, i + 1);
    return hi - lo > EPS ? ([lo - i, hi - i] as Span) : null;
  });
}
export const SEALED_CONTRACT: Span[] = new Array(TILE_SIZE).fill(null);

/**
 * The widest uninterrupted opening along a run of segments, in cells from the
 * start of the run. Passability is a property of one continuous gap: two
 * separate one-cell holes are not a two-cell door, so summing open length would
 * overstate what a body can use.
 */
export function widestOpening(spans: Array<Span | undefined>): {
  lo: number;
  hi: number;
  width: number;
} {
  let bestLo = 0,
    bestHi = 0,
    lo: number | null = null,
    hi = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (!span) {
      lo = null;
      continue;
    }
    const from = i + span[0],
      to = i + span[1];
    if (lo === null || from > hi + EPS) {
      lo = from;
      hi = to;
    } else hi = Math.max(hi, to);
    if (hi - lo > bestHi - bestLo) {
      bestLo = lo;
      bestHi = hi;
    }
  }
  return { lo: bestLo, hi: bestHi, width: bestHi - bestLo };
}

/** Barrier geometry for a resolved tile, merged into runs, in tile-local cells. */
export function wallsFrom(resolved: ResolvedPrimitives): InteriorWall[] {
  const pieces: InteriorWall[] = [];
  for (let index = 0; index < SEGMENT_COUNT; index++) {
    const span = resolved.open[index]!;
    if (span && span[0] <= EPS && span[1] >= 1 - EPS) continue;
    const { vertical, line, offset } = segmentPlace(index);
    const closed: Array<[number, number]> = span
      ? [
          [offset, offset + span[0]],
          [offset + span[1], offset + 1],
        ]
      : [[offset, offset + 1]];
    for (const [lo, hi] of closed) {
      if (hi - lo < EPS) continue;
      pieces.push(
        vertical
          ? { x1: line, y1: lo, x2: line, y2: hi }
          : { x1: lo, y1: line, x2: hi, y2: line },
      );
    }
  }
  return mergeRuns(pieces);
}

export function mergeRuns(walls: InteriorWall[]): InteriorWall[] {
  const out: InteriorWall[] = [];
  for (const vertical of [true, false]) {
    const lines = new Map<number, Array<[number, number]>>();
    for (const w of walls) {
      if ((w.x1 === w.x2) !== vertical) continue;
      const line = vertical ? w.x1 : w.y1;
      const lo = vertical ? Math.min(w.y1, w.y2) : Math.min(w.x1, w.x2);
      const hi = vertical ? Math.max(w.y1, w.y2) : Math.max(w.x1, w.x2);
      const spans = lines.get(line) ?? [];
      spans.push([lo, hi]);
      lines.set(line, spans);
    }
    for (const [line, spans] of [...lines].sort((a, b) => a[0] - b[0])) {
      spans.sort((a, b) => a[0] - b[0]);
      const emit = (lo: number, hi: number) =>
        out.push(
          vertical
            ? { x1: line, y1: lo, x2: line, y2: hi }
            : { x1: lo, y1: line, x2: hi, y2: line },
        );
      let [lo, hi] = spans[0]!;
      for (const [a, b] of spans.slice(1)) {
        if (lo === undefined || hi === undefined) break;
        if (a <= hi + EPS) hi = Math.max(hi, b);
        else {
          emit(lo, hi);
          [lo, hi] = [a, b];
        }
      }
      emit(lo, hi);
    }
  }
  return out;
}
