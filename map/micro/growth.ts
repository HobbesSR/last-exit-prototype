import { rect, type Shape } from '../../shared/shape.ts';
import { compareCells } from '../kernel/cell.ts';
import { ownedOf, stretchesOf } from './hints.ts';
import type { ParcelHandle, ParcelProposal, ProspectiveParcels } from './prospective-parcels.ts';
import type { Cell, RegionBrief } from './types.ts';

/*
 * Optional growth helpers over the prospective-parcels coordinator (20.10, #649). Each helper
 * grows one parcel by probing candidate additions and accepting what the coordinator admits:
 * a candidate that meets the live cord either moves it or is refused atomically. Builders own
 * where growth starts, candidate order, sizes and when to stop, and may write their own loop
 * over `probeClaim`/`acceptClaim` instead. Work is bounded by attempt counts, never by time.
 */

export type GrowthRefusal = 'allocation' | 'canvas' | 'budget' | 'external' | 'interior' | 'handle';
/**
 * Why growth stopped: `done` when the candidates ran out, `refused` when every candidate of a
 * step was refused, `attempts` or `steps` when a limit was reached first.
 */
export type GrowthStop = 'done' | 'refused' | 'attempts' | 'steps';
export interface GrowthLimits { attempts?: number; steps?: number }
export interface GrowthReport<T> {
  /** The grown parcel, or null if nothing was admitted. */
  handle: ParcelHandle | null;
  /** The accepted candidates' values, in order. */
  taken: T[];
  /** Probes made, admitted or not. */
  attempts: number;
  refusals: Partial<Record<GrowthRefusal, number>>;
  stop: GrowthStop;
}
/** One candidate addition: its shapes (cells, boxes or polygons) and the caller's own record of it. */
export interface GrowthCandidate<T> { shapes: readonly Shape[]; value: T }

