import { freePaths, triangulateFreeSpace, type FreeSpace } from '../../shared/free-space.ts';
import { bounds, rect, transform, type Shape } from '../../shared/shape.ts';
import { CLIP_SCALE } from '../../shared/shape-construction.ts';
import type { Vec2 } from '../../shared/types.ts';
import { createAccessMask, travelClear, validShape } from './geometry.ts';
import { checkedRegionCells } from './limits.ts';
import { hunterClearance, portalStands } from './portals.ts';
import type { RegionBrief } from './types.ts';

/** Undirected geometric edge, ordered by (x,y). Overlapping collinear edges are split. */
export interface CordEdge { from: Vec2; to: Vec2 }
export interface CordWitness {
  /** Root-to-terminal swept proofs, retaining the original seam stands and endpoint leads. */
  paths: Vec2[][];
  /** Unique geometric segments; only actual coincidence creates shared edges. */
  edges: CordEdge[];
}
/** Counts actual mesh constructions, travelClear calls and attempted root-to-terminal routes. */
export interface CordCounters { meshBuilds: number; sweeps: number; paths: number }
export interface CordBudget { maxMeshBuilds?: number; maxSweeps?: number; maxPaths?: number }
export type CordWitnessResult = { ok: true; witness: CordWitness; counters: CordCounters }
  | { ok: false; reason: 'budget' | 'external' | 'interior'; counters: CordCounters };

const MAX_INPUTS = 16_384, MAX_SEGMENTS = 4_096;
const same = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
const compare = (a: Vec2, b: Vec2): number => a.x - b.x || a.y - b.y;
const copy = (p: Vec2): Vec2 => ({ x: p.x, y: p.y });
const pointValid = (p: Vec2): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Bounded optional discovery (20.10), not an impossibility test. All required stands and
 * every segment, including conservative mesh entry leads, receive exact swept proof.
 * A failed call never returns a partly repaired witness. No RNG or canvas state is touched.
 */
