/**
 * Briefs (51 stage 5), a view: one `RegionBrief` per layout region, in the macro/micro
 * contract (`map/kernel/contract.ts`). It carries the region's type and parameters from
 * its class rule, its cells in global cell coordinates, the zone context they lie in, the
 * core elements the class rule lists, original portals, and automatic clear/fill constraints. It also
 * carries the perimeter stretches the library hints should be occupied (52), which are
 * guidance and never an obligation. A brief never mentions another region's contents. A portal is its run and its id; the id names
 * the two regions it joins (step 5), so both sides' briefs name a shared portal alike, and
 * nothing else about the region across is passed.
 */
import type { Cell } from "../../../kernel/cell.ts";
import type { CoreElementKind, Portal, RegionBrief, ZoneContext } from "../../../kernel/contract.ts";
import type { Run } from "../../../kernel/run.ts";
import { applyClearConstraints, clearFootprint } from "../../../kernel/margins.ts";
import { isCellSize } from "../../../kernel/scale.ts";
import { gridSize } from "./declared-grid.ts";
import { countParamsProblem, resolveCount } from "./library.ts";
import type { ChainParams, LayoutPortal, MacroStages, ResolvedLayout, SegmentKey, Zone } from "./types.ts";
import { makeZones } from "./zones.ts";

/** The tier zones a layout's params give (`makeZones`), in cell units. */
export function chainZones(params: ChainParams): Zone[] {
  return makeZones(params).map(({ id, tier, bonus, lootChance, cells: [x0, y0, x1, y1] }) =>
    ({ id, tier, bonus, lootChance, cells: { x0, y0, x1, y1 } }));
}

/** A layout portal as a brief carries it: its run and id, without the regions on each side. */
const briefPortal = ({ id, axis, x, y, length }: LayoutPortal): Portal => ({ id, axis, x, y, length });

const SIDES = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

/**
 * A region's hinted perimeter as maximal runs (52). A perimeter segment is hinted when a
 * side states `not-passable-hint` and the pair of sides guarantees no passage. A run ends
 * where the owner across changes, as `boundaryRuns` ends one, or where the region
 * passes to the other side of the line (a concave region can), and the map's edge and
 * masked-out cells count as one owner, so a hint at the edge stays one run.
 */
function hintedRuns(cells: Cell[], resolved: ResolvedLayout, owners: Int32Array, self: number): Run[] {
  const { width, height } = resolved;
  const found: { axis: "h" | "v"; line: number; side: number; across: number; at: number }[] = [];
  for (const { x, y } of cells) for (const [dx, dy] of SIDES) {
    const nx = x + dx, ny = y + dy, outside = nx < 0 || ny < 0 || nx >= width || ny >= height;
    const across = outside ? -1 : owners[ny * width + nx]!;
    if (across === self) continue;
    const axis = dx ? "v" : "h", line = dx ? x + Math.max(dx, 0) : y + Math.max(dy, 0);
    const segment = resolved.segments[(dx ? `v:${line},${y}` : `h:${x},${line}`) as SegmentKey];
    if (segment?.guarantee !== "none" || !segment.stated.includes("not-passable-hint")) continue;
    found.push({ axis, line, side: dx + dy, across, at: dx ? y : x });
  }
  found.sort((p, q) => p.axis.localeCompare(q.axis) || p.line - q.line || p.side - q.side || p.across - q.across || p.at - q.at);
  const runs: Run[] = [];
  for (let i = 0; i < found.length;) {
    const first = found[i]!;
    let length = 1;
    i++;
    while (i < found.length && found[i]!.axis === first.axis && found[i]!.line === first.line
      && found[i]!.side === first.side && found[i]!.across === first.across && found[i]!.at === first.at + length) { length++; i++; }
    runs.push(first.axis === "h" ? { axis: "h", x: first.at, y: first.line, length } : { axis: "v", x: first.line, y: first.at, length });
  }
  return runs.sort((p, q) => p.axis.localeCompare(q.axis) || p.y - q.y || p.x - q.x);
}

