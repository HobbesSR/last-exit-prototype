import { composeMicroRegions } from '../compose.ts';
import { validateBoundaryComposition } from '../boundary.ts';
import { microMetrics } from '../metrics.ts';
import { createRegionMask, elementShapes, findRegionRoute, travelClear } from '../geometry.ts';
import { spreadPoints } from '../placement.ts';
import { validateMicroRegion } from '../index.ts';
import { validateDecompositionPlan } from './validate.ts';
import { cellKey } from './analysis.ts';
import { EXAMPLE_GENERATORS } from './example.ts';
import type { BuilderId, RegionPort, RegionResult, RegionRoute, RegionSpec } from '../types.ts';
import type { Vec2 } from '../../../types.ts';
import type { DecompositionPlan, InterfaceRun } from './types.ts';

export interface RealizedDecomposition {
  version: 'realized-decomposition-1';
  plan: DecompositionPlan;
  seed: number;
  assignments: Array<{ pieceId: string; generator: string; builder: BuilderId; role: string }>;
  regions: RegionResult[];
  portals: Array<{ a: string; b: string; portA: string; portB: string; centre: Vec2; width: number }>;
  anchors: Array<{ pieceId: string; point: Vec2 }>;
  routes: Array<RegionRoute & { from: string; to: string }>;
}

const MAPPING: Record<string, BuilderId> = { 'rectangular-room': 'depot', 'courtyard-ring': 'courtyard', 'generic-lobe': 'ruins', 'circulation-strip': 'entry' };