export function discoverCordWitness(brief: RegionBrief, blockers: readonly Shape[], terminals: readonly Vec2[] = [],
  previous?: CordWitness, budget: CordBudget = {}): CordWitnessResult {
  const counters: CordCounters = { meshBuilds: 0, sweeps: 0, paths: 0 };
  const limits = { maxMeshBuilds: budget.maxMeshBuilds ?? 1, maxSweeps: budget.maxSweeps ?? 65_536, maxPaths: budget.maxPaths ?? 8_192 };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Cord budgets must be nonnegative safe integers.');
  if (!Array.isArray(blockers) || blockers.some(s => !validShape(s))) throw new Error('Cord blockers must be valid convex collision shapes.');
  if (!Array.isArray(terminals) || terminals.some(p => !pointValid(p))) throw new Error('Cord terminals must be finite points.');
  if (!Number.isFinite(brief.cellSize) || brief.cellSize <= 0) throw new Error('Cord cell size must be finite and positive.');
  if (previous && (!Array.isArray(previous.paths) || previous.paths.some(path => !Array.isArray(path) || !path.length || path.some(p => !pointValid(p)))
    || !Array.isArray(previous.edges) || previous.edges.some(edge => !edge || !pointValid(edge.from) || !pointValid(edge.to))))
    throw new Error('Previous cord paths must be nonempty lists of finite points.');
  checkedRegionCells(brief.cells);
  const radius = hunterClearance(brief.cellSize), mask = createAccessMask(brief);
  const fail = (reason: 'budget' | 'external' | 'interior'): CordWitnessResult => ({ ok: false, reason, counters });
  // Bound preprocessing, mesh complexity and graph normalization independently of caller budgets.
  if (blockers.length > MAX_INPUTS || terminals.length > MAX_INPUTS || (previous?.paths.length ?? 0) > MAX_INPUTS
    || (previous?.paths.reduce((n, p) => n + p.length, 0) ?? 0) > MAX_INPUTS
    || (previous?.edges.length ?? 0) > MAX_INPUTS
    || blockers.reduce((n, s) => n + (s.kind === 'polygon' ? s.points.length : s.kind === 'circle' ? 16 : 4), 0) > MAX_INPUTS) return fail('budget');
  // Avoid allocating millions of stands from individually legal long portal runs.
  const needsPortalStands = brief.portals.length >= 2 || terminals.length > 0;
  const standCount = !needsPortalStands ? 0 : brief.portals.reduce((n, p) =>
    n + Math.max(0, Math.ceil((p.length * brief.cellSize - 2 * radius) / (brief.cellSize / 2)) + 1), 0);
  if (standCount + terminals.length > MAX_INPUTS) return fail('budget');
  const stands = portalStands(brief).sort((a, b) => a.portal.id < b.portal.id ? -1 : a.portal.id > b.portal.id ? 1 : 0);
  const required = needsPortalStands ? stands.flatMap(s => s.points) : [];
  if (needsPortalStands && stands.some(s => !s.points.length)) return fail('external');
  if (required.length + terminals.length > MAX_INPUTS) return fail('budget');
  const shapeKey = (s: Shape): string => `${s.kind}:${s.x},${s.y}:` + (s.kind === 'rect' ? `${s.w},${s.h}`
    : s.kind === 'circle' ? `${s.r}` : s.points.map(p => `${p.x},${p.y}`).join(';'));
  blockers = [...blockers].sort((a, b) => { const ka = shapeKey(a), kb = shapeKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  let exhausted = false;
  const sweep = (a: Vec2, b: Vec2): boolean => {
    if (counters.sweeps >= limits.maxSweeps) { exhausted = true; return false; }
    counters.sweeps++;
    return travelClear(mask, blockers, a, b, radius);
  };
  const nodes: { point: Vec2; reason: 'external' | 'interior' }[] = [
    ...required.map(point => ({ point, reason: 'external' as const })),
    ...[...terminals].sort(compare).map(point => ({ point, reason: 'interior' as const })),
  ];
  for (const node of nodes) if (!sweep(node.point, node.point)) return fail(exhausted ? 'budget' : node.reason);
  const paths: Vec2[][] = [];
  const root = nodes[0]?.point;
  let mesh: FreeSpace | undefined, segments = 0;
  const oldPaths = new Map<string, Vec2[]>();
  const key = (p: Vec2): string => `${p.x},${p.y}`;
  if (root) for (const path of previous?.paths ?? []) {
    if (same(path[0]!, root)) oldPaths.set(key(path.at(-1)!), path);
    else if (same(path.at(-1)!, root)) oldPaths.set(key(path[0]!), [...path].reverse());
  }
  const proved = (path: Vec2[]): boolean => path.every((p, i) => !i || sweep(path[i - 1]!, p));
  for (const node of nodes.slice(1)) {
    const target = node.point;
    if (same(root!, target)) continue;
    if (counters.paths >= limits.maxPaths) return fail('budget');
    counters.paths++;
    let points: Vec2[] | undefined;
    const old = oldPaths.get(key(target));
    if (old && proved(old)) points = old;
    if (exhausted) return fail('budget');
    if (!points && sweep(root!, target)) points = [root!, target];
    if (exhausted) return fail('budget');
    if (!points) {
      if (!mesh) {
        if (counters.meshBuilds >= limits.maxMeshBuilds) return fail('budget');
        const box = mask.bounds, pad = 2 / CLIP_SCALE, size = mask.cellSize;
        // The mask is row-major. Padding a whole contiguous strip has the same
        // union as padding each cell separately, without sending thousands of
        // overlapping interior edges through the mesh's clipping operation.
        const domain: Shape[] = [];
        for (let i = 0; i < mask.cells.length;) {
          const first = mask.cells[i++]!;
          let end = first.x + 1;
          while (i < mask.cells.length && mask.cells[i]!.y === first.y && mask.cells[i]!.x === end) { end++; i++; }
          domain.push(rect(first.x * size - box.x - pad, first.y * size - box.y - pad, (end - first.x) * size + 2 * pad, size + 2 * pad));
        }
        const nearby = blockers.filter(s => {
          const b = bounds(s);
          return b.x <= box.x + box.w + pad && b.x + b.w >= box.x - pad && b.y <= box.y + box.h + pad && b.y + b.h >= box.y - pad;
        });
        counters.meshBuilds++;
        mesh = triangulateFreeSpace(domain, domain, nearby.map(s => transform(s, -box.x, -box.y)), radius);
      }
      const local = (p: Vec2): Vec2 => ({ x: p.x - mask.bounds.x, y: p.y - mask.bounds.y });
      // Match thorough validator's one-cell bounded entry policy and retain all its leads.
      const candidate = freePaths(mesh, local(root!), [local(target)], brief.cellSize)[0];
      if (candidate) {
        const world = candidate.points.map((p, i, all) => i === 0 ? root! : i === all.length - 1 ? target
          : { x: p.x + mask.bounds.x, y: p.y + mask.bounds.y });
        if (world.length > MAX_SEGMENTS + 1) return fail('budget');
        if (proved(world)) points = world;
      }
    }
    if (exhausted) return fail('budget');
    if (!points) return fail(node.reason);
    segments += points.length - 1;
    if (segments > MAX_SEGMENTS) return fail('budget');
    paths.push(points.map(copy));
  }
  // One optional terminal still has a clearance obligation and an explicit witness point.
  if (root && !paths.length) paths.push([copy(root)]);
  return { ok: true, witness: { paths, edges: geometricEdges(paths) }, counters };
}

/** Exact coincidence only: capsule overlap does not introduce a graph junction. */
function geometricEdges(paths: readonly Vec2[][]): CordEdge[] {
  const segments = paths.flatMap(path => path.slice(1).map((to, i) => ({ from: path[i]!, to }))).filter(s => !same(s.from, s.to));
  const endpoints = new Map<string, Vec2>();
  const pointKey = (p: Vec2): string => `${p.x},${p.y}`;
  for (const { from, to } of segments) { endpoints.set(pointKey(from), from); endpoints.set(pointKey(to), to); }
  const edges = new Map<string, CordEdge>();
  for (const { from, to } of segments) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const points = [...endpoints.values()].filter(p => (p.x - from.x) * dy === (p.y - from.y) * dx
      && p.x >= Math.min(from.x, to.x) && p.x <= Math.max(from.x, to.x) && p.y >= Math.min(from.y, to.y) && p.y <= Math.max(from.y, to.y)).sort(compare);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      edges.set(`${pointKey(a)}:${pointKey(b)}`, { from: copy(a), to: copy(b) });
    }
  }
  return [...edges.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
}
