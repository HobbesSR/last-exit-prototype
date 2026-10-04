import { resolveAccessRequirements, validateRegionAccess } from './access.ts';
import { circle, rect } from '../../shared/shape.ts';
import type { Shape } from '../../shared/shape.ts';
import type { Vec2 } from '../../shared/types.ts';
import { microMetrics } from './metrics.ts';
import { spreadPoints } from './placement.ts';
import { BUILDERS } from './builders.ts';
import { capsule, createRegionMask, elementShapes, findRegionRoute, shapesOverlap, travelClear } from './geometry.ts';
import { portalStands } from './portals.ts';
import { checkedRegionCells, LIMITS } from './limits.ts';
import { CORE_ELEMENT_KINDS } from '../kernel/contract.ts';
import { isCellSize } from '../kernel/scale.ts';
import type { BuilderContext, BuilderId, BuiltRegion, CoreElementKind, CoreElementSite, Portal, RegionBrief, RegionElement, RegionMask, RegionRandom, MicroResult, RegionRoute, RegionSpec, ResolvedPort } from './types.ts';
export type { RegionSpec, MicroResult } from './types.ts';

const RANK = { none: 0, contestant: 1, hunter: 2 };
const WALL = 8;
const normal = { N: { x: 0, y: 1 }, S: { x: 0, y: -1 }, W: { x: 1, y: 0 }, E: { x: -1, y: 0 } };

function checkedSpec(input: RegionSpec): RegionSpec {
  if (!input || typeof input.id !== 'string' || !input.id.length || input.id.length > 100 || !Number.isSafeInteger(input.seed)) throw new Error('A region needs a stable id and integer seed.');
  if (!Object.hasOwn(BUILDERS, input.builder)) throw new Error('Unknown micro builder.');
  if (input.bodyProfile !== undefined && !['live', 'cell'].includes(input.bodyProfile)) throw new Error('Unknown body profile.');
  if (input.entry && (input.builder !== 'entry' || !Number.isInteger(input.entry.count) || input.entry.count < 0 || input.entry.count > 64)) throw new Error('Entry count must be from 0 to 64 on an entry region.');
  if (!isCellSize(input.cellSize) || input.cellSize < 24 || input.cellSize > 200) throw new Error('Cell size must be a whole number from 24 to 200 world units.');
  const spec = { ...structuredClone(input), cells: checkedRegionCells(input.cells) }, mask = createRegionMask(spec);
  if (!Array.isArray(spec.ports) || spec.ports.length > LIMITS.portals) throw new Error('Ports must be a bounded list.');
  for (const [key, low, high] of [['density', 0, 1], ['roomCells', 4, 12], ['decay', 0, 1]] as const) {
    const value = spec.parameters?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value < low || value > high || key === 'roomCells' && !Number.isInteger(value))) throw new Error(`Invalid ${key} parameter.`);
  }
  if (spec.loot && (!Number.isInteger(spec.loot.budget) || spec.loot.budget < 0 || spec.loot.budget > 64 || !Number.isInteger(spec.loot.tier) || spec.loot.tier < 1 || spec.loot.tier > 5)) throw new Error('Loot needs a budget from 0 to 64 and a tier from 1 to 5.');
  if (spec.reservations && (!Array.isArray(spec.reservations) || spec.reservations.length > 64 || spec.reservations.some(b => !mask.contains(rect(b.x, b.y, b.w, b.h))))) throw new Error('Reservations must be contained positive boxes.');
  return spec;
}

/** Explicit boundary runs are the only boundaries that emit walls. Unstated edges stay empty. */
function resolvePorts(spec: RegionSpec, mask: RegionMask): { ports: ResolvedPort[]; elements: RegionElement[] } {
  const ports = resolveAccessRequirements(spec), elements: RegionElement[] = [];
  for (const p of ports) {
    const horizontal = p.side === 'N' || p.side === 'S', size = spec.cellSize;
    const span = p.length * size, width = p.width;
    const x = p.start.x * size + (p.side === 'E' ? size : 0), y = p.start.y * size + (p.side === 'S' ? size : 0);
    const parts: RegionElement['template']['parts'] = [];
    for (const [start, length] of width ? [[0, (span - width) / 2], [(span + width) / 2, (span - width) / 2]] : [[0, span]]) {
      if (length <= 0) continue;
      const shape = horizontal ? rect(x + start, y + (p.side === 'S' ? -WALL : 0), length, WALL) : rect(x + (p.side === 'E' ? -WALL : 0), y + start, WALL, length);
      if (!mask.contains(shape)) throw new Error(`Port ${p.id} cannot fit its boundary geometry.`);
      parts.push({ part: 'obstacle', shape, kind: 'ruin-wall' });
    }
    elements.push({ label: `port:${p.id}`, x: 0, y: 0, template: { w: mask.bounds.w, h: mask.bounds.h, parts } });
  }
  return { ports, elements };
}

