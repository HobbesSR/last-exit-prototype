import { generateMicroRegion } from './index.ts';
import { createRegionMask, elementShapes, travelClear } from './geometry.ts';
import type { RegionResult, RegionSpec } from './types.ts';
import { microMetrics } from './metrics.ts';

export interface MicroLayout {
  version: 'micro-layout-1';
  regions: RegionResult[];
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
