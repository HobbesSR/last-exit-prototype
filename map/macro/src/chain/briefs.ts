/**
 * Briefs (51 stage 5), a view: one `RegionBrief` per layout region, in the macro/micro
 * contract (`map/kernel/contract.ts`). It carries the region's type and parameters from
 * its class rule, its cells in global cell coordinates, the zone context they lie in, the
 * features the class rule lists, and its portals, which are its only obligation. A brief
 * never mentions another region's contents. A portal is its run and its id; the id names
 * the two regions it joins (step 5), so both sides' briefs name a shared portal alike, and
 * nothing else about the region across is passed.
 */
import type { Cell } from "../../../kernel/cell.ts";
import type { FeatureKind, Portal, RegionBrief, ZoneContext } from "../../../kernel/contract.ts";
import { makeZones } from "../core.ts";
import { gridSize } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainParams, LayoutPortal, MacroStages, Zone } from "./types.ts";

/** The tier zones a layout's params give (`makeZones`), in cell units. */
export function chainZones(params: ChainParams): Zone[] {
  return makeZones({ ...params, tileSize: CHAIN_TILE_SIZE }).map(({ id, tier, bonus, lootChance, cells: [x0, y0, x1, y1] }) =>
    ({ id, tier, bonus, lootChance, cells: { x0, y0, x1, y1 } }));
}

/** A layout portal as a brief carries it: its run and id, without the regions on each side. */
const briefPortal = ({ id, axis, x, y, length }: LayoutPortal): Portal => ({ id, axis, x, y, length });

export const briefs: MacroStages["briefs"] = (layout, layoutRegions, zones, library, cellSize) => {
  if (!(Number.isFinite(cellSize) && cellSize > 0)) throw new Error(`cell size must be positive, not ${cellSize}`);
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

  return layoutRegions.regions.map((region): RegionBrief => {
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
    if (rule.params) brief.parameters = { ...rule.params };
    if (rule.features) brief.features = Object.fromEntries(Object.entries(rule.features).map(([kind, count]) =>
      [kind, count === "exitCount" ? layout.params.exitCount : count])) as Partial<Record<FeatureKind, number>>;
    return brief;
  });
};