export const briefs: MacroStages["briefs"] = (layout, resolved, layoutRegions, zones, library, cellSize) => {
  if (!isCellSize(cellSize)) throw new Error(`cell size must be a positive whole number of world units, not ${cellSize}`);
  // Placement refuses such params already; a layout made or loaded elsewhere might not have been through it.
  const countError = countParamsProblem(layout.params);
  if (countError) throw new Error(countError);
  // Flat indices translate to cells by the declared grid's width (20, "Next boundaries").
  const { width } = gridSize(layout.params);
  const zoneOf = (cell: Cell): Zone => {
    const zone = zones.find(({ cells: b }) => cell.x >= b.x0 && cell.x <= b.x1 && cell.y >= b.y0 && cell.y <= b.y1);
    if (!zone) throw new Error(`cell ${cell.x},${cell.y} lies in no zone`);
    return zone;
  };
  const portalsOf = new Map<string, Portal[]>(layoutRegions.regions.map((region) => [region.id, []]));
  for (const portal of layoutRegions.portals) {
    portalsOf.get(portal.a)!.push(briefPortal(portal));
    portalsOf.get(portal.b)!.push(briefPortal(portal));
  }

  // Which region holds each cell, to tell a hint facing another region from one facing the edge.
  const owners = new Int32Array(resolved.width * resolved.height).fill(-1);
  layoutRegions.regions.forEach((region, i) => { for (const index of region.cells) owners[index] = i; });

  // Resolve all guaranteed unit segments before considering region boundaries. This retains
  // same-owner seams and makes the common footprint independent of run grouping (20.6).
  const guaranteed: Run[] = [];
  const internal = new Map<number, Map<string, { axis: "h" | "v"; line: number; at: number[] }>>();
  for (const [key, segment] of Object.entries(resolved.segments)) {
    if (segment?.guarantee !== "guaranteed") continue;
    const match = /^([hv]):(\d+),(\d+)$/.exec(key);
    if (!match) throw new Error(`invalid resolved segment ${key}`);
    const axis = match[1] as "h" | "v", x = Number(match[2]), y = Number(match[3]);
    const a = axis === "h" ? (y - 1) * width + x : y * width + x - 1;
    const b = axis === "h" ? y * width + x : y * width + x;
    if (x < (axis === "v" ? 1 : 0) || y < (axis === "h" ? 1 : 0)
      || x >= resolved.width || y >= resolved.height
      || owners[a] === undefined || owners[b] === undefined || owners[a] < 0 || owners[b] < 0) continue;
    guaranteed.push({ axis, x, y, length: 1 });
    if (owners[a] !== owners[b]) continue;
    const owner = owners[a]!;
    if (!internal.has(owner)) internal.set(owner, new Map());
    const line = axis === "h" ? y : x, at = axis === "h" ? x : y;
    const lineKey = `${axis}:${line}`;
    const lines = internal.get(owner)!;
    if (!lines.has(lineKey)) lines.set(lineKey, { axis, line, at: [] });
    lines.get(lineKey)!.at.push(at);
  }
  const playable = layoutRegions.regions.flatMap((region) => region.cells.map((index) =>
    ({ x: index % width, y: Math.floor(index / width) })));
  const footprint = clearFootprint(guaranteed, playable);
  const footprintByKey = new Map(footprint.map((cell) => [`${cell.x},${cell.y}`, cell]));

  return layoutRegions.regions.map((region, self): RegionBrief => {
    const rule = library.cellClasses[region.class];
    if (!rule) throw new Error(`region ${region.id} has class ${region.class}, which the library doesn't register`);
    const cells = region.cells.map((index): Cell => ({ x: index % width, y: Math.floor(index / width) }));
    const nearbyClear = new Map<string, Cell>();
    for (const cell of cells) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${cell.x + dx},${cell.y + dy}`;
      const clear = footprintByKey.get(key);
      if (clear) nearbyClear.set(key, clear);
    }
    const margins = applyClearConstraints(cells, [...nearbyClear.values()]);
    const internalGuaranteed: Run[] = [];
    for (const { axis, line, at } of internal.get(self)?.values() ?? []) {
      at.sort((a, b) => a - b);
      for (let i = 0; i < at.length;) {
        const first = at[i]!;
        let length = 1;
        i++;
        while (i < at.length && at[i] === first + length) { length++; i++; }
        internalGuaranteed.push(axis === "h"
          ? { axis, x: first, y: line, length }
          : { axis, x: line, y: first, length });
      }
    }
    internalGuaranteed.sort((a, b) => a.axis.localeCompare(b.axis) || a.y - b.y || a.x - b.x);

    // Zone context, in the order zones are given; a zone that covers none of the region is left out.
    const zoned = new Map<Zone, Cell[]>();
    for (const cell of cells) {
      const zone = zoneOf(cell);
      const list = zoned.get(zone);
      if (list) list.push(cell); else zoned.set(zone, [cell]);
    }
    const zoneContext: ZoneContext[] = zones.filter((zone) => zoned.has(zone))
      .map((zone) => ({ tier: zone.tier, bonus: zone.bonus, lootChance: zone.lootChance, cells: zoned.get(zone)! }));

    const brief: RegionBrief = {
      id: region.id,
      seed: region.seed,
      type: rule.regionType,
      cellSize,
      cells,
      ...margins,
      internalGuaranteed,
      zones: zoneContext,
      portals: portalsOf.get(region.id)!,
    };
    const hints = hintedRuns(cells, resolved, owners, self);
    if (hints.length) brief.hints = hints;
    if (rule.params) brief.parameters = { ...rule.params };
    if (rule.coreElements) brief.coreElements = Object.fromEntries(Object.entries(rule.coreElements).map(([kind, count]) =>
      [kind, resolveCount(count, layout.params)])) as Partial<Record<CoreElementKind, number>>;
    return brief;
  });
};
