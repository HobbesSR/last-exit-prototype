import type { BuiltMap, BuiltRegion, PortalPair, RegionElement } from './types.ts';
import { LIMITS } from './limits.ts';

const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Join a map's region results in one cell coordinate system (51 stage 7). Each cell has
 * one owner, and each portal is named alike, with the same run, in the briefs on both of
 * its sides, so the two builders made the same promise about it. Anything else is
 * refused, not repaired. It takes the results in any order and returns the same map.
 *
 * It reads briefs and ownership only. Whether a builder kept its promise, or kept its
 * colliders inside its own cells, is its own business (51 principle 9).
 */
export function composeRegions(results: readonly BuiltRegion[]): BuiltMap<RegionElement> {
  if (!results.length || results.length > LIMITS.mapRegions) throw new Error(`A map needs 1 to ${LIMITS.mapRegions} region results.`);
  const regions = [...results].sort((a, b) => byId(a.brief.id, b.brief.id)), cellSize = regions[0]!.brief.cellSize;
  const owners = new Map<string, BuiltRegion>();
  let previous: string | undefined;
  for (const region of regions) {
    const { id } = region.brief;
    if (region.version !== 'region-2') throw new Error(`Region ${id} isn't a region-2 result.`);
    if (id === previous) throw new Error(`Region ids must be unique: ${id} appears twice.`);
    previous = id;
    if (region.brief.cellSize !== cellSize) throw new Error(`Region ${id} has cell size ${region.brief.cellSize}, not the map's ${cellSize}.`);
    if (new Set(region.brief.portals.map(p => p.id)).size !== region.brief.portals.length) throw new Error(`Region ${id} names a portal twice.`);
    for (const cell of region.brief.cells) {
      const key = `${cell.x},${cell.y}`, owner = owners.get(key);
      if (owner) throw new Error(`Regions ${owner.brief.id} and ${id} both own cell ${key}.`);
      owners.set(key, region);
    }
  }
  // A portal id names one pair across the whole map (51 stage 5), so it appears once on each side and nowhere else.
  const pairs: PortalPair[] = [], named = new Map<string, readonly [string, string]>();
  for (const region of regions) for (const portal of region.brief.portals) {
    const { id } = region.brief, across = new Set<BuiltRegion>();
    for (let i = 0; i < portal.length; i++) {
      // The cells on each side of segment i: above or left of the line, then below or right.
      const sides = portal.axis === 'h' ? [`${portal.x + i},${portal.y - 1}`, `${portal.x + i},${portal.y}`] : [`${portal.x - 1},${portal.y + i}`, `${portal.x},${portal.y + i}`];
      const mine = sides.filter(key => owners.get(key) === region);
      if (mine.length !== 1) throw new Error(`Portal ${portal.id} of region ${id} isn't on its perimeter.`);
      const other = owners.get(sides.find(key => owners.get(key) !== region)!);
      if (!other) throw new Error(`Portal ${portal.id} of region ${id} faces cells no region owns.`);
      across.add(other);
    }
    if (across.size !== 1) throw new Error(`Portal ${portal.id} of region ${id} straddles regions ${[...across].map(r => r.brief.id).sort(byId).join(' and ')}.`);
    const neighbour = [...across][0]!;
    const paired = neighbour.brief.portals.find(p => p.id === portal.id);
    if (!paired || paired.axis !== portal.axis || paired.x !== portal.x || paired.y !== portal.y || paired.length !== portal.length) throw new Error(`Portal ${portal.id} of region ${id} has no matching portal in region ${neighbour.brief.id}.`);
    // Compared as a tuple: ids are any strings, so no joined key is unambiguous.
    const pair = id < neighbour.brief.id ? [id, neighbour.brief.id] as const : [neighbour.brief.id, id] as const, earlier = named.get(portal.id);
    if (earlier && (earlier[0] !== pair[0] || earlier[1] !== pair[1])) throw new Error(`Portal ${portal.id} names two pairs: ${JSON.stringify(earlier)} and ${JSON.stringify(pair)}.`);
    named.set(portal.id, pair);
    if (id < neighbour.brief.id) pairs.push({ portal: portal.id, a: id, b: neighbour.brief.id });
  }
  return { cellSize, regions, pairs: pairs.sort((p, q) => byId(p.portal, q.portal)) };
}
