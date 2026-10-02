import { generateMicroRegion } from './index.ts';
import { createRegionMask, elementShapes, travelClear } from './geometry.ts';
import type { BuiltMap, BuiltRegion, MicroResult, PortalPair, RegionElement, RegionSpec } from './types.ts';
import { microMetrics } from './metrics.ts';
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
  const pairs: PortalPair[] = [], named = new Map<string, string>();
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
    const pair = [id, neighbour.brief.id].sort(byId).join(' and '), earlier = named.get(portal.id);
    if (earlier && earlier !== pair) throw new Error(`Portal ${portal.id} names two pairs: regions ${earlier}, and regions ${pair}.`);
    named.set(portal.id, pair);
    if (id < neighbour.brief.id) pairs.push({ portal: portal.id, a: id, b: neighbour.brief.id });
  }
  return { cellSize, regions, pairs: pairs.sort((p, q) => byId(p.portal, q.portal)) };
}

export interface MicroLayout {
  version: 'micro-layout-1';
  regions: MicroResult[];
  connections: Array<{ a: string; b: string; portA: string; portB: string }>;
}

/** Compose supplied regions; this does not choose a partition, set pieces or a macro topology. */
export function composeMicroRegions(specs: RegionSpec[]): MicroLayout {
  if (!Array.isArray(specs) || !specs.length || specs.length > 16) throw new Error('A micro layout needs 1 to 16 supplied regions.');
  const ordered = [...specs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ids = new Set<string>();
  const owners = new Map<string, string>(), size = ordered[0].cellSize;
  for (const spec of ordered) {
    if (ids.has(spec.id)) throw new Error('Region identities must be unique.');
    ids.add(spec.id);
    if (spec.cellSize !== size) throw new Error('Composed regions must share a cell scale and coordinate system.');
    if ((spec.bodyProfile ?? 'live') !== (ordered[0].bodyProfile ?? 'live')) throw new Error('Composed regions must share a body profile.');
    for (const cell of spec.cells) {
      const key = `${cell.x},${cell.y}`;
      if (owners.has(key)) throw new Error(`Regions overlap at ${key}.`);
      owners.set(key, spec.id);
    }
  }
  const regions = ordered.map(generateMicroRegion), connections: MicroLayout['connections'] = [];
  const opposite = { N: 'S', S: 'N', W: 'E', E: 'W' };
  const outside = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, E: { x: 1, y: 0 } };
  for (const region of regions) for (const port of region.ports) {
    const n = outside[port.side], horizontal = !n.x, neighbours = new Set<string>();
    let missing = false;
    for (let i = 0; i < port.length; i++) {
      const key = `${port.start.x + (horizontal ? i : 0) + n.x},${port.start.y + (horizontal ? 0 : i) + n.y}`;
      const owner = owners.get(key);
      if (owner) neighbours.add(owner); else missing = true;
    }
    if (!neighbours.size) continue; // External port: whoever supplies the next region owns its other half.
    if (neighbours.size !== 1 || missing) throw new Error(`Port ${port.id} straddles different boundary owners.`);
    const neighbour = regions.find(r => r.spec.id === [...neighbours][0])!;
    const paired = neighbour.ports.find(p => p.side === opposite[port.side] && p.length === port.length && p.centre.x === port.centre.x && p.centre.y === port.centre.y);
    if (!paired || paired.required !== port.required || paired.allowed !== port.allowed) throw new Error(`Shared port ${region.spec.id}/${port.id} has no matching floor/ceiling contract.`);
    if (region.spec.id > neighbour.spec.id) continue;
    if (port.required !== 'none') {
      const mask = createRegionMask({ cellSize: size, cells: [...region.spec.cells, ...neighbour.spec.cells] });
      const blockers = [...region.elements, ...neighbour.elements].flatMap(e => elementShapes(e));
      if (!travelClear(mask, blockers, port.inside, paired.inside, microMetrics(region.spec).clearance[port.required])) throw new Error(`Composed geometry obstructs shared port ${port.id}.`);
    }
    connections.push({ a: region.spec.id, b: neighbour.spec.id, portA: port.id, portB: paired.id });
  }
  return { version: 'micro-layout-1', regions, connections };
}
