import { freePaths, triangulateFreeSpace, type FreeSpace } from '../../shared/free-space.ts';
import { bounds, rect, transform, type Shape } from '../../shared/shape.ts';
import { CLIP_SCALE } from '../../shared/shape-construction.ts';
import type { Vec2 } from '../../shared/types.ts';
import { capsule, createAccessMask, shapesOverlap, travelClear, validShape } from './geometry.ts';
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
export interface CordBudget { maxMeshBuilds?: number; maxSweeps?: number; maxPaths?: number; maxSegments?: number }
export type CordWitnessResult = { ok: true; witness: CordWitness; counters: CordCounters }
  | { ok: false; reason: 'budget' | 'external' | 'interior'; counters: CordCounters };

const MAX_INPUTS = 16_384, MAX_SEGMENTS = 4_096;
/**
 * Path segments for scatter builders on a live cord (park, rubble, plant): winding cords to every
 * stand of a many-portal region pass the default of 4,096. It is a tool limit, not a contract
 * (20.10); callers that don't pass it keep the default.
 */
export const SCATTER_CORD_BUDGET: Readonly<CordBudget> = Object.freeze({ maxSegments: 16_384 });
const same = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
const compare = (a: Vec2, b: Vec2): number => a.x - b.x || a.y - b.y;
const copy = (p: Vec2): Vec2 => ({ x: p.x, y: p.y });
const pointValid = (p: Vec2): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Bounded optional discovery (20.10), not an impossibility test. All required stands and
 * every segment, including conservative mesh entry leads, receive exact swept proof.
 * A failed call never returns a partly repaired witness. No RNG or canvas state is touched.
 *
 * `added` is a promise from the caller: `previous` was proved on this brief against every
 * blocker but these. A stand or old segment whose swept capsule misses all of them still passes
 * (`travelClear` is capsule overlap), so it is not swept again; the witness is the one a full
 * re-proof would find, at less cost and with fewer sweeps counted.
 */