const DEFAULT_ATTEMPTS = 256, DEFAULT_STEPS = 256;
const limitOf = (value: number | undefined, fallback: number, name: string) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Growth ${name} must be a nonnegative safe integer.`);
  return n;
};
const refuse = (refusals: GrowthReport<unknown>['refusals'], reason: string) => {
  refusals[reason as GrowthRefusal] = (refusals[reason as GrowthRefusal] ?? 0) + 1;
};

/**
 * Grow one parcel step by step. `next(taken)` lists the next step's candidates in the order to
 * try, given the values accepted so far; the first admitted is accepted and extends the parcel.
 * An empty list ends growth. Every probe reads the current revision, so acceptance never goes
 * stale, and a refused probe changes nothing.
 */
export function growParcel<T>(coordinator: ProspectiveParcels, next: (taken: readonly T[]) => readonly GrowthCandidate<T>[],
  limits: GrowthLimits = {}): GrowthReport<T> {
  const maxAttempts = limitOf(limits.attempts, DEFAULT_ATTEMPTS, 'attempts'), maxSteps = limitOf(limits.steps, DEFAULT_STEPS, 'steps');
  const report: GrowthReport<T> = { handle: null, taken: [], attempts: 0, refusals: {}, stop: 'done' };
  while (true) {
    if (report.taken.length === maxSteps) return { ...report, stop: 'steps' };
    const candidates = next(report.taken);
    if (!candidates.length) return report;
    let admitted: { proposal: ParcelProposal; value: T } | null = null;
    for (const { shapes, value } of candidates) {
      if (report.attempts === maxAttempts) return { ...report, stop: 'attempts' };
      report.attempts++;
      const probed = coordinator.probeClaim(shapes, report.handle ?? undefined);
      if (probed.ok) { admitted = { proposal: probed.proposal, value }; break; }
      refuse(report.refusals, probed.reason);
    }
    if (!admitted) return { ...report, stop: 'refused' };
    const accepted = coordinator.acceptClaim(admitted.proposal);
    if (!accepted.ok) throw new Error(`A probe of the current revision was refused on acceptance (${accepted.reason}).`);
    report.handle = accepted.handle;
    report.taken.push(admitted.value);
  }
}

const cellShapes = (cells: readonly Cell[], size: number): Shape[] => cells.map(c => rect(c.x * size, c.y * size, size, size));
const keyOf = (c: Cell) => `${c.x},${c.y}`;
/** North, east, south, west. */
const SIDES: readonly Cell[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

export interface SeedOptions extends GrowthLimits {
  /** Directions to try each step after the whole ring, in order; by default north, east, south, west. */
  order?: readonly Cell[];
  /** Builder pruning: a cell the seed may take. Fill membership and canvas checks still apply. */
  admit?: (cell: Cell) => boolean;
}

/**
 * Expand an interior seed outward (20.10's interior-first workflow). The seed cells are the
 * first claim. Each later step offers the whole ring of fill cells around the parcel, then the
 * layer on each side in `order`, so a seed pressed against a cord keeps growing on its free
 * sides. Nothing requires the seed to touch an edge. `cells` are the parcel's cells.
 */
export function growSeed(coordinator: ProspectiveParcels, seed: readonly Cell[], options: SeedOptions = {}): GrowthReport<Cell[]> & { cells: Cell[] } {
  const fill = coordinator.fill, size = fill.cellSize, admit = options.admit ?? (() => true), order = options.order ?? SIDES;
  if (!seed.length) throw new TypeError('A seed needs at least one cell.');
  const report = growParcel<Cell[]>(coordinator, taken => {
    if (!taken.length) return [{ shapes: cellShapes(seed, size), value: [...seed] }];
    const grown = new Set(taken.flat().map(keyOf));
    const layer = (dirs: readonly Cell[]) => {
      const found = new Map<string, Cell>();
      for (const k of grown) {
        const [x, y] = k.split(',').map(Number) as [number, number];
        for (const d of dirs) {
          const n = { x: x + d.x, y: y + d.y };
          if (!grown.has(keyOf(n)) && fill.has(n.x, n.y) && admit(n)) found.set(keyOf(n), n);
        }
      }
      return [...found.values()].sort(compareCells);
    };
    const seen = new Set<string>();
    return [layer(SIDES), ...order.map(d => layer([d]))]
      .filter(cells => { const k = cells.map(keyOf).join(';'); return cells.length > 0 && !seen.has(k) && !!seen.add(k); })
      .map(cells => ({ shapes: cellShapes(cells, size), value: cells }));
  }, options);
  return { ...report, cells: report.taken.flat().sort(compareCells) };
}

export interface FrontOptions {
  /** Cells across the front, from the root along the edge in the positive axis direction. Default 1. */
  width?: number;
  /** The deepest front to try, in cells. Default: as deep as the fill reaches. */
  depth?: number;
  /** Probes to spend. Default 32. */
  attempts?: number;
  /** Builder pruning: a cell the front may take. The front stops before the first refused row. */
  admit?: (cell: Cell) => boolean;
}
export interface FrontReport {
  handle: ParcelHandle | null;
  /** The depth admitted, in cells: a verified lower bound, not the deepest possible. */
  depth: number;
  /** The deepest depth the fill and `admit` allowed. */
  reach: number;
  cells: Cell[];
  attempts: number;
  refusals: Partial<Record<GrowthRefusal, number>>;
}

/**
 * Grow a straight front from `root` in direction `inward`, as deep as the coordinator admits,
 * in one claim. Depths are bisected against one revision: every probe is a fresh claim of that
 * depth, the deepest admitted proposal is kept and accepted at the end. Rounding and bounded
 * search make admission non-monotone, so the result is a verified lower bound only (20.10).
 */
export function growFront(coordinator: ProspectiveParcels, root: Cell, inward: Cell, options: FrontOptions = {}): FrontReport {
  if (Math.abs(inward.x) + Math.abs(inward.y) !== 1) throw new TypeError('A front grows along one axis.');
  const fill = coordinator.fill, size = fill.cellSize, admit = options.admit ?? (() => true);
  const width = options.width ?? 1, attempts = limitOf(options.attempts, 32, 'attempts');
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError('A front needs a positive whole width.');
  const across = { x: Math.abs(inward.y), y: Math.abs(inward.x) };
  const row = (d: number) => Array.from({ length: width }, (_, k) => ({ x: root.x + inward.x * d + across.x * k, y: root.y + inward.y * d + across.y * k }));
  const cap = options.depth ?? Infinity;
  let reach = 0;
  while (reach < cap && row(reach).every(c => fill.has(c.x, c.y) && admit(c))) reach++;
  const cellsTo = (depth: number) => Array.from({ length: depth }, (_, d) => row(d)).flat().sort(compareCells);
  const report: FrontReport = { handle: null, depth: 0, reach, cells: [], attempts: 0, refusals: {} };
  let best: ParcelProposal | null = null;
  const probe = (depth: number) => {
    report.attempts++;
    const probed = coordinator.probeClaim(cellShapes(cellsTo(depth), size));
    if (probed.ok) { best = probed.proposal; report.depth = depth; return true; }
    refuse(report.refusals, probed.reason);
    return false;
  };
  // Full depth first: a front that the cord can pass entirely costs one probe.
  if (reach > 0 && report.attempts < attempts && !probe(reach)) {
    let lo = 0, hi = reach - 1;
    while (lo < hi && report.attempts < attempts) {
      const mid = Math.ceil((lo + hi) / 2);
      if (probe(mid)) lo = mid; else hi = mid - 1;
    }
  }
  if (!best) return report;
  const accepted = coordinator.acceptClaim(best);
  if (!accepted.ok) throw new Error(`A probe of the current revision was refused on acceptance (${accepted.reason}).`);
  return { ...report, handle: accepted.handle, cells: cellsTo(report.depth) };
}

/** A fill cell on the fill's edge, and which way the fill lies from that edge. */
export interface FrontStart {
  cell: Cell;
  inward: Cell;
  /** `region` when the cell beyond is outside the region; `clear` when it is the region's own clear margin. */
  beyond: 'region' | 'clear';
  /** The edge lies on a placement hint. */
  hinted: boolean;
}

/**
 * Every place a front could start: each side of a fill cell whose neighbour is not fill, in
 * canonical cell order, then north, east, south, west. A corner cell yields one per open side.
 * Starting anywhere else, or nowhere, is equally the builder's choice.
 */
export function frontStarts(brief: RegionBrief, fill: ProspectiveParcels['fill']): FrontStart[] {
  const owned = ownedOf(brief), hinted = new Set<string>();
  for (const hint of brief.hints ?? []) for (const s of stretchesOf(hint, owned)) hinted.add(`${keyOf(s.cell)}:${keyOf(s.inward)}`);
  const starts: FrontStart[] = [];
  for (const cell of [...fill.cells].sort(compareCells)) for (const d of SIDES) {
    const beyond = { x: cell.x + d.x, y: cell.y + d.y };
    if (fill.has(beyond.x, beyond.y)) continue;
    const inward = { x: -d.x, y: -d.y };
    starts.push({ cell: { x: cell.x, y: cell.y }, inward, beyond: owned.has(keyOf(beyond)) ? 'clear' : 'region',
      hinted: hinted.has(`${keyOf(cell)}:${keyOf(inward)}`) });
  }
  return starts;
}

/**
 * Block's conservative portal setback (20.10, 20.6) as optional pruning: the cells within
 * `depth` cells (Chebyshev) of any portal's inside cells, which a front beside the portal
 * could use to pinch the turn beyond its end cap. Swept proof still decides clearance.
 */
export function portalSetback(brief: RegionBrief, depth = 2): Set<string> {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new RangeError('A setback needs a whole depth.');
  const owned = ownedOf(brief), near = new Set<string>();
  for (const portal of brief.portals) for (const { cell } of stretchesOf(portal, owned))
    for (let dy = -depth; dy <= depth; dy++) for (let dx = -depth; dx <= depth; dx++) {
      const k = keyOf({ x: cell.x + dx, y: cell.y + dy });
      if (owned.has(k)) near.add(k);
    }
  return near;
}
