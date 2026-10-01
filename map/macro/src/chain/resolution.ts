/**
 * Resolution (51 stage 2), a view: what the solved placement means. Every `any` cell is
 * settled, and each segment a side states passability on gets its guarantee, with what
 * each side stated kept as provenance. Nothing is decided here, so nothing is saved.
 */
import { adjacencyAsks, declaredGrid, segmentCells } from "./declared-grid.ts";
import type { DeclaredSegment, MacroStages, ResolvedSegment, SegmentKey, StatedPassability } from "./types.ts";

/** What an `any` cell resolves to when no adjacency prescription asks it for a class. */
export const DEFAULT_RESOLVED_CLASS = "open";

export const resolution: MacroStages["resolution"] = (layout, library) => {
  const grid = declaredGrid(layout, library);
  // Placement keeps an `any` cell to one asked class (`layoutViolations`); a second one
  // means the layout isn't placement's.
  const asked = new Map<number, string>();
  for (const { required, across } of adjacencyAsks(grid)) {
    if (grid.cells[across] !== "any") continue;
    const previous = asked.get(across);
    if (previous !== undefined && previous !== required)
      throw new Error(`any cell ${across % grid.width},${Math.floor(across / grid.width)} is asked for ${previous} and ${required}`);
    asked.set(across, required);
  }
  const cells = grid.cells.map((declared, i) => declared === "any" ? asked.get(i) ?? DEFAULT_RESOLVED_CLASS : declared);

  const segments: Partial<Record<SegmentKey, ResolvedSegment>> = {};
  for (const [key, sides] of Object.entries(grid.segments) as [SegmentKey, DeclaredSegment][]) {
    if (sides.lower?.passability === undefined && sides.upper?.passability === undefined) continue;
    const [lower, upper] = segmentCells(grid, key);
    const stated = (cell: number | undefined, passability: StatedPassability | undefined): StatedPassability =>
      cell === undefined ? null : passability ?? "unstated";
    // A segment facing the map's outside has nothing across it, so it is never guaranteed.
    const across = lower !== undefined && upper !== undefined;
    const passable = sides.lower?.passability === "passable" || sides.upper?.passability === "passable";
    segments[key] = {
      guarantee: across && passable ? "guaranteed" : "none",
      stated: [stated(lower, sides.lower?.passability), stated(upper, sides.upper?.passability)],
    };
  }
  return { width: grid.width, height: grid.height, cells, segments };
};