/** An explicit demonstration policy, not a universal portal negotiator or macro adapter. */
export function realizeDecomposition(plan: DecompositionPlan, options: { seed?: number; density?: number; roomBuilder?: 'depot' | 'open' | 'ruins' } = {}): RealizedDecomposition {
  const errors = validateDecompositionPlan(plan, EXAMPLE_GENERATORS);
  if (errors.length) throw new Error(`Invalid decomposition: ${errors.join(' ')}`);
  if (plan.context.entrances?.length) throw new Error('External macro entrances need an explicit adapter; the combined demo currently realizes internal interfaces only.');
  const seed = options.seed ?? 4217, density = options.density ?? .55;
  if (!Number.isSafeInteger(seed) || !Number.isFinite(density) || density < 0 || density > 1) throw new Error('Invalid realization seed or density.');
  if (options.roomBuilder && !['depot', 'open', 'ruins'].includes(options.roomBuilder)) throw new Error('Unknown room realization.');
  const pieces = [...plan.pieces.map(p => ({ id: p.id, cells: p.cells, role: p.role, generator: p.generator })),
    ...plan.residuals.filter(r => r.role === 'residual').map(r => ({ ...r, generator: 'clear-residual' }))];
  if (!pieces.length || pieces.length > 16) throw new Error('The combined demo requires 1 to 16 allocated or residual regions.');
  const assignments = pieces.map(p => {
    const builder = p.generator === 'clear-residual' ? 'entry' : p.generator === 'rectangular-room' && options.roomBuilder ? options.roomBuilder : MAPPING[p.generator];
    if (!builder) throw new Error(`No physical builder registered for ${p.generator}.`);
    return { pieceId: p.id, generator: p.generator, builder, role: p.role };
  });
  const specs: RegionSpec[] = pieces.map((p, i) => ({ id: p.id, cells: structuredClone(p.cells), cellSize: plan.context.cellSize, seed,
    builder: assignments[i]!.builder, bodyProfile: 'cell', ports: [], parameters: { density, roomCells: 4, decay: .45 },
    loot: { budget: assignments[i]!.builder === 'entry' ? 0 : 3, tier: 1 }, ...(assignments[i]!.builder === 'entry' ? { entry: { count: 0 } } : {}) }));
  const byId = new Map(specs.map(s => [s.id, s])), ownership = new Map(pieces.flatMap(p => p.cells.map(c => [cellKey(c), p.id] as const)));
  const attach = (spec: RegionSpec, run: InterfaceRun, id: string, open: boolean) => {
    const horizontal = run.axis === 'h';
    const negative = { x: run.x - (horizontal ? 0 : 1), y: run.y - (horizontal ? 1 : 0) };
    const onNegativeSide = ownership.get(cellKey(negative)) === spec.id;
    const side: RegionPort['side'] = horizontal ? onNegativeSide ? 'S' : 'N' : onNegativeSide ? 'E' : 'W';
    spec.ports.push({ id, side, start: onNegativeSide ? negative : { x: run.x, y: run.y }, length: run.length,
      required: open ? 'hunter' : 'none', allowed: open ? 'hunter' : 'none' });
  };
  for (const [i, edge] of plan.interfaces.entries()) {
    const a = byId.get(edge.a), b = byId.get(edge.b);
    if (!a || !b) continue; // Reserved/forbidden ground remains outside this demo's playable region.
    const usable = [...edge.runs].filter(r => r.length >= 2).sort((a, b) => b.length - a.length || a.y - b.y || a.x - b.x);
    if (!usable.length) throw new Error(`Interface ${edge.a} / ${edge.b} has no two-cell passage opportunity.`);
    const chosen = usable[0]!;
    for (const [j, run] of edge.runs.entries()) {
      const open = run.axis === chosen.axis && run.x === chosen.x && run.y === chosen.y;
      attach(a, run, `join-${i}-${j}`, open); attach(b, run, `join-${i}-${j}`, open);
    }
  }
  const layout = composeMicroRegions(specs), portals: RealizedDecomposition['portals'] = [];
  const boundaryCheck = validateBoundaryComposition({ cells: specs.flatMap(s => s.cells), cellSize: plan.context.cellSize, bodyProfile: 'cell', ports: [] },
    layout.regions.map(region => ({ ...region.spec, blockers: region.elements.flatMap(e => elementShapes(e)) })));
  if (!boundaryCheck.valid) throw new Error(`Child boundary contract failed: ${boundaryCheck.errors.join(' ')}`);
  for (const c of layout.connections) {
    const p = layout.regions.find(r => r.spec.id === c.a)!.ports.find(p => p.id === c.portA)!;
    if (p.required !== 'none') portals.push({ ...c, centre: p.centre, width: p.width });
  }
  const mask = createRegionMask({ cells: specs.flatMap(s => s.cells), cellSize: plan.context.cellSize });
  const blockers = layout.regions.flatMap(r => r.elements.flatMap(e => elementShapes(e))), radius = microMetrics(specs[0]!).clearance.hunter;
  const anchors = layout.regions.map(region => {
    const point = region.ports.find(p => p.required === 'hunter')?.inside || spreadPoints(createRegionMask(region.spec), {
      count: 1, radius, blockers: region.elements.flatMap(e => elementShapes(e, true)),
    }).points[0];
    if (!point) throw new Error(`No hunter-sized standing area in ${region.spec.id}.`);
    return { pieceId: region.spec.id, point };
  });
  const routes: RealizedDecomposition['routes'] = [];
  for (const role of ['contestant', 'hunter'] as const) for (const target of anchors.slice(1)) {
    const radius = microMetrics(specs[0]!).clearance[role], from = anchors[0]!;
    const points = findRegionRoute(mask, blockers, from.point, target.point, radius);
    if (!points) throw new Error(`Combined ${role} route to ${target.pieceId} is obstructed.`);
    routes.push({ role, radius, from: from.pieceId, to: target.pieceId, points });
  }
  return { version: 'realized-decomposition-1', plan: structuredClone(plan), seed, assignments, regions: layout.regions, portals, anchors, routes };
}

