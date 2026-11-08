/**
 * Resolution (51 stage 2), a view: what the solved placement means. Every `any` cell is
 * settled, and each segment a side states passability on gets its guarantee, with what
 * each side stated kept as provenance. Nothing is decided here, so nothing is saved.
 */
import { adjacencyAsks, cellAt, declaredGrid, segmentCells } from "./declared-grid.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import type { PassabilityPrescription, PassabilityRules } from "./library.ts";
import type { DeclaredSegment, MacroStages, ResolvedSegment, SegmentKey, StatedPassability } from "./types.ts";

/** What an `any` cell resolves to when no adjacency prescription asks it for a class. */
export const DEFAULT_RESOLVED_CLASS = "open";

/** A declared class stands; an `any` cell waits only while no placed neighbour asks it. */
export function resolveSettledClass(declared: string, asked: string | undefined, waiting: boolean): string | undefined {
  return declared === "any" ? asked ?? (waiting ? undefined : DEFAULT_RESOLVED_CLASS) : declared;
}

/**
 * Derived crossing promise for two cells on the map; hints never require a barrier. Under
 * `matched` (17.2.2) an unstated side reads as `any`, and `any` meeting `any` passes only
 * between two regions: pass `sameClass` when both cells resolve to one class, and so lie in
 * one region (51.5). Placement refuses `passable` against a hint there (`passabilityFits`).
 */
export function guaranteesPassability(lower: PassabilityPrescription | undefined,
  upper: PassabilityPrescription | undefined, rules: PassabilityRules = "either-side", sameClass = false): boolean {
  if (rules === "either-side") return lower === "passable" || upper === "passable" || (lower === "any" && upper === "any");
  const l = lower ?? "any", u = upper ?? "any";
  return l === "passable" || u === "passable" || (l === "any" && u === "any" && !sameClass);
}

/** Under `matched`, whether two sides of one segment may meet: `any` fits anything, otherwise like with like. */
export function passabilityFits(lower: PassabilityPrescription | undefined, upper: PassabilityPrescription | undefined): boolean {
  const l = lower ?? "any", u = upper ?? "any";
  return l === "any" || u === "any" || l === u;
}

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

  const rules = library.passabilityRules ?? "either-side";

  const stated = (cell: number | undefined, prescription: PassabilityPrescription | undefined): StatedPassability =>
    cell === undefined ? null : prescription ?? "unstated";

  // Segment guarantees: what each side stated, and the promise between them.
  const segments: Record<SegmentKey, ResolvedSegment> = {};
  for (const [key, sides] of Object.entries(grid.segments) as [SegmentKey, DeclaredSegment][]) {
    const [lower, upper] = segmentCells(grid, key);
    const across = lower !== undefined && upper !== undefined;
    if (across && rules === "matched" && !passabilityFits(sides.lower?.passability, sides.upper?.passability))
      throw new Error(`segment ${key} states ${sides.lower?.passability} against ${sides.upper?.passability}, which placement refuses`);
    const passable = guaranteesPassability(sides.lower?.passability, sides.upper?.passability, rules,
      across && cells[lower] === cells[upper]);
    segments[key] = {
      guarantee: across && passable ? "guaranteed" : "none",
      stated: [stated(lower, sides.lower?.passability), stated(upper, sides.upper?.passability)],
    };
  }

  // Under `matched`, a segment neither side states passability on reads as `any` meeting
  // `any`: it passes between two regions (17.2.2), so every class boundary not listed yet is
  // guaranteed. Inside one region it stays unstated, and absent.
  if (rules === "matched") {
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
      const here = cellAt(grid, x, y);
      if (here === undefined) continue;
      const beside: [SegmentKey, number | undefined][] = [[`v:${x + 1},${y}`, cellAt(grid, x + 1, y)], [`h:${x},${y + 1}`, cellAt(grid, x, y + 1)]];
      for (const [key, there] of beside) {
        if (there === undefined || cells[here] === cells[there] || segments[key]) continue;
        segments[key] = { guarantee: "guaranteed", stated: ["unstated", "unstated"] };
      }
    }

    // Demote emergent guaranteed runs shorter than MIN_PORTAL_LENGTH to "none" (#893).
    // A run is emergent if neither side explicitly stated "passable".
    const isAuthoredPassable = (key: SegmentKey): boolean => {
      const s = grid.segments[key];
      return s?.lower?.passability === "passable" || s?.upper?.passability === "passable";
    };

    // Horizontal runs: h:x,y between (x, y - 1) and (x, y)
    for (let y = 0; y <= grid.height; y++) {
      for (let x = 0; x < grid.width;) {
        const key: SegmentKey = `h:${x},${y}`;
        if (segments[key]?.guarantee !== "guaranteed") { x++; continue; }
        const topCell = cellAt(grid, x, y - 1), bottomCell = cellAt(grid, x, y);
        if (topCell === undefined || bottomCell === undefined) { x++; continue; }
        const topClass = cells[topCell], bottomClass = cells[bottomCell];
        if (topClass === bottomClass) { x++; continue; }
        const startX = x;
        let hasAuthored = isAuthoredPassable(key);
        x++;
        while (x < grid.width) {
          const nextKey: SegmentKey = `h:${x},${y}`;
          if (segments[nextKey]?.guarantee !== "guaranteed") break;
          const nextTop = cellAt(grid, x, y - 1), nextBottom = cellAt(grid, x, y);
          if (nextTop === undefined || nextBottom === undefined) break;
          if (cells[nextTop] !== topClass || cells[nextBottom] !== bottomClass) break;
          if (isAuthoredPassable(nextKey)) hasAuthored = true;
          x++;
        }
        const length = x - startX;
        if (length < MIN_PORTAL_LENGTH && !hasAuthored) {
          for (let k = startX; k < x; k++) segments[`h:${k},${y}`]!.guarantee = "none";
        }
      }
    }

    // Vertical runs: v:x,y between (x - 1, y) and (x, y)
    for (let x = 0; x <= grid.width; x++) {
      for (let y = 0; y < grid.height;) {
        const key: SegmentKey = `v:${x},${y}`;
        if (segments[key]?.guarantee !== "guaranteed") { y++; continue; }
        const leftCell = cellAt(grid, x - 1, y), rightCell = cellAt(grid, x, y);
        if (leftCell === undefined || rightCell === undefined) { y++; continue; }
        const leftClass = cells[leftCell], rightClass = cells[rightCell];
        if (leftClass === rightClass) { y++; continue; }
        const startY = y;
        let hasAuthored = isAuthoredPassable(key);
        y++;
        while (y < grid.height) {
          const nextKey: SegmentKey = `v:${x},${y}`;
          if (segments[nextKey]?.guarantee !== "guaranteed") break;
          const nextLeft = cellAt(grid, x - 1, y), nextRight = cellAt(grid, x, y);
          if (nextLeft === undefined || nextRight === undefined) break;
          if (cells[nextLeft] !== leftClass || cells[nextRight] !== rightClass) break;
          if (isAuthoredPassable(nextKey)) hasAuthored = true;
          y++;
        }
        const length = y - startY;
        if (length < MIN_PORTAL_LENGTH && !hasAuthored) {
          for (let k = startY; k < y; k++) segments[`v:${x},${k}`]!.guarantee = "none";
        }
      }
    }
  }

  return { width: grid.width, height: grid.height, cells, segments };
};