/** A named, seeded random stream. Streams with different names are independent. */
export function rng(seed: number, name: string): RegionRandom {
  let state = seed >>> 0;
  for (const char of name) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  const next = () => { state = state + 0x6D2B79F5 | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  return { next, int: (min, max) => min + Math.floor(next() * (max - min + 1)), shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy;
  } };
}

/** Entry points see only geometry and macro reservations; loot is placed around them afterwards. */
function entryPoints(spec: RegionSpec, mask: RegionMask, elements: RegionElement[], root: Vec2 | undefined) {
  return spreadPoints(mask, { count: spec.entry?.count ?? 24, radius: microMetrics(spec).clearance.contestant, seed: spec.seed,
    blockers: elements.flatMap(e => elementShapes(e, true)), reservations: (spec.reservations || []).map(b => rect(b.x, b.y, b.w, b.h)), ...(root ? { anchor: root } : {}) });
}

/**
 * What a brief adds to the example generator. Portals are kept, never walled; core elements
 * are sited before the loot fill; loot follows each cell's zone.
 */
interface BriefTerms {
  portals: Portal[];
  coreElements: Array<[CoreElementKind, number]>;
  zoneAt(x: number, y: number): { tier: number; lootChance: number };
}

export function generateMicroRegion(input: RegionSpec): MicroResult {
  const { result } = generate(checkedSpec(input));
  const errors = validateMicroRegion(result);
  if (errors.length) throw new Error(errors.join(' '));
  return result;
}

/**
 * An example strategy (51 stage 6): today's builder fills a checked brief. It protects
 * its portals while it builds, as a heuristic, and doesn't check the result: a builder
 * checks its promise electively, in its tests (`validatePortalReach`).
 */
export function generateBriefRegion(brief: RegionBrief, builder: BuilderId): BuiltRegion {
  const numeric = (key: string) => typeof brief.parameters?.[key] === 'number' ? { [key]: brief.parameters[key] as number } : {};
  const parameters = { ...numeric('density'), ...numeric('roomCells'), ...numeric('decay') };
  // Loot has no budget in a brief, only each cell's chance, so the cap is the tool limit.
  const spec = checkedSpec({ id: brief.id, seed: brief.seed, builder, cellSize: brief.cellSize, bodyProfile: 'cell', cells: brief.cells, ports: [],
    ...(Object.keys(parameters).length ? { parameters } : {}), loot: { budget: 64, tier: 1 } });
  const zones = new Map(brief.zones.flatMap(zone => zone.cells.map(c => [`${c.x},${c.y}`, zone] as const)));
  const coreElements = CORE_ELEMENT_KINDS.flatMap(kind => brief.coreElements?.[kind] ? [[kind, brief.coreElements[kind]!] as [CoreElementKind, number]] : []);
  const { result, coreElements: sites } = generate(spec, { portals: brief.portals, coreElements, zoneAt: (x, y) => zones.get(`${x},${y}`)! });
  const { builder: _, ...counts } = result.manifest;
  return { version: 'region-2', brief: structuredClone(brief), elements: result.elements, coreElements: sites, loot: result.loot,
    manifest: { ...counts, coreElements: sites.length } };
}

