import { resolveAccessRequirements, validateRegionAccess } from './access.ts';
import { createRegionMask } from './geometry.ts';
import type { Shape } from '../../shape.ts';
import type { Cell, RegionPort } from './types.ts';

/** Global cell coordinates at every level; builder parameters are intentionally absent. */
export interface RegionBoundary {
  cells: Cell[];
  cellSize: number;
  bodyProfile?: 'live' | 'cell';
  ports: RegionPort[];
}
export interface ChildBoundary extends RegionBoundary { id: string }
const key = (cell: Cell) => `${cell.x},${cell.y}`;
const outward = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 }, E: { x: 1, y: 0 } };
const opposite = { N: 'S', S: 'N', W: 'E', E: 'W' };
function portCells(port: RegionPort): Cell[] {
  const horizontal = port.side === 'N' || port.side === 'S';
  return Array.from({ length: port.length }, (_, i) => ({ x: port.start.x + (horizontal ? i : 0), y: port.start.y + (horizontal ? 0 : i) }));
}
const samePort = (a: RegionPort, b: RegionPort) => a.id === b.id && a.side === b.side && a.start.x === b.start.x && a.start.y === b.start.y && a.length === b.length && a.required === b.required && a.allowed === b.allowed;

/** Pass complete requirements to owners. Never clip a promised crossing at a child seam. */
export function inheritBoundaryPorts(parent: RegionBoundary, children: Array<{ id: string; cells: Cell[] }>): Record<string, RegionPort[]> {
  resolveAccessRequirements(parent);
  if (!children.length || children.length > 16) throw new Error('Boundary inheritance needs 1 to 16 children.');
  const parentCells = new Set(parent.cells.map(key)), owners = new Map<string, string>();
  const inherited: Record<string, RegionPort[]> = Object.create(null);
  for (const child of children) {
    if (!child.id || Object.hasOwn(inherited, child.id)) throw new Error('Child boundary identities must be unique.');
    resolveAccessRequirements({ ...parent, cells: child.cells, ports: [] });
    inherited[child.id] = [];
    for (const cell of child.cells) {
      const k = key(cell);
      if (!parentCells.has(k) || owners.has(k)) throw new Error('Children must partition parent ownership exactly.');
      owners.set(k, child.id);
    }
  }
  if (owners.size !== parentCells.size) throw new Error('Children must partition parent ownership exactly.');
  for (const port of parent.ports) {
    const ids = new Set(portCells(port).map(cell => owners.get(key(cell))!));
    if (ids.size !== 1) throw new Error(`Boundary requirement ${port.id} spans children; renegotiate the partition or its crossing explicitly.`);
    inherited[[...ids][0]!]!.push(structuredClone(port));
  }
  return inherited;
}

/** Give a neighbor the opposite side of an explicitly chosen inter-child crossing. */
export function pairedBoundaryPort(port: RegionPort, id = port.id): RegionPort {
  if (!Object.hasOwn(outward, port.side)) throw new Error('Invalid boundary side.');
  const delta = outward[port.side];
  return { ...structuredClone(port), id, side: opposite[port.side] as RegionPort['side'], start: { x: port.start.x + delta.x, y: port.start.y + delta.y } };
}

/** Post-generation proof at a hierarchy boundary. No routing or geometry is repaired. */
export function validateBoundaryComposition(parent: RegionBoundary, children: Array<ChildBoundary & { blockers: Shape[] }>) {
  const errors: string[] = [];
  let routes: ReturnType<typeof validateRegionAccess>['routes'] = [];
  try {
    const inherited = inheritBoundaryPorts(parent, children), owners = new Map(children.flatMap(child => child.cells.map(cell => [key(cell), child.id] as const)));
    const allBlockers = children.flatMap(child => child.blockers);
    for (const child of children) {
      if (child.cellSize !== parent.cellSize || (child.bodyProfile ?? 'live') !== (parent.bodyProfile ?? 'live')) throw new Error('Child boundary scale and body profile must match its parent.');
      resolveAccessRequirements(child);
      const mask = createRegionMask(child);
      if (child.blockers.some(shape => !mask.contains(shape))) errors.push(`Child ${child.id} collision geometry leaves its ownership.`);
      for (const required of inherited[child.id]!) if (!child.ports.some(p => samePort(p, required))) errors.push(`Child ${child.id} drops or changes inherited requirement ${required.id}.`);
      for (const port of child.ports) {
        const delta = outward[port.side], neighbours = new Set(portCells(port).map(c => owners.get(key({ x: c.x + delta.x, y: c.y + delta.y }))));
        if (neighbours.size !== 1) { errors.push(`Child ${child.id} port ${port.id} straddles boundary owners.`); continue; }
        const neighbourId = [...neighbours][0];
        if (!neighbourId) {
          if (!inherited[child.id]!.some(p => samePort(p, port))) errors.push(`Child ${child.id} invents external requirement ${port.id}.`);
          continue;
        }
        const neighbour = children.find(c => c.id === neighbourId)!;
        const expected = pairedBoundaryPort(port);
        if (!neighbour.ports.some(p => samePort({ ...p, id: expected.id }, expected))) errors.push(`Child ${child.id} port ${port.id} lacks a matching neighbor contract.`);
      }
      // Neighbor geometry participates in threshold checks; interior routing stays in the child mask.
      const check = validateRegionAccess({ ...child, blockers: allBlockers });
      errors.push(...check.errors.map(error => `${child.id}: ${error}`));
    }
    const check = validateRegionAccess({ ...parent, blockers: allBlockers });
    errors.push(...check.errors.map(error => `parent: ${error}`)); routes = check.routes;
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return { valid: !errors.length, errors, routes };
}