/** Recheck local artifacts and saved cross-region sweeps from emitted geometry. */
export function validateRealization(result: RealizedDecomposition): string[] {
  const errors: string[] = [];
  try {
    if (result.version !== 'realized-decomposition-1') throw new Error('Unknown realization version.');
    errors.push(...validateDecompositionPlan(result.plan, EXAMPLE_GENERATORS));
    if (result.plan.context.entrances?.length) errors.push('External macro entrances are not supported by this realization policy.');
    if (!Number.isSafeInteger(result.seed) || !result.regions.length || result.regions.length > 16) throw new Error('Invalid realization bounds.');
    for (const region of result.regions) errors.push(...validateMicroRegion(region));
    const expected = [...result.plan.pieces, ...result.plan.residuals.filter(r => r.role === 'residual')];
    if (expected.length !== result.regions.length) errors.push('Realization has missing or additional regions.');
    for (const part of expected) {
      const regions = result.regions.filter(r => r.spec.id === part.id);
      if (regions.length !== 1 || JSON.stringify(regions[0]!.spec.cells) !== JSON.stringify(part.cells)) errors.push(`Physical ownership changed for ${part.id}.`);
      const assignment = result.assignments.filter(a => a.pieceId === part.id);
      const generator = 'generator' in part ? part.generator : 'clear-residual';
      if (assignment.length !== 1 || assignment[0]!.generator !== generator || assignment[0]!.role !== part.role || assignment[0]!.builder !== regions[0]?.spec.builder) errors.push(`Generator assignment changed for ${part.id}.`);
      const allowed = generator === 'rectangular-room' ? ['depot', 'open', 'ruins'] : [generator === 'clear-residual' ? 'entry' : MAPPING[generator]];
      if (!allowed.includes(regions[0]?.spec.builder)) errors.push(`Unsupported physical builder for ${part.id}.`);
    }
    if (result.assignments.length !== expected.length) errors.push('Physical assignment coverage is incomplete.');
    if (result.regions.some(r => r.spec.cellSize !== result.plan.context.cellSize || r.spec.bodyProfile !== 'cell' || r.spec.seed !== result.seed)) errors.push('Physical scale or seed changed between regions.');
    const mask = createRegionMask({ cells: result.regions.flatMap(r => r.spec.cells), cellSize: result.plan.context.cellSize });
    const blockers = result.regions.flatMap(r => r.elements.flatMap(e => elementShapes(e)));
    const clearance = microMetrics(result.regions[0]!.spec).clearance;
    const anchorIds = new Set<string>();
    for (const anchor of result.anchors) {
      const region = result.regions.find(r => r.spec.id === anchor.pieceId);
      if (!region || anchorIds.has(anchor.pieceId) || !travelClear(createRegionMask(region.spec), blockers, anchor.point, anchor.point, clearance.hunter)) errors.push('Invalid or obstructed region anchor.');
      anchorIds.add(anchor.pieceId);
    }
    if (anchorIds.size !== expected.length) errors.push('Region anchor coverage is incomplete.');
    const root = result.anchors[0], routeKeys = new Set<string>();
    for (const route of result.routes) {
      if (!['contestant', 'hunter'].includes(route.role) || route.radius !== microMetrics(result.regions[0]!.spec).clearance[route.role] || route.points.length < 2) { errors.push('Invalid combined route.'); continue; }
      const target = result.anchors.find(a => a.pieceId === route.to), key = `${route.role}:${route.to}`;
      if (!root || route.from !== root.pieceId || !target || target === root || routeKeys.has(key) || JSON.stringify(route.points[0]) !== JSON.stringify(root.point) || JSON.stringify(route.points.at(-1)) !== JSON.stringify(target.point)) errors.push('Combined route endpoints do not cover the region anchors.');
      routeKeys.add(key);
      for (let i = 1; i < route.points.length; i++) if (!travelClear(mask, blockers, route.points[i - 1]!, route.points[i]!, route.radius)) errors.push('Combined route crosses obstructed ground.');
    }
    if (result.routes.length !== Math.max(0, expected.length - 1) * 2) errors.push('Combined route coverage is incomplete.');
    const openPorts = result.regions.flatMap(r => r.ports.filter(p => p.required === 'hunter').map(p => ({ region: r.spec.id, port: p }))), matched = new Set<string>();
    for (const portal of result.portals) {
      const a = openPorts.find(p => p.region === portal.a && p.port.id === portal.portA), b = openPorts.find(p => p.region === portal.b && p.port.id === portal.portB);
      const keyA = JSON.stringify([portal.a, portal.portA]), keyB = JSON.stringify([portal.b, portal.portB]);
      if (!a || !b || portal.a === portal.b || matched.has(keyA) || matched.has(keyB) || JSON.stringify(a.port.centre) !== JSON.stringify(b.port.centre) || JSON.stringify(portal.centre) !== JSON.stringify(a.port.centre) || portal.width !== a.port.width || b.port.width !== portal.width ||
        !travelClear(mask, blockers, a.port.inside, b.port.inside, clearance.hunter)) errors.push('Physical portal pair is inconsistent or blocked.');
      matched.add(keyA); matched.add(keyB);
    }
    if (matched.size !== openPorts.length) errors.push('Physical portal coverage is incomplete.');
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}