export function discoverCordWitness(brief: RegionBrief, blockers: readonly Shape[], terminals: readonly Vec2[] = [],
  previous?: CordWitness, budget: CordBudget = {}, added?: readonly Shape[]): CordWitnessResult {
  const counters: CordCounters = { meshBuilds: 0, sweeps: 0, paths: 0 };
  const limits = { maxMeshBuilds: budget.maxMeshBuilds ?? 1, maxSweeps: budget.maxSweeps ?? 65_536, maxPaths: budget.maxPaths ?? 8_192,
    maxSegments: budget.maxSegments ?? MAX_SEGMENTS };
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
  // Blockers filed by a coarse grid of their bounds, so a sweep tests only those its capsule's box
  // can reach. `travelClear` is the same test over that subset: a blocker whose box misses the
  // capsule's cannot overlap it (#787). Its order is the sorted order, as before.
  const grid = 4 * brief.cellSize, filed = new Map<string, number[]>();
  const boxes = blockers.map(bounds);
  boxes.forEach((b, i) => {
    for (let y = Math.floor(b.y / grid); y <= Math.floor((b.y + b.h) / grid); y++)
      for (let x = Math.floor(b.x / grid); x <= Math.floor((b.x + b.w) / grid); x++) {
        const list = filed.get(`${x},${y}`);
        if (list) list.push(i); else filed.set(`${x},${y}`, [i]);
      }
  });
  const near = (a: Vec2, b: Vec2): Shape[] => {
    const x0 = Math.floor((Math.min(a.x, b.x) - radius) / grid), x1 = Math.floor((Math.max(a.x, b.x) + radius) / grid);
    const y0 = Math.floor((Math.min(a.y, b.y) - radius) / grid), y1 = Math.floor((Math.max(a.y, b.y) + radius) / grid);
    // A Set, sort and map per sweep; a reusable stamp array would avoid them if sweeps dominate again.
    const found = new Set<number>();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const i of filed.get(`${x},${y}`) ?? []) found.add(i);
    return [...found].sort((i, j) => i - j).map(i => blockers[i]!);
  };
  const sweep = (a: Vec2, b: Vec2): boolean => {
    if (counters.sweeps >= limits.maxSweeps) { exhausted = true; return false; }
    counters.sweeps++;
    return travelClear(mask, near(a, b), a, b, radius);
  };
  const nodes: { point: Vec2; reason: 'external' | 'interior' }[] = [
    ...required.map(point => ({ point, reason: 'external' as const })),
    ...[...terminals].sort(compare).map(point => ({ point, reason: 'interior' as const })),
  ];
  const addedBoxes = previous && added ? added.map(shape => ({ shape, box: bounds(shape) })) : undefined;
  const unchanged = (a: Vec2, b: Vec2): boolean => !!addedBoxes && capsule(a, b, radius).every(c => {
    const box = bounds(c);
    return addedBoxes.every(({ shape, box: o }) => o.x > box.x + box.w || box.x > o.x + o.w || o.y > box.y + box.h || box.y > o.y + o.h
      || !shapesOverlap(c, shape));
  });
  for (const node of nodes) if (!unchanged(node.point, node.point) && !sweep(node.point, node.point)) return fail(exhausted ? 'budget' : node.reason);
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
  // One mesh search from the root finds every later target's corridor at once. The heap orders
  // by key, then index, and targets relax nothing, so each corridor is the one a search for it
  // alone would find (#787). The trade-off: the search runs until every later target is found,
  // including ones an old path or direct sweep would satisfy, and an unreachable one makes it
  // explore the whole mesh. On the 36-wide panel it still saves time overall (42.33).
  let corridors: Map<string, ReturnType<typeof freePaths>[number]> | undefined;
  for (const [index, node] of nodes.slice(1).entries()) {
    const target = node.point;
    if (same(root!, target)) continue;
    if (counters.paths >= limits.maxPaths) return fail('budget');
    counters.paths++;
    let points: Vec2[] | undefined;
    const old = oldPaths.get(key(target));
    if (old && old.every((p, i) => !i || unchanged(old[i - 1]!, p) || sweep(old[i - 1]!, p))) points = old;
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
      if (!corridors) {
        const later = nodes.slice(index + 1).map(n => n.point).filter(p => !same(root!, p));
        const found = freePaths(mesh, local(root!), later.map(local), brief.cellSize);
        corridors = new Map(later.map((p, i) => [key(p), found[i]!]));
      }
      const candidate = corridors.get(key(target));
      if (candidate) {
        const world = candidate.points.map((p, i, all) => i === 0 ? root! : i === all.length - 1 ? target
          : { x: p.x + mask.bounds.x, y: p.y + mask.bounds.y });
        if (world.length > limits.maxSegments + 1) return fail('budget');
        if (proved(world)) points = world;
      }
    }
    if (exhausted) return fail('budget');
    if (!points) return fail(node.reason);
    segments += points.length - 1;
    // Past `MAX_INPUTS` points the witness could not be passed back as `previous`.
    if (segments > limits.maxSegments || segments + paths.length + 1 > MAX_INPUTS) return fail('budget');
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
  // Sorted by x and by y, so each segment reads only the endpoints within the narrower of its two
  // spans: a long horizontal run reads one row, not every endpoint across its width (#767).
  const byX = [...endpoints.values()].sort(compare);
  const byY = [...byX].sort((a, b) => a.y - b.y || a.x - b.x);
  // The first index whose coordinate is at least `value`, or past it when `after`.
  const indexOf = (list: readonly Vec2[], axis: 'x' | 'y', value: number, after = false): number => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1, v = list[mid]![axis]; if (v < value || after && v === value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const edges = new Map<string, CordEdge>();
  for (const { from, to } of segments) {
    const dx = to.x - from.x, dy = to.y - from.y, x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x);
    const y0 = Math.min(from.y, to.y), y1 = Math.max(from.y, to.y), points: Vec2[] = [];
    const xFrom = indexOf(byX, 'x', x0), xTo = indexOf(byX, 'x', x1, true);
    const yFrom = indexOf(byY, 'y', y0), yTo = indexOf(byY, 'y', y1, true);
    const [list, start, end] = xTo - xFrom <= yTo - yFrom ? [byX, xFrom, xTo] : [byY, yFrom, yTo];
    for (let i = start; i < end; i++) {
      const p = list[i]!;
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && (p.x - from.x) * dy === (p.y - from.y) * dx) points.push(p);
    }
    // In (x, y) order whichever list was read, as consecutive points make the edges.
    if (list === byY) points.sort(compare);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      edges.set(`${pointKey(a)}:${pointKey(b)}`, { from: copy(a), to: copy(b) });
    }
  }
  return [...edges.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
}