function generate(spec: RegionSpec, terms?: BriefTerms): { result: MicroResult; coreElements: CoreElementSite[] } {
  const mask = createRegionMask(spec), resolved = resolvePorts(spec, mask);
  const metrics = microMetrics(spec), radii = metrics.clearance;
  const elements = resolved.elements, ports = resolved.ports, routes: RegionRoute[] = [], blockers = elements.flatMap(e => elementShapes(e));
  const protectedShapes: Shape[] = (spec.reservations || []).map(b => rect(b.x, b.y, b.w, b.h));
  const protect = (points: Vec2[], role: RegionRoute['role']) => {
    const radius = radii[role]; routes.push({ role, radius, points });
    for (let i = 1; i < points.length; i++) protectedShapes.push(...capsule(points[i - 1], points[i], radius + 1));
  };
  for (const role of ['hunter', 'contestant'] as const) {
    const required = ports.filter(p => RANK[p.required] >= RANK[role]);
    for (const p of required) {
      if (!travelClear(mask, blockers, p.inside, p.inside, radii[role])) throw new Error(`Port ${p.id} lacks standing room for ${role}.`);
      protectedShapes.push(circle(p.inside.x, p.inside.y, radii[role] + 1));
      if (p === required[0]) continue;
      const path = findRegionRoute(mask, blockers, required[0].inside, p.inside, radii[role]);
      if (!path) throw new Error(`Required ${role} ports cannot connect inside region ${spec.id}.`);
      protect(path, role);
    }
  }
  // Reserve the full approach, including the threshold where a body straddles the boundary.
  for (const p of ports) if (p.allowed !== 'none') {
    for (const s of capsule(p.centre, p.inside, radii[p.allowed] + 1)) protectedShapes.push(s);
  }
  // A brief's portals: keep every hunter stand along each one clear, and a hunter route between them.
  // A stand or a route missing here is the brief's promise already broken, so this fails explicitly
  // rather than emitting a region that doesn't keep it (51 principle 9).
  const standList = terms ? portalStands({ ...spec, portals: terms.portals }, mask) : [];
  for (const { portal, points } of standList) {
    if (!points.length) throw new Error(`Brief portal ${portal.id} is too short for a hunter.`);
    if (!travelClear(mask, blockers, points[0]!, points[0]!, radii.hunter)) throw new Error(`Brief portal ${portal.id} lacks standing room for a hunter.`);
  }
  for (const { points } of standList) protectedShapes.push(...capsule(points[0]!, points.at(-1)!, radii.hunter + 1));
  for (const { portal, points } of standList.slice(1)) {
    const path = findRegionRoute(mask, blockers, standList[0]!.points[0]!, points[0]!, radii.hunter);
    if (!path) throw new Error(`Brief portal ${portal.id} cannot connect to ${standList[0]!.portal.id} inside region ${spec.id}.`);
    protect(path, 'hunter');
  }
  const loot: MicroResult['loot'] = [], lootCells = new Set<string>(), spawns: Shape[] = [];
  const occupied = elements.flatMap(e => elementShapes(e, true));
  let attempted = 0, rejected = 0;
  const root = ports.find(p => p.required !== 'none')?.inside ?? standList[0]?.points[0];
  // Loot chance is per cell (51 stage 5): each cell rolls once, on its first offer, and every
  // later offer reuses that roll, so a cell offered twice gets no second chance.
  const zoneLoot = terms ? rng(spec.seed, `${spec.id}:zone-loot`) : undefined, rolled = new Map<string, boolean>();
  const context: BuilderContext = {
    spec, mask, random: channel => rng(spec.seed, `${spec.id}:${channel}`),
    element(label, template, x, y) {
      attempted++;
      const element = { label, template: structuredClone(template), x, y }, shapes = elementShapes(element, true);
      const footprintOK = !template.encloses || mask.contains(rect(x, y, template.w, template.h));
      const spotsOK = template.parts.every(p => p.part !== 'spot' || mask.contains(circle(x + p.x, y + p.y, 1)));
      // Template reservations cannot bypass the macro contract; they too must fit.
      const reserves = template.parts.filter(p => p.part === 'reserve').map(p => rect(x + p.x, y + p.y, p.w, p.h));
      const claim = template.encloses ? [rect(x, y, template.w, template.h)] : shapes;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !footprintOK || !spotsOK || [...shapes, ...reserves].some(s => !mask.contains(s)) || claim.some(s => occupied.some(o => shapesOverlap(s, o))) || shapes.some(s => protectedShapes.some(o => shapesOverlap(s, o)))) { rejected++; return false; }
      elements.push(element); blockers.push(...elementShapes(element)); occupied.push(...claim); protectedShapes.push(...reserves);
      return true;
    },
    obstacle(label, shape, kind) { return context.element(label, { w: mask.bounds.w, h: mask.bounds.h, parts: [{ part: 'obstacle', shape, kind }] }, 0, 0); },
    loot(x, y) {
      if (loot.length >= (spec.loot?.budget ?? 8) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      // Every offer obeys its cell's chance, whether the builder made it or the remaining-loot fill did.
      const key = `${Math.floor(x / spec.cellSize)},${Math.floor(y / spec.cellSize)}`, disc = circle(x, y, metrics.lootRadius);
      const zone = terms?.zoneAt(Math.floor(x / spec.cellSize), Math.floor(y / spec.cellSize));
      if (terms) {
        if (!zone) return false;
        if (!rolled.has(key)) rolled.set(key, zoneLoot!.next() < zone.lootChance);
        if (!rolled.get(key)) return false;
      }
      if (lootCells.has(key) || !mask.contains(disc) || elements.flatMap(e => elementShapes(e, true)).some(s => shapesOverlap(disc, s)) || (spec.reservations || []).some(b => shapesOverlap(disc, rect(b.x, b.y, b.w, b.h))) || spawns.some(s => shapesOverlap(disc, s))) return false;
      const path = root && findRegionRoute(mask, blockers, root, { x, y }, radii.contestant);
      if (root && !path) return false;
      if (path) protect(path, 'contestant');
      const tier = zone ? zone.tier : spec.loot?.tier ?? 1;
      lootCells.add(key); loot.push({ x, y, tier }); protectedShapes.push(disc);
      return true;
    },
  };
  BUILDERS[spec.builder](context);
  // Spawning is what an entry region is for, so its points claim ground before the loot fill.
  const entry = !terms && spec.builder === 'entry' ? entryPoints(spec, mask, elements, root) : undefined;
  spawns.push(...(entry?.points || []).map(p => circle(p.x, p.y, radii.contestant)));
  // A brief's core elements are its region's guarantees too, so they are sited first in the same way, kind by kind.
  // Loot the builder already placed reserves its ground here too, since a builder's loot calls
  // can land before this runs.
  const coreElements: CoreElementSite[] = [];
  for (const [kind, count] of terms?.coreElements ?? []) {
    const radius = kind === 'hunter-spawn' ? radii.hunter : radii.contestant;
    const placed = spreadPoints(mask, { count, radius, seed: spec.seed, blockers: elements.flatMap(e => elementShapes(e, true)),
      reservations: [...spawns, ...loot.map(l => circle(l.x, l.y, metrics.lootRadius))], ...(root ? { anchor: root } : {}) });
    coreElements.push(...placed.points.map(p => ({ kind, x: p.x, y: p.y })));
    spawns.push(...placed.points.map(p => circle(p.x, p.y, radius)));
  }
  const lootRandom = context.random('remaining-loot');
  for (const c of lootRandom.shuffle(mask.cells)) {
    if (loot.length >= (spec.loot?.budget ?? 8)) break;
    context.loot((c.x + 0.35 + lootRandom.next() * 0.3) * spec.cellSize, (c.y + 0.35 + lootRandom.next() * 0.3) * spec.cellSize);
  }
  const parts = elements.flatMap(e => e.template.parts);
  const result: MicroResult = { version: 'micro-1', spec, bounds: mask.bounds, ports, routes, elements, loot,
    ...(entry ? { entry } : {}),
    manifest: { builder: spec.builder, cells: mask.cells.length, structures: elements.filter(e => e.template.encloses).length,
      obstacles: parts.filter(p => p.part === 'obstacle').length, gates: parts.filter(p => p.part === 'gate').length, loot: loot.length, attempted, rejected } };
  return { result, coreElements };
}

