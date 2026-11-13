/**
 * Resolution (51 stage 2), a view: what the solved placement means. Every `any` cell is
 * settled, and each segment a side states passability on gets its guarantee, with what
 * each side stated kept as provenance. Nothing is decided here, so nothing is saved.
 */
import { adjacencyAsks, cellAt, declaredGrid, segmentCells } from "./declared-grid.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import type { PassabilityPrescription } from "./library.ts";
import type { DeclaredSegment, MacroStages, ResolvedSegment, SegmentKey, StatedPassability } from "./types.ts";

/** What an `any` cell resolves to when no adjacency prescription asks it for a class. */
export const DEFAULT_RESOLVED_CLASS = "open";

/** A declared class stands; an `any` cell waits only while no placed neighbour asks it. */
export function resolveSettledClass(declared: string, asked: string | undefined, waiting: boolean): string | undefined {
  return declared === "any" ? asked ?? (waiting ? undefined : DEFAULT_RESOLVED_CLASS) : declared;
}

/**
 * Derived crossing promise for two cells on the map; hints never require a barrier. An
 * unstated side reads as `any`, and `any` meeting `any` passes only between two regions
 * (17.2.2): pass `sameClass` when both cells resolve to one class, and so lie in one region
 * (51.5). Placement refuses `passable` against a hint there (`passabilityFits`).
 */
export function guaranteesPassability(lower: PassabilityPrescription | undefined,
  upper: PassabilityPrescription | undefined, sameClass = false): boolean {
  const l = lower ?? "any", u = upper ?? "any";
  return l === "passable" || u === "passable" || (l === "any" && u === "any" && !sameClass);
}

/** Whether two sides of one segment may meet: `any` fits anything, otherwise like with like. */
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

  const stated = (cell: number | undefined, prescription: PassabilityPrescription | undefined): StatedPassability =>
    cell === undefined ? null : prescription ?? "unstated";

  // Segment guarantees: what each side stated, and the promise between them.
  const segments: Record<SegmentKey, ResolvedSegment> = {};
  for (const [key, sides] of Object.entries(grid.segments) as [SegmentKey, DeclaredSegment][]) {
    const [lower, upper] = segmentCells(grid, key);
    const across = lower !== undefined && upper !== undefined;
    if (across && !passabilityFits(sides.lower?.passability, sides.upper?.passability))
      throw new Error(`segment ${key} states ${sides.lower?.passability} against ${sides.upper?.passability}, which placement refuses`);
    const passable = guaranteesPassability(sides.lower?.passability, sides.upper?.passability,
      across && cells[lower] === cells[upper]);
    segments[key] = {
      guarantee: across && passable ? "guaranteed" : "none",
      stated: [stated(lower, sides.lower?.passability), stated(upper, sides.upper?.passability)],
    };
  }

  // A segment neither side states passability on reads as `any` meeting `any`: it passes
  // between two regions (17.2.2), so every class boundary not listed yet is guaranteed.
  // Inside one region it stays unstated, and absent.
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

  // Runs lie along one segment line: `h:p,line` between (p, line - 1) and (p, line), and
  // `v:line,p` between (line - 1, p) and (line, p). A run is one pair of classes, guaranteed throughout.
  for (const axis of ["h", "v"] as const) {
    const lines = axis === "h" ? grid.height : grid.width, span = axis === "h" ? grid.width : grid.height;
    /** The segment at position `p` on `line`, and the cells before and after it across the line. */
    const at = (line: number, p: number): [SegmentKey, number | undefined, number | undefined] => axis === "h"
      ? [`h:${p},${line}`, cellAt(grid, p, line - 1), cellAt(grid, p, line)]
      : [`v:${line},${p}`, cellAt(grid, line - 1, p), cellAt(grid, line, p)];
    for (let line = 0; line <= lines; line++) {
      for (let p = 0; p < span;) {
        const [key, before, after] = at(line, p);
        p++;
        if (segments[key]?.guarantee !== "guaranteed" || before === undefined || after === undefined) continue;
        const beforeClass = cells[before], afterClass = cells[after];
        if (beforeClass === afterClass) continue;
        const run = [key];
        let hasAuthored = isAuthoredPassable(key);
        for (; p < span; p++) {
          const [nextKey, nextBefore, nextAfter] = at(line, p);
          if (segments[nextKey]?.guarantee !== "guaranteed") break;
          if (nextBefore === undefined || nextAfter === undefined) break;
          if (cells[nextBefore] !== beforeClass || cells[nextAfter] !== afterClass) break;
          if (isAuthoredPassable(nextKey)) hasAuthored = true;
          run.push(nextKey);
        }
        if (run.length < MIN_PORTAL_LENGTH && !hasAuthored) for (const k of run) segments[k]!.guarantee = "none";
      }
    }
  }

  return { width: grid.width, height: grid.height, cells, segments };
};
