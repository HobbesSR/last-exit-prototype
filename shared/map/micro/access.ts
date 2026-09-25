import { microMetrics } from './metrics.ts';
import { capsule, createRegionMask, findRegionRoute, shapesOverlap, travelClear, validShape } from './geometry.ts';
import type { Shape } from '../../shape.ts';
import type { Vec2 } from '../../types.ts';
import type { Cell, Passage, RegionPort, RegionRoute, ResolvedPort } from './types.ts';

const RANK: Record<Passage, number> = { none: 0, contestant: 1, hunter: 2 };
const WALL = 8;
const normal = { N: { x: 0, y: 1 }, S: { x: 0, y: -1 }, W: { x: 1, y: 0 }, E: { x: -1, y: 0 } } as const;

export interface RegionAccessInput {
  cells: Cell[];
  cellSize: number;
  bodyProfile?: 'live' | 'cell';
  ports: RegionPort[];
  blockers: Shape[];
}

export interface RegionAccessResult {
  valid: boolean;
  errors: string[];
  routes: Array<RegionRoute & { from: string; to: string }>;
}

type AccessContract = Omit<RegionAccessInput, 'blockers'>;

/**
 * Resolve only the macro perimeter contract.  This deliberately has no builder
 * or artifact dependency, so callers may check inherited interfaces before
 * deciding which geometry will implement them.
 */
