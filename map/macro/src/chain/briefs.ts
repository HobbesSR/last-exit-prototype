/**
 * Briefs (51 stage 5), a view: one `RegionBrief` per layout region, in the macro/micro
 * contract (`map/kernel/contract.ts`). It carries the region's type and parameters from
 * its class rule, its cells in global cell coordinates, the zone context they lie in, the
 * core elements the class rule lists, and its portals, which are its only obligation. It also
 * carries the perimeter stretches the library hints should be occupied (52), which are
 * guidance and never an obligation. A brief never mentions another region's contents. A portal is its run and its id; the id names
 * the two regions it joins (step 5), so both sides' briefs name a shared portal alike, and
 * nothing else about the region across is passed.
 */
import type { Cell } from "../../../kernel/cell.ts";
import type { CoreElementKind, Portal, RegionBrief, ZoneContext } from "../../../kernel/contract.ts";
import type { Run } from "../../../kernel/run.ts";
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
 * where the owner across changes, as `boundaryRuns` ends one, and the map's edge and
 * masked-out cells count as one owner, so a hint at the edge stays one run.
 */
function hintedRuns(cells: Cell[], resolved: ResolvedLayout, owners: Int32Array, self: number): Run[] {
  const { width, height } = resolved;
  const found: { axis: "h" | "v"; line: number; across: number; at: number }[] = [];
  for (const { x, y } of cells) for (const [dx, dy] of SIDES) {
    const nx = x + dx, ny = y + dy, outside = nx < 0 || ny < 0 || nx >= width || ny >= height;
    const across = outside ? -1 : owners[ny * width + nx]!;
    if (across === self) continue;
    const axis = dx ? "v" : "h", line = dx ? x + Math.max(dx, 0) : y + Math.max(dy, 0);
    const segment = resolved.segments[(dx ? `v:${line},${y}` : `h:${x},${line}`) as SegmentKey];
    if (segment?.guarantee !== "none" || !segment.stated.includes("not-passable-hint")) continue;
    found.push({ axis, line, across, at: dx ? y : x });
  }
  found.sort((p, q) => p.axis.localeCompare(q.axis) || p.line - q.line || p.across - q.across || p.at - q.at);
  const runs: Run[] = [];
  for (let i = 0; i < found.length;) {
    const first = found[i]!;
    let length = 1;
    i++;
    while (i < found.length && found[i]!.axis === first.axis && found[i]!.line === first.line
      && found[i]!.across === first.across && found[i]!.at === first.at + length) { length++; i++; }
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

  return layoutRegions.regions.map((region, self): RegionBrief => {
    const rule = library.cellClasses[region.class];
    if (!rule) throw new Error(`region ${region.id} has class ${region.class}, which the library doesn't register`);
    const cells = region.cells.map((index): Cell => ({ x: index % width, y: Math.floor(index / width) }));

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
