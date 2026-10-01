/**
 * Regions (51 stage 3), a view: layout regions, the boundaries between them, the portals
 * their guarantees derive, and the region graph. Boundaries come from the kernel's
 * `boundaryRuns`, the definition of a run both levels share; at a game map's scale
 * (64,800 cells, about 300 regions) it takes 14 to 27 ms, so macro needs no finder of
 * its own. A guaranteed segment with one region on both sides lies on no boundary, and
 * so forms no portal (17 M8).
 */
import type { Cell } from "../../../kernel/cell.ts";
import { boundaryRuns } from "../../../kernel/run.ts";
import type { Run } from "../../../kernel/run.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import { hashText } from "./random.ts";
import type { Boundary, LayoutPortal, LayoutRegion, LayoutRegions, MacroStages, RegionEdge, ResolvedLayout, SegmentKey } from "./types.ts";

/** The segment `i` places along a run. */
function segmentOf(run: Run, i: number): SegmentKey {
  return run.axis === "h" ? `h:${run.x + i},${run.y}` : `v:${run.x},${run.y + i}`;
}

/** Maximal 4-connected sets of cells with one resolved class, in order of their lowest cell. */
function layoutRegions(resolved: ResolvedLayout, seed: string): LayoutRegion[] {
  const { width, height, cells } = resolved;
  const seen = new Uint8Array(cells.length);
  const regions: LayoutRegion[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] === "") continue;
    const cellClass = cells[start]!;
    const members: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!;
      members.push(cell);
      const x = cell % width, y = (cell - x) / width;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!seen[next] && cells[next] === cellClass) { seen[next] = 1; stack.push(next); }
      }
    }
    members.sort((a, b) => a - b);
    // The lowest cell, by its coordinates, is the region's identity. The seed hashes the
    // id, so the two never drift apart, and neither follows another region or the map's
    // width, as a flat index would.
    const id = `${cellClass}@${start % width},${Math.floor(start / width)}`;
    regions.push({
      id,
      seed: hashText(`region\u0000${seed}\u0000${id}`),
      class: cellClass,
      cells: members,
    });
  }
  return regions;
}

export const regions: MacroStages["regions"] = (resolved, seed) => {
  const list = layoutRegions(resolved, seed);
  const toCell = (index: number): Cell => ({ x: index % resolved.width, y: Math.floor(index / resolved.width) });
  const owners = boundaryRuns(list.map((region) => ({ id: region.id, cells: region.cells.map(toCell) })));

  const boundaries: Boundary[] = [];
  const portals: LayoutPortal[] = [];
  const graph: RegionEdge[] = [];
  for (const { a, b, runs } of owners) {
    const ids: string[] = [];
    for (const run of runs) {
      boundaries.push({ a, b, run });
      // Portals: the maximal stretches of guaranteed segments along the boundary.
      for (let i = 0; i < run.length;) {
        if (resolved.segments[segmentOf(run, i)]?.guarantee !== "guaranteed") { i++; continue; }
        const first = i;
        while (i < run.length && resolved.segments[segmentOf(run, i)]?.guarantee === "guaranteed") i++;
        const portal: LayoutPortal = run.axis === "h"
          ? { id: "", axis: "h", x: run.x + first, y: run.y, length: i - first, a, b }
          : { id: "", axis: "v", x: run.x, y: run.y + first, length: i - first, a, b };
        portal.id = `${a}~${b}~${segmentOf(portal, 0)}`;
        portals.push(portal);
        ids.push(portal.id);
      }
    }
    if (ids.length) graph.push({ a, b, portals: ids });
  }
  return { regions: list, boundaries, portals, graph };
};

/**
 * Why a layout's regions are invalid (51 stage 3): a portal a hunter can't pass through,
 * shorter than `MIN_PORTAL_LENGTH`. A portal is straight by construction, so passable
 * segments meeting at a right angle are two portals, each judged on its own.
 */
export function portalViolations(layoutRegions: LayoutRegions): string[] {
  return layoutRegions.portals.filter((portal) => portal.length < MIN_PORTAL_LENGTH).map((portal) => {
    const pairs = Array.from({ length: portal.length }, (_, i) => {
      const x = portal.axis === "h" ? portal.x + i : portal.x, y = portal.axis === "h" ? portal.y : portal.y + i;
      return portal.axis === "h" ? `${x},${y - 1}|${x},${y}` : `${x - 1},${y}|${x},${y}`;
    });
    return `portal between ${portal.a} and ${portal.b} is ${portal.length} segment${portal.length === 1 ? "" : "s"} long, `
      + `shorter than a hunter's ${MIN_PORTAL_LENGTH}, at cells ${pairs.join(" ")}`;
  });
}