export function resolveAccessRequirements(input: AccessContract): ResolvedPort[] {
  if (!input || !Number.isFinite(input.cellSize) || input.cellSize < 24 || input.cellSize > 200) throw new Error('Cell size must be from 24 to 200 world units.');
  if (input.bodyProfile !== undefined && input.bodyProfile !== 'live' && input.bodyProfile !== 'cell') throw new Error('Unknown body profile.');
  if (!Array.isArray(input.cells) || !input.cells.length || input.cells.length > 4096) throw new Error('A region needs 1 to 4096 cells.');
  if (input.cells.some(c => !c || !Number.isInteger(c.x) || !Number.isInteger(c.y) || Math.abs(c.x) > 512 || Math.abs(c.y) > 512)) throw new Error('Cell addresses must be integers between -512 and 512.');
  const cells = input.cells.map(c => ({ x: c.x, y: c.y }));
  const keys = new Set(cells.map(c => `${c.x},${c.y}`));
  if (keys.size !== cells.length) throw new Error('Duplicate region cell.');
  const mask = createRegionMask({ cells, cellSize: input.cellSize });
  if (mask.bounds.w / input.cellSize > 64 || mask.bounds.h / input.cellSize > 64) throw new Error('A region may span at most 64 cells per axis.');
  const seen = new Set<string>(), queue = [cells[0]!];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!, key = `${c.x},${c.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) if (mask.has(c.x + dx, c.y + dy)) queue.push({ x: c.x + dx, y: c.y + dy });
  }
  if (seen.size !== keys.size) throw new Error('Region cells must form one connected area.');
  if (!Array.isArray(input.ports) || input.ports.length > 64) throw new Error('Ports must be a bounded list.');

  const metrics = microMetrics(input), named = new Set<string>(), claimed = new Set<string>(), ports: ResolvedPort[] = [];
  for (const p of input.ports) {
    if (!p || typeof p.id !== 'string' || !p.id || named.has(p.id) || !Object.hasOwn(normal, p.side) || !Object.hasOwn(RANK, p.required) || !Object.hasOwn(RANK, p.allowed) || RANK[p.required] > RANK[p.allowed]) throw new Error('Invalid or duplicate port contract.');
    named.add(p.id);
    if (!p.start || !Number.isInteger(p.start.x) || !Number.isInteger(p.start.y) || !Number.isInteger(p.length) || p.length < 1 || p.length > 64) throw new Error('Invalid port segment run.');
    const n = normal[p.side], horizontal = p.side === 'N' || p.side === 'S', size = input.cellSize;
    for (let i = 0; i < p.length; i++) {
      const x = p.start.x + (horizontal ? i : 0), y = p.start.y + (horizontal ? 0 : i), key = `${p.side}:${x},${y}`;
      if (!mask.has(x, y) || mask.has(x - n.x, y - n.y) || claimed.has(key)) throw new Error(`Port ${p.id} must own a unique continuous perimeter run.`);
      claimed.add(key);
    }
    const span = p.length * size;
    const width = p.allowed === 'none' ? 0 : p.allowed === 'contestant' ? Math.min(span, metrics.squeeze) : Math.min(span, input.bodyProfile === 'cell' ? metrics.doorway : Math.max(2 * metrics.clearance.hunter + 8, span * .8));
    if (p.required !== 'none' && width < 2 * metrics.clearance[p.required] + 2) throw new Error(`Port ${p.id} is too short for its required body.`);
    const x = p.start.x * size + (p.side === 'E' ? size : 0), y = p.start.y * size + (p.side === 'S' ? size : 0);
    const centre = { x: x + (horizontal ? span / 2 : 0), y: y + (horizontal ? 0 : span / 2) };
    const inset = (p.allowed === 'none' ? metrics.clearance.hunter : metrics.clearance[p.allowed]) + WALL + 4;
    ports.push({ ...structuredClone(p), centre, inside: { x: centre.x + n.x * inset, y: centre.y + n.y * inset }, width });
  }
  return ports;
}

function crossingClear(port: ResolvedPort, radius: number, blockers: readonly Shape[]): boolean {
  const n = normal[port.side];
  const outside: Vec2 = { x: port.centre.x - n.x * (radius + WALL), y: port.centre.y - n.y * (radius + WALL) };
  // The outside endpoint is intentionally not constrained by the local mask.
  return !capsule(outside, port.inside, radius).some(part => blockers.some(blocker => {
    // Shapes were checked before this call; this line stays deliberately free of
    // mask containment so a boundary crossing can extend beyond owned cells.
    return !validShape(blocker) || shapesOverlap(part, blocker);
  }));
}

/** Recompute local physical access from final collision geometry; saved paths are never an input. */
export function validateRegionAccess(input: RegionAccessInput): RegionAccessResult {
  const errors: string[] = [], routes: RegionAccessResult['routes'] = [];
  try {
    const ports = resolveAccessRequirements(input);
    if (!Array.isArray(input.blockers) || input.blockers.some(shape => !validShape(shape))) throw new Error('Blockers must be valid convex collision shapes.');
    const mask = createRegionMask({ cells: input.cells, cellSize: input.cellSize });
    const radii = microMetrics(input).clearance;
    for (const port of ports) {
      if (port.required !== 'none') {
        const radius = radii[port.required];
        if (!crossingClear(port, radius, input.blockers)) errors.push(`Port ${port.id} violates its passage floor.`);
        if (!travelClear(mask, input.blockers, port.inside, port.inside, radius)) errors.push(`Port ${port.id} lacks interior standing room for ${port.required}.`);
      }
      if (port.allowed === 'none' && crossingClear(port, radii.contestant, input.blockers)) errors.push(`Port ${port.id} violates its passage ceiling.`);
      if (port.allowed === 'contestant' && crossingClear(port, radii.hunter, input.blockers)) errors.push(`Port ${port.id} violates its passage ceiling.`);
    }
    for (const role of ['contestant', 'hunter'] as const) {
      const required = ports.filter(port => RANK[port.required] >= RANK[role]);
      for (let i = 1; i < required.length; i++) {
        const from = required[0]!, to = required[i]!, points = findRegionRoute(mask, input.blockers, from.inside, to.inside, radii[role]);
        if (!points) errors.push(`Required ${role} port ${to.id} is disconnected from ${from.id}.`);
        else routes.push({ role, radius: radii[role], points, from: from.id, to: to.id });
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { valid: errors.length === 0, errors, routes };
}
