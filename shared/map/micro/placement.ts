import { circle } from '../../shape.ts';
import type { Shape } from '../../shape.ts';
import type { Vec2 } from '../../types.ts';
import { findRegionRoute, shapesOverlap, validShape } from './geometry.ts';
import type { RegionMask } from './types.ts';

const EPS = 1e-7;
const MAX_COUNT = 64;
const MAX_CANDIDATES = 16_641;

export interface SpreadPointOptions {
  count: number;
  radius: number;
  /** Optional deterministic layout variation. It only resolves equally good candidates. */
  seed?: number;
  blockers?: Shape[];
  reservations?: Shape[];
  anchor?: Vec2;
}

export interface SpreadPointResult {
  points: Vec2[];
  requested: number;
  shortfall: number;
  minimumSpacing: number | null;
}

const finitePoint = (point: Vec2): boolean => Number.isFinite(point.x) && Number.isFinite(point.y);
const squaredDistance = (a: Vec2, b: Vec2): number => {
  const x = a.x - b.x, y = a.y - b.y;
  return x * x + y * y;
};
const hash = (value: string): number => {
  let state = 2166136261;
  for (const char of value) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  state ^= state >>> 16; state = Math.imul(state, 0x7feb352d) >>> 0;
  state ^= state >>> 15; state = Math.imul(state, 0x846ca68b) >>> 0;
  return (state ^ state >>> 16) >>> 0;
};

/**
 * Deterministically spreads bounded circular occupants through a region.  The half-cell lattice
 * caps the candidate set at the same scale as the local route search, while farthest-point
 * selection makes each additional occupant as distant from the existing set as the lattice allows.
 */
export function spreadPoints(mask: RegionMask, options: SpreadPointOptions): SpreadPointResult {
  const { count, radius } = options;
  if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) throw new RangeError('placement count must be an integer from 0 through 64');
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('placement radius must be a positive finite number');
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) throw new RangeError('placement seed must be a safe integer');
  if (!Number.isFinite(mask.cellSize) || mask.cellSize <= 0) throw new RangeError('region mask cellSize must be a positive finite number');

  const blockers = options.blockers || [], reservations = options.reservations || [];
  if (![...blockers, ...reservations].every(validShape)) throw new TypeError('placement blockers and reservations must be valid shapes');
  if (options.anchor && !finitePoint(options.anchor)) throw new TypeError('placement anchor must have finite coordinates');

  const step = mask.cellSize / 2;
  const width = Math.round(mask.bounds.w / step), height = Math.round(mask.bounds.h / step);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > MAX_CANDIDATES) throw new RangeError('region mask exceeds the bounded placement grid');

  const exclusions = [...blockers, ...reservations];
  if (options.anchor) {
    const anchorDisc = circle(options.anchor.x, options.anchor.y, radius);
    if (!mask.contains(anchorDisc) || exclusions.some(shape => shapesOverlap(anchorDisc, shape))) throw new RangeError('placement anchor is not clear inside the region');
  }
  if (!count) return { points: [], requested: count, shortfall: 0, minimumSpacing: null };

  const candidates: Vec2[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = { x: mask.bounds.x + (x + .5) * step, y: mask.bounds.y + (y + .5) * step };
    const disc = circle(point.x, point.y, radius);
    if (mask.contains(disc) && !exclusions.some(shape => shapesOverlap(disc, shape))) candidates.push(point);
  }

  const centre = options.anchor || mask.cells.reduce((sum, cell) => ({
    x: sum.x + (cell.x + .5) * mask.cellSize,
    y: sum.y + (cell.y + .5) * mask.cellSize,
  }), { x: 0, y: 0 });
  if (!options.anchor && mask.cells.length) { centre.x /= mask.cells.length; centre.y /= mask.cells.length; }

  const available = new Uint8Array(candidates.length).fill(1);
  const nearest = new Float64Array(candidates.length).fill(Infinity);
  // Candidate order remains canonical. A seed only chooses between positions that have
  // the same farthest-point score, so it cannot weaken spacing or reachability.
  const tieBreakers = options.seed === undefined ? undefined : candidates.map(point => hash(`${options.seed}:${point.x}:${point.y}`));
  const points: Vec2[] = [];
  const spacingSquared = (radius * 2) ** 2;

  while (points.length < count) {
    let chosen = -1, score = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (!available[i]) continue;
      const candidateScore = points.length ? nearest[i] : -squaredDistance(candidates[i], centre);
      if (candidateScore > score + EPS || Math.abs(candidateScore - score) <= EPS && chosen >= 0 && tieBreakers && (tieBreakers[i]! > tieBreakers[chosen]! || tieBreakers[i] === tieBreakers[chosen] && i < chosen)) {
        chosen = i; score = candidateScore;
      }
    }
    if (chosen < 0) break;

    const point = candidates[chosen];
    available[chosen] = 0;
    if (points.length && score + EPS < spacingSquared) break;
    // Route checks run only for the current best candidate.  Failed candidates are discarded,
    // preserving the deterministic ranking without paying for a route from every lattice point.
    if (options.anchor && !findRegionRoute(mask, blockers, options.anchor, point, radius)) continue;

    points.push(point);
    for (let i = 0; i < candidates.length; i++) if (available[i]) nearest[i] = Math.min(nearest[i], squaredDistance(candidates[i], point));
  }

  let minimumSpacing: number | null = null;
  for (let i = 0; i < points.length; i++) for (let j = 0; j < i; j++) {
    const distance = Math.sqrt(squaredDistance(points[i], points[j]));
    minimumSpacing = minimumSpacing === null ? distance : Math.min(minimumSpacing, distance);
  }
  return { points, requested: count, shortfall: count - points.length, minimumSpacing };
}