/** Recompute physical claims from emitted geometry; never trust the manifest or saved routes. */
export function validateMicroRegion(result: MicroResult): string[] {
  const errors: string[] = [];
  try {
    if (result.version !== 'micro-1') throw new Error('Unsupported micro artifact version.');
    const spec = checkedSpec(result.spec), mask = createRegionMask(spec), { ports, elements: boundaries } = resolvePorts(spec, mask);
    const metrics = microMetrics(spec), radii = metrics.clearance;
    const blockers = result.elements.flatMap(e => elementShapes(e)), allGeometry = result.elements.flatMap(e => elementShapes(e, true));
    if (JSON.stringify(result.ports) !== JSON.stringify(ports)) errors.push('Resolved port metadata disagrees with the macro contract.');
    for (const boundary of boundaries) if (!result.elements.some(e => JSON.stringify(e) === JSON.stringify(boundary))) errors.push(`Boundary contract geometry changed: ${boundary.label}.`);
    if (result.elements.some(e => e.template.encloses && !mask.contains(rect(e.x, e.y, e.template.w, e.template.h))) || result.elements.flatMap(e => elementShapes(e, true)).some(s => !mask.contains(s))) errors.push('Geometry leaves the owned region or is not a valid convex shape.');
    for (const e of result.elements) for (const p of e.template.parts) {
      if (p.part === 'reserve' && !mask.contains(rect(e.x + p.x, e.y + p.y, p.w, p.h)) || p.part === 'spot' && !mask.contains(circle(e.x + p.x, e.y + p.y, 1))) errors.push('Template metadata leaves its region.');
    }
    for (const b of spec.reservations || []) if (allGeometry.some(s => shapesOverlap(s, rect(b.x, b.y, b.w, b.h)))) errors.push('Geometry obstructs a macro reservation.');
    errors.push(...validateRegionAccess({ ...spec, blockers }).errors);
    const keys = new Set<string>(), root = ports.find(p => p.required !== 'none')?.inside;
    for (const p of result.loot) {
      const key = `${Math.floor(p.x / spec.cellSize)},${Math.floor(p.y / spec.cellSize)}`;
      if (keys.has(key)) errors.push('More than one loot spawn occupies a cell.');
      keys.add(key);
      if (p.tier !== (spec.loot?.tier ?? 1)) errors.push('Loot tier disagrees with the macro contract.');
      if (!mask.contains(circle(p.x, p.y, metrics.lootRadius)) || allGeometry.some(s => shapesOverlap(circle(p.x, p.y, metrics.lootRadius), s))) errors.push('Loot lacks standing room.');
      if ((spec.reservations || []).some(b => shapesOverlap(circle(p.x, p.y, metrics.lootRadius), rect(b.x, b.y, b.w, b.h)))) errors.push('Loot occupies a macro reservation.');
      if (root && !findRegionRoute(mask, blockers, root, p, radii.contestant)) errors.push('Loot is unreachable from required entrances.');
    }
    if (result.loot.length > (spec.loot?.budget ?? 8)) errors.push('Loot exceeds the macro budget.');
    if (spec.builder === 'entry') {
      const expected = entryPoints(spec, mask, result.elements, root);
      if (JSON.stringify(result.entry) !== JSON.stringify(expected)) errors.push('Entry placement disagrees with clear, spaced positions.');
      if (result.loot.some(p => expected.points.some(q => shapesOverlap(circle(p.x, p.y, metrics.lootRadius), circle(q.x, q.y, radii.contestant))))) errors.push('Loot occupies an entry point.');
    } else if (result.entry !== undefined) errors.push('Unexpected entry placement on a non-entry region.');
    for (const route of result.routes) {
      if (!Object.hasOwn(radii, route.role) || route.radius !== radii[route.role] || !route.points.length) { errors.push('Invalid recorded clearance route.'); continue; }
      for (let i = 1; i < route.points.length; i++) if (!travelClear(mask, blockers, route.points[i - 1], route.points[i], route.radius)) errors.push('Recorded route crosses obstructed ground.');
    }
    const parts = result.elements.flatMap(e => e.template.parts);
    const counts = { builder: spec.builder, cells: spec.cells.length, structures: result.elements.filter(e => e.template.encloses).length,
      obstacles: parts.filter(p => p.part === 'obstacle').length, gates: parts.filter(p => p.part === 'gate').length, loot: result.loot.length };
    if (Object.entries(counts).some(([key, value]) => result.manifest[key as keyof typeof counts] !== value)) errors.push('Manifest disagrees with emitted geometry.');
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}
