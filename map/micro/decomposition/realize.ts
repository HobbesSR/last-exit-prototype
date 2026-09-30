import { executeDecomposition } from '../execute.ts';
import { inheritBoundaryPorts, validateBoundaryComposition } from '../boundary.ts';
import { microMetrics } from '../metrics.ts';
import { createRegionMask, elementShapes, findRegionRoute, travelClear } from '../geometry.ts';
import { spreadPoints } from '../placement.ts';
import { validateMicroRegion } from '../index.ts';
import { validateDecompositionPlan } from './validate.ts';
import { EXAMPLE_GENERATORS } from './example.ts';
import type { BuilderId, RegionPort, RegionResult, RegionRoute } from '../types.ts';
import type { Vec2 } from '../../../shared/types.ts';
import type { Dispatcher } from '../execute.ts';
import type { PortalPolicy } from './negotiate.ts';
import type { DecompositionPlan } from './types.ts';

export interface RealizedDecomposition {
  version: 'realized-decomposition-1';
  plan: DecompositionPlan;
  seed: number;
  /** The parent's external obligations; absent in artifacts that predate them. */
  external?: RegionPort[];
  assignments: Array<{ pieceId: string; generator: string; builder: BuilderId; role: string }>;
  regions: RegionResult[];
  portals: Array<{ a: string; b: string; portA: string; portB: string; centre: Vec2; width: number }>;
  anchors: Array<{ pieceId: string; point: Vec2 }>;
  routes: Array<RegionRoute & { from: string; to: string }>;
}

const MAPPING: Record<string, BuilderId> = { 'rectangular-room': 'depot', 'courtyard-ring': 'courtyard', 'generic-lobe': 'ruins', 'circulation-strip': 'entry' };
/** One centered hunter crossing per interface on its longest fitting run; every other run is sealed. */
const DEMO_PORTALS: PortalPolicy = { crossing: () => ({ required: 'hunter', allowed: 'hunter', others: 'sealed' }), connect: 'hunter' };

/** The demonstration's dispatch and portal policy, expressed through the general execution step. */
export function realizeDecomposition(plan: DecompositionPlan, options: { seed?: number; density?: number; roomBuilder?: 'depot' | 'open' | 'ruins'; ports?: RegionPort[] } = {}): RealizedDecomposition {
  const errors = validateDecompositionPlan(plan, EXAMPLE_GENERATORS);
  if (errors.length) throw new Error(`Invalid decomposition: ${errors.join(' ')}`);
  if (plan.context.entrances?.length) throw new Error('External macro entrances need an explicit adapter to become ports; pass them as `ports` instead.');
  const seed = options.seed ?? 4217, density = options.density ?? .55;
  if (!Number.isSafeInteger(seed) || !Number.isFinite(density) || density < 0 || density > 1) throw new Error('Invalid realization seed or density.');
  if (options.roomBuilder && !['depot', 'open', 'ruins'].includes(options.roomBuilder)) throw new Error('Unknown room realization.');
  const external = structuredClone(options.ports ?? []);
  const dispatch: Dispatcher = part => {
    if (!('generator' in part) && part.role !== 'residual') return null; // Reserved/forbidden ground stays outside the playable region.
    const generator = 'generator' in part ? part.generator : 'clear-residual';
    const builder = generator === 'clear-residual' ? 'entry' : generator === 'rectangular-room' && options.roomBuilder ? options.roomBuilder : MAPPING[generator];
    if (!builder) throw new Error(`No physical builder registered for ${generator}.`);
    return { builder, parameters: { density, roomCells: 4, decay: .45 }, loot: { budget: builder === 'entry' ? 0 : 3, tier: 1 }, ...(builder === 'entry' ? { entry: { count: 0 } } : {}) };
  };
  const executed = executeDecomposition(plan, { seed, bodyProfile: 'cell', ports: external, dispatch, portals: DEMO_PORTALS });
  const { layout } = executed, specs = layout.regions.map(r => r.spec);
  const assignments = executed.parts.map(p => ({ pieceId: p.id, generator: p.generator ?? 'clear-residual', builder: layout.regions.find(r => r.spec.id === p.id)!.spec.builder, role: p.role }));
  const portals: RealizedDecomposition['portals'] = [];
  for (const c of layout.connections) {
    const p = layout.regions.find(r => r.spec.id === c.a)!.ports.find(p => p.id === c.portA)!;
    if (p.required !== 'none') portals.push({ ...c, centre: p.centre, width: p.width });
  }
  const owned = new Map([...plan.pieces, ...plan.residuals].map(p => [p.id, p.cells]));
  const mask = createRegionMask({ cells: executed.parts.flatMap(p => owned.get(p.id)!), cellSize: plan.context.cellSize });
  const blockers = layout.regions.flatMap(r => r.elements.flatMap(e => elementShapes(e))), radius = microMetrics(specs[0]!).clearance.hunter;
  const anchors = layout.regions.map(region => {
    // Anchor at an inter-child crossing: its paired inside point makes the doorway an endpoint of the route.
    const point = region.ports.find(p => p.required === 'hunter' && !external.some(e => e.id === p.id))?.inside || spreadPoints(createRegionMask(region.spec), {
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
  return { version: 'realized-decomposition-1', plan: structuredClone(plan), seed, ...(external.length ? { external } : {}), assignments, regions: layout.regions, portals, anchors, routes };
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
    const parent = { cells: result.regions.flatMap(r => r.spec.cells), cellSize: result.plan.context.cellSize, bodyProfile: 'cell' as const, ports: result.external ?? [] };
    const boundary = validateBoundaryComposition(parent, result.regions.map(region => ({ ...region.spec, blockers: region.elements.flatMap(e => elementShapes(e)) })));
    errors.push(...boundary.errors.map(error => `Boundary: ${error}`));
    const inherited = inheritBoundaryPorts(parent, result.regions.map(r => r.spec));
    const internal = (region: RegionResult) => region.ports.filter(p => !inherited[region.spec.id]!.some(q => q.id === p.id));
    const openPorts = result.regions.flatMap(r => internal(r).filter(p => p.required === 'hunter').map(p => ({ region: r.spec.id, port: p }))), matched = new Set<string>();
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
