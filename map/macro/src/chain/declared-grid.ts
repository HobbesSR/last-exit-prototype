/**
 * The `DeclaredGrid` view (51 stage 1): the Layout plus the library gives each cell's
 * declared class, and each segment's prescriptions from the design on each side, kept
 * separate, never merged. It also checks placement's validity over that view.
 */
import { ZONE_COLUMNS, ZONE_ROWS } from "../core.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary, ChainTileDesign, SegmentPrescription } from "./library.ts";
import type { DeclaredGrid, DeclaredSegment, MacroStages, Orientation, SegmentKey } from "./types.ts";

const S = CHAIN_TILE_SIZE;

/** A design turned to one orientation, in tile-local cells and kernel segment keys. */
export interface OrientedDesign {
  /** Declared class per local cell, `y * 6 + x`. */
  cells: string[];
  /** Only stated prescriptions, keyed in run coordinates (`h:x,y` on line `y`). */
  segments: Map<SegmentKey, SegmentPrescription>;
}

/** The library writes `h:y,x` (line first); the kernel writes `h:x,y`. `v` keys agree. */
function kernelKey(libraryKey: string): SegmentKey {
  const [axis, rest] = libraryKey.split(":") as ["h" | "v", string];
  const [line, offset] = rest.split(",");
  return axis === "v" ? `v:${line},${offset}` as SegmentKey : `h:${offset},${line}` as SegmentKey;
}

function parseKey(key: SegmentKey): { axis: "h" | "v"; x: number; y: number } {
  const [axis, rest] = key.split(":") as ["h" | "v", string];
  const [x, y] = rest.split(",").map(Number) as [number, number];
  return { axis, x, y };
}

/** A quarter turn clockwise, the old path's convention (`primitives.ts`): cell (x, y) goes to (5 - y, x). */
function turn(design: OrientedDesign): OrientedDesign {
  const cells = new Array<string>(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) cells[x * S + (S - 1 - y)] = design.cells[y * S + x]!;
  const segments = new Map<SegmentKey, SegmentPrescription>();
  for (const [key, prescription] of design.segments) {
    const { axis, x, y } = parseKey(key);
    // A vertical segment on line x, row y becomes horizontal on line x, column 5 - y;
    // a horizontal one on line y, column x becomes vertical on line 6 - y, row x.
    segments.set(axis === "v" ? `h:${S - 1 - y},${x}` : `v:${S - y},${x}`, prescription);
  }
  return { cells, segments };
}

const stated = (prescription: SegmentPrescription): boolean =>
  prescription.adjacency !== undefined || prescription.passability !== undefined;

export function orientDesign(design: ChainTileDesign, orientation: Orientation): OrientedDesign {
  const cells: string[] = [];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const mark = design.cells?.[y]?.[x] ?? ".";
    cells.push(mark === "." ? design.defaultCellClass : design.legend![mark]!);
  }
  const segments = new Map<SegmentKey, SegmentPrescription>();
  for (const [key, prescription] of Object.entries(design.segments ?? {}))
    if (stated(prescription)) segments.set(kernelKey(key), prescription);
  let oriented: OrientedDesign = { cells, segments };
  for (let t = 0; t < orientation / 90; t++) oriented = turn(oriented);
  return oriented;
}

/** Oriented designs by `id@orientation`, built on first use. */
export function orientedDesigns(library: ChainLibrary): (id: string, orientation: Orientation) => OrientedDesign {
  const designs = new Map(library.tiles.map((tile) => [tile.id, tile]));
  const cache = new Map<string, OrientedDesign>();
  return (id, orientation) => {
    const key = `${id}@${orientation}`;
    let oriented = cache.get(key);
    if (!oriented) {
      const design = designs.get(id);
      if (!design) throw new Error(`layout names unknown design ${id}`);
      cache.set(key, oriented = orientDesign(design, orientation));
    }
    return oriented;
  };
}

export const declaredGrid: MacroStages["declaredGrid"] = (layout, library) => {
  const width = ZONE_COLUMNS * layout.params.zoneWidth * S, height = ZONE_ROWS * layout.params.zoneHeight * S;
  const cells = new Array<string>(width * height).fill("");
  const segments: Partial<Record<SegmentKey, DeclaredSegment>> = {};
  const oriented = orientedDesigns(library);
  for (const slot of layout.slots) {
    const design = oriented(slot.design, slot.orientation);
    const ox = slot.col * S, oy = slot.row * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++)
      cells[(oy + y) * width + ox + x] = design.cells[y * S + x]!;
    for (const [key, prescription] of design.segments) {
      const { axis, x, y } = parseKey(key);
      const line = axis === "v" ? x : y;
      const global: SegmentKey = `${axis}:${ox + x},${oy + y}`;
      const entry = segments[global] ??= {};
      // On the tile's near edge the design owns the upper cell, on its far edge the
      // lower one, and inside the tile both.
      if (line !== 0) entry.lower = prescription;
      if (line !== S) entry.upper = prescription;
    }
  }
  return { width, height, cells, segments };
};

/**
 * Why a declared grid is invalid (51 stage 1): an adjacency prescription the cell across
 * doesn't meet, or an `any` cell asked for two different classes. A prescription facing
 * the map's outside has no cell to constrain, so it is met.
 */
export function layoutViolations(grid: DeclaredGrid): string[] {
  const violations: string[] = [];
  const asked = new Map<number, Set<string>>();
  const cellAt = (x: number, y: number): number | undefined =>
    x < 0 || y < 0 || x >= grid.width || y >= grid.height || grid.cells[y * grid.width + x] === ""
      ? undefined : y * grid.width + x;
  for (const [key, sides] of Object.entries(grid.segments) as [SegmentKey, DeclaredSegment][]) {
    const { axis, x, y } = parseKey(key);
    const lower = axis === "v" ? cellAt(x - 1, y) : cellAt(x, y - 1);
    const upper = cellAt(x, y);
    for (const [prescription, across] of [[sides.lower, upper], [sides.upper, lower]] as const) {
      const required = prescription?.adjacency;
      if (required === undefined || required === "any" || across === undefined) continue;
      const found = grid.cells[across]!;
      if (found === "any") {
        let classes = asked.get(across);
        if (!classes) asked.set(across, classes = new Set());
        classes.add(required);
      } else if (found !== required) violations.push(`${key} requires ${required} across, found ${found}`);
    }
  }
  for (const [cell, classes] of asked) if (classes.size > 1)
    violations.push(`any cell ${cell % grid.width},${Math.floor(cell / grid.width)} is asked for ${[...classes].sort().join(" and ")}`);
  return violations;
}
