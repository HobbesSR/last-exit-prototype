/**
 * Connectivity skeleton (51.3, #883): a spanning tree of forced-open seams drawn before the
 * fill solve. Every slot connects to every other by construction, eliminating sealed pockets.
 * Dials:
 * - algorithm: Wilson (uniform spanning tree, long & winding), Prim (short spurs), Kruskal.
 * - extraOpenShare: fraction of unused candidate seams to open (loops and shortcuts).
 * - filterParts: pre-solve filter ensuring each slot's options can internally connect all its
 *   forced-open sides (#883 comment 10802).
 */
import type { TileOption, WfcAccept, WfcGrid } from "../wfc.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
import { orientedDesigns } from "./declared-grid.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary, ChainTileDesign } from "./library.ts";
import { fitsEast, fitsSouth, edgeConnectsEast, edgeConnectsSouth } from "./placement.ts";
import type { Stream } from "./random.ts";
import { DEFAULT_RESOLVED_CLASS, guaranteesPassability } from "./resolution.ts";
import type { MaskCell, MapZone } from "./zones.ts";
import type { Orientation, SetPieceInstance, SegmentKey } from "./types.ts";

export type SkeletonAlgorithm = "wilson" | "prim" | "kruskal";

export interface ConnectivitySkeletonConfig {
  algorithm?: SkeletonAlgorithm;
  extraOpenShare?: number;
  shortcutPriority?: boolean;
  filterParts?: boolean;
}

export interface SkeletonSeam {
  slotA: number;
  slotB: number;
  dir: "E" | "S";
  isTree: boolean;
}

export interface SkeletonResult {
  treeSeams: SkeletonSeam[];
  extraSeams: SkeletonSeam[];
  forcedSeams: SkeletonSeam[];
}

const S = CHAIN_TILE_SIZE;
type Side = "N" | "E" | "S" | "W";
const SIDES: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): boolean {
    const rootA = this.find(a), rootB = this.find(b);
    if (rootA === rootB) return false;
    this.parent[rootB] = rootA;
    return true;
  }
}

interface CandidateSeam {
  seamId: number;
  u: number;
  v: number;
  slotA: number;
  slotB: number;
  dir: "E" | "S";
}

/**
 * Builds a spanning tree over the multigraph of (set piece instances + fill slots),
 * joining each set piece through its available openings, plus optional extra open seams.
 */
export function buildSkeleton(
  mask: MaskCell[],
  assigned: Array<{ design: string; orientation: Orientation } | undefined>,
  instances: SetPieceInstance[],
  zones: Map<string, MapZone>,
  fillByZone: (zone: MapZone) => ChainTileDesign[],
  library: ChainLibrary,
  random: Stream,
  config: ConnectivitySkeletonConfig = {},
): SkeletonResult {
  const algorithm = config.algorithm ?? "wilson";
  const extraOpenShare = Math.max(0, Math.min(1, config.extraOpenShare ?? 0));
  const shortcutPriority = config.shortcutPriority ?? false;

  const oriented = orientedDesigns(library);

  // Map each slot to its node id: each set piece is one node, each fill slot is one node.
  const nodeOf = new Int32Array(mask.length).fill(-1);
  let nextNodeId = 0;
  for (const inst of instances) {
    const nodeId = nextNodeId++;
    for (const slotCoord of inst.slots) {
      const idx = mask.findIndex((c) => c.col === slotCoord.col && c.row === slotCoord.row);
      if (idx >= 0) nodeOf[idx] = nodeId;
    }
  }
  for (let i = 0; i < mask.length; i++) {
    if (nodeOf[i] === -1) nodeOf[i] = nextNodeId++;
  }
  const numNodes = nextNodeId;

  const slotAt = new Map<string, number>();
  mask.forEach((c, i) => slotAt.set(`${c.x},${c.y}`, i));

  // Find all candidate seams that CAN connect.
  const candidateSeams: CandidateSeam[] = [];
  let seamId = 0;

  const eastZoneCache = new Map<string, boolean>();
  const southZoneCache = new Map<string, boolean>();

  function zonesCanConnectEast(zoneAId: string, zoneBId: string): boolean {
    const key = `${zoneAId}:${zoneBId}`;
    let res = eastZoneCache.get(key);
    if (res !== undefined) return res;
    const fillA = fillByZone(zones.get(zoneAId)!);
    const fillB = fillByZone(zones.get(zoneBId)!);
    res = fillA.some((tA) =>
      tA.orientations.some((oA) => {
        const desA = oriented(tA.id, oA as Orientation);
        return fillB.some((tB) =>
          tB.orientations.some((oB) => {
            const desB = oriented(tB.id, oB as Orientation);
            return fitsEast(desA, desB) && edgeConnectsEast(desA, desB);
          }));
      }));
    eastZoneCache.set(key, res);
    return res;
  }

  function zonesCanConnectSouth(zoneAId: string, zoneBId: string): boolean {
    const key = `${zoneAId}:${zoneBId}`;
    let res = southZoneCache.get(key);
    if (res !== undefined) return res;
    const fillA = fillByZone(zones.get(zoneAId)!);
    const fillB = fillByZone(zones.get(zoneBId)!);
    res = fillA.some((tA) =>
      tA.orientations.some((oA) => {
        const desA = oriented(tA.id, oA as Orientation);
        return fillB.some((tB) =>
          tB.orientations.some((oB) => {
            const desB = oriented(tB.id, oB as Orientation);
            return fitsSouth(desA, desB) && edgeConnectsSouth(desA, desB);
          }));
      }));
    southZoneCache.set(key, res);
    return res;
  }

  for (let i = 0; i < mask.length; i++) {
    const { x, y } = mask[i]!;

    // East neighbor
    const eastIdx = slotAt.get(`${x + 1},${y}`);
    if (eastIdx !== undefined && nodeOf[i] !== nodeOf[eastIdx]) {
      const assignA = assigned[i], assignB = assigned[eastIdx];
      let can = true;
      if (assignA && assignB) {
        const desA = oriented(assignA.design, assignA.orientation), desB = oriented(assignB.design, assignB.orientation);
        can = fitsEast(desA, desB) && edgeConnectsEast(desA, desB);
      } else if (assignA && !assignB) {
        const desA = oriented(assignA.design, assignA.orientation);
        can = fillByZone(zones.get(mask[eastIdx]!.zoneId)!).some((t) =>
          t.orientations.some((o) => {
            const desB = oriented(t.id, o as Orientation);
            return fitsEast(desA, desB) && edgeConnectsEast(desA, desB);
          }));
      } else if (!assignA && assignB) {
        const desB = oriented(assignB.design, assignB.orientation);
        can = fillByZone(zones.get(mask[i]!.zoneId)!).some((t) =>
          t.orientations.some((o) => {
            const desA = oriented(t.id, o as Orientation);
            return fitsEast(desA, desB) && edgeConnectsEast(desA, desB);
          }));
      } else {
        can = zonesCanConnectEast(mask[i]!.zoneId, mask[eastIdx]!.zoneId);
      }
      if (can) candidateSeams.push({ seamId: seamId++, u: nodeOf[i]!, v: nodeOf[eastIdx]!, slotA: i, slotB: eastIdx, dir: "E" });
    }

    // South neighbor
    const southIdx = slotAt.get(`${x},${y + 1}`);
    if (southIdx !== undefined && nodeOf[i] !== nodeOf[southIdx]) {
      const assignA = assigned[i], assignB = assigned[southIdx];
      let can = true;
      if (assignA && assignB) {
        const desA = oriented(assignA.design, assignA.orientation), desB = oriented(assignB.design, assignB.orientation);
        can = fitsSouth(desA, desB) && edgeConnectsSouth(desA, desB);
      } else if (assignA && !assignB) {
        const desA = oriented(assignA.design, assignA.orientation);
        can = fillByZone(zones.get(mask[southIdx]!.zoneId)!).some((t) =>
          t.orientations.some((o) => {
            const desB = oriented(t.id, o as Orientation);
            return fitsSouth(desA, desB) && edgeConnectsSouth(desA, desB);
          }));
      } else if (!assignA && assignB) {
        const desB = oriented(assignB.design, assignB.orientation);
        can = fillByZone(zones.get(mask[i]!.zoneId)!).some((t) =>
          t.orientations.some((o) => {
            const desA = oriented(t.id, o as Orientation);
            return fitsSouth(desA, desB) && edgeConnectsSouth(desA, desB);
          }));
      } else {
        can = zonesCanConnectSouth(mask[i]!.zoneId, mask[southIdx]!.zoneId);
      }
      if (can) candidateSeams.push({ seamId: seamId++, u: nodeOf[i]!, v: nodeOf[southIdx]!, slotA: i, slotB: southIdx, dir: "S" });
    }
  }

  // Group candidate seams into connected components of nodes.
  const uf = new UnionFind(numNodes);
  for (const e of candidateSeams) uf.union(e.u, e.v);
  const componentNodes = new Map<number, number[]>();
  for (let i = 0; i < numNodes; i++) {
    const root = uf.find(i);
    let list = componentNodes.get(root);
    if (!list) componentNodes.set(root, list = []);
    list.push(i);
  }

  const treeCandidates: CandidateSeam[] = [];

  for (const [, nodes] of componentNodes) {
    if (nodes.length <= 1) continue;
    const inComp = new Set(nodes);
    const compEdges = candidateSeams.filter((e) => inComp.has(e.u) && inComp.has(e.v));
    const compAdj = new Map<number, CandidateSeam[]>();
    for (const n of nodes) compAdj.set(n, []);
    for (const e of compEdges) {
      compAdj.get(e.u)!.push(e);
      compAdj.get(e.v)!.push(e);
    }

    if (algorithm === "wilson") {
      const inTree = new Uint8Array(numNodes);
      inTree[nodes[0]!] = 1;
      for (const start of nodes) {
        if (inTree[start]) continue;
        let curr = start;
        const path = [curr];
        const pathIndex = new Map<number, number>([[curr, 0]]);
        const nextEdge = new Map<number, CandidateSeam>();
        while (!inTree[curr]) {
          const edges = compAdj.get(curr)!;
          const edge = random.pick(edges);
          const nxt = edge.u === curr ? edge.v : edge.u;
          nextEdge.set(curr, edge);
          if (pathIndex.has(nxt)) {
            const loopStart = pathIndex.get(nxt)!;
            for (let k = loopStart + 1; k < path.length; k++) {
              pathIndex.delete(path[k]!);
              nextEdge.delete(path[k]!);
            }
            path.length = loopStart + 1;
            curr = nxt;
          } else {
            pathIndex.set(nxt, path.length);
            path.push(nxt);
            curr = nxt;
          }
        }
        for (let k = 0; k < path.length - 1; k++) {
          const u = path[k]!;
          inTree[u] = 1;
          treeCandidates.push(nextEdge.get(u)!);
        }
      }
    } else if (algorithm === "prim") {
      const visited = new Uint8Array(numNodes);
      visited[nodes[0]!] = 1;
      const frontier: CandidateSeam[] = [...compAdj.get(nodes[0]!)!];
      while (frontier.length > 0) {
        const idx = Math.floor(random.next() * frontier.length);
        const edge = frontier[idx]!;
        frontier[idx] = frontier[frontier.length - 1]!;
        frontier.pop();
        if (visited[edge.u] === visited[edge.v]) continue;
        const newNode = visited[edge.u] ? edge.v : edge.u;
        visited[newNode] = 1;
        treeCandidates.push(edge);
        for (const nxt of compAdj.get(newNode)!) {
          const other = nxt.u === newNode ? nxt.v : nxt.u;
          if (!visited[other]) frontier.push(nxt);
        }
      }
    } else {
      // Kruskal
      const kruskalUf = new UnionFind(numNodes);
      const shuffled = random.shuffle([...compEdges]);
      for (const e of shuffled) {
        if (kruskalUf.union(e.u, e.v)) treeCandidates.push(e);
      }
    }
  }

  const treeSeams: SkeletonSeam[] = treeCandidates.map((e) => ({
    slotA: e.slotA, slotB: e.slotB, dir: e.dir, isTree: true,
  }));

  // Extra open seams (loops / shortcuts)
  const treeSet = new Set(treeCandidates.map((e) => e.seamId));
  const unused = candidateSeams.filter((e) => !treeSet.has(e.seamId));
  const extraSeams: SkeletonSeam[] = [];

  if (extraOpenShare > 0 && unused.length > 0) {
    const count = Math.floor(unused.length * extraOpenShare);
    if (shortcutPriority) {
      // Prioritize shortcuts by tree distance between endpoints
      const treeAdj = new Map<number, number[]>();
      for (let i = 0; i < numNodes; i++) treeAdj.set(i, []);
      for (const e of treeCandidates) {
        treeAdj.get(e.u)!.push(e.v);
        treeAdj.get(e.v)!.push(e.u);
      }
      const treeDist = (src: number, dst: number): number => {
        const dist = new Int32Array(numNodes).fill(-1);
        dist[src] = 0;
        const q = [src];
        for (let h = 0; h < q.length; h++) {
          const u = q[h]!;
          if (u === dst) return dist[u]!;
          for (const v of treeAdj.get(u)!) if (dist[v] < 0) { dist[v] = dist[u]! + 1; q.push(v); }
        }
        return 0;
      };
      const scored = unused.map((e) => ({ seam: e, dist: treeDist(e.u, e.v) }))
        .sort((a, b) => b.dist - a.dist);
      for (let k = 0; k < count && k < scored.length; k++) {
        const e = scored[k]!.seam;
        extraSeams.push({ slotA: e.slotA, slotB: e.slotB, dir: e.dir, isTree: false });
      }
    } else {
      const chosen = random.shuffle([...unused]).slice(0, count);
      for (const e of chosen) {
        extraSeams.push({ slotA: e.slotA, slotB: e.slotB, dir: e.dir, isTree: false });
      }
    }
  }

  return {
    treeSeams,
    extraSeams,
    forcedSeams: [...treeSeams, ...extraSeams],
  };
}

/**
 * Per side of a design, the border cell, the cell across in the neighbour, and the two
 * segment keys on the seam, for position `k` along it.
 */
const BORDER: Record<Side, (k: number) => { mine: number; theirs: number; segMine: SegmentKey; segTheirs: SegmentKey }> = {
  E: (k) => ({ mine: k * S + S - 1, theirs: k * S, segMine: `v:${S},${k}` as SegmentKey, segTheirs: `v:0,${k}` as SegmentKey }),
  W: (k) => ({ mine: k * S, theirs: k * S + S - 1, segMine: `v:0,${k}` as SegmentKey, segTheirs: `v:${S},${k}` as SegmentKey }),
  S: (k) => ({ mine: (S - 1) * S + k, theirs: k, segMine: `h:${k},${S}` as SegmentKey, segTheirs: `h:${k},0` as SegmentKey }),
  N: (k) => ({ mine: k, theirs: (S - 1) * S + k, segMine: `h:${k},0` as SegmentKey, segTheirs: `h:${k},${S}` as SegmentKey }),
};

/**
 * The border cells of design `a` that cross into `b`, its neighbour on `side` (review 707).
 * Cells cross as `edgeConnectsEast` and the proof join them: the same resolved class, or a
 * guaranteed run of at least `MIN_PORTAL_LENGTH` between one pair of classes. Empty when the
 * two designs don't fit.
 */
function edgeCrossingCells(side: Side, a: OrientedDesign, b: OrientedDesign): number[] {
  const fits = side === "E" ? fitsEast(a, b) : side === "W" ? fitsEast(b, a)
    : side === "S" ? fitsSouth(a, b) : fitsSouth(b, a);
  if (!fits) return [];
  const cells = new Set<number>();
  let run: number[] = [];
  let lastA: string | undefined, lastB: string | undefined;
  for (let k = 0; k < S; k++) {
    const { mine, theirs, segMine, segTheirs } = BORDER[side](k);
    const segA = a.segments.get(segMine), segB = b.segments.get(segTheirs);
    const cellA = a.cells[mine]!, cellB = b.cells[theirs]!;
    const resA = cellA === "any" ? (segB?.adjacency ?? DEFAULT_RESOLVED_CLASS) : cellA;
    const resB = cellB === "any" ? (segA?.adjacency ?? DEFAULT_RESOLVED_CLASS) : cellB;
    if (resA === resB) {
      cells.add(mine);
      run = []; lastA = lastB = undefined;
    } else if (guaranteesPassability(segA?.passability, segB?.passability, false)) {
      if (resA === lastA && resB === lastB) run.push(mine);
      else { run = [mine]; lastA = resA; lastB = resB; }
      if (run.length >= MIN_PORTAL_LENGTH) for (const c of run) cells.add(c);
    } else {
      run = []; lastA = lastB = undefined;
    }
  }
  return [...cells];
}

type ForcedEdge = { nbr: number; side: Side };

/** Each slot's forced-open seams, as the side of that slot and the slot across. */
function forcedEdgesBySlot(forcedSeams: SkeletonSeam[]): Map<number, ForcedEdge[]> {
  const bySlot = new Map<number, ForcedEdge[]>();
  const add = (slot: number, edge: ForcedEdge) => {
    const list = bySlot.get(slot);
    if (list) list.push(edge); else bySlot.set(slot, [edge]);
  };
  for (const { slotA, slotB, dir } of forcedSeams) {
    add(slotA, { nbr: slotB, side: dir });
    add(slotB, { nbr: slotA, side: dir === "E" ? "W" : "N" });
  }
  return bySlot;
}

/**
 * Whether one internal part of `option` carries a crossing on every forced edge, against
 * the options `domainOf` gives for each neighbour (#883 comment 10802, reviews 707, 708).
 * Parts are the open-face rule's fixed parts: cells joined by class or a guaranteed segment.
 */
function partBridges(library: ChainLibrary) {
  const oriented = orientedDesigns(library);
  const partsCache = new Map<OrientedDesign, { count: number; of: Int16Array }>();
  const partsOf = (turnedDesign: OrientedDesign): { count: number; of: Int16Array } => {
    let found = partsCache.get(turnedDesign);
    if (found) return found;
    const { cells } = turnedDesign;
    const of = new Int16Array(S * S).fill(-1);
    let count = 0;
    const joinsInside = (local: number, k: number): number => {
      const x = local % S, y = (local - x) / S, [dx, dy] = SIDES[k]!, nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) return -1;
      const next = ny * S + nx;
      if (cells[next] === "any") return -1;
      if (cells[next] === cells[local]) return next;
      const segment = turnedDesign.segments.get((dx ? `v:${x + Math.max(dx, 0)},${y}` : `h:${x},${y + Math.max(dy, 0)}`) as SegmentKey);
      return guaranteesPassability(segment?.passability, segment?.passability) ? next : -1;
    };
    for (let first = 0; first < S * S; first++) {
      if (cells[first] === "any" || of[first]! >= 0) continue;
      const part = [first];
      of[first] = count;
      for (let i = 0; i < part.length; i++) for (let k = 0; k < SIDES.length; k++) {
        const next = joinsInside(part[i]!, k);
        if (next >= 0 && of[next]! < 0) { of[next] = count; part.push(next); }
      }
      count++;
    }
    partsCache.set(turnedDesign, found = { count, of });
    return found;
  };
  return (option: TileOption, edges: ForcedEdge[], domainOf: (slot: number) => TileOption[]): boolean => {
    const design = oriented(option.templateId, option.orientation as Orientation);
    const { count, of } = partsOf(design);
    if (count <= 1) return true;
    let common: Set<number> | null = null;
    for (const edge of edges) {
      const reached = new Set<number>();
      for (const across of domainOf(edge.nbr)) {
        for (const c of edgeCrossingCells(edge.side, design, oriented(across.templateId, across.orientation as Orientation))) {
          const part = of[c]!;
          if (part >= 0 && (common === null || common.has(part))) reached.add(part);
        }
      }
      common = reached;
      if (common.size === 0) return false;
    }
    return true;
  };
}

/**
 * Before the solve, prunes options that no choice of neighbours could bridge through one part.
 * It reads whole neighbour domains, so it is optimistic; `skeletonPartRule` checks the
 * chosen neighbours during the solve. False when a slot is left with no option.
 */
export function filterSlotDomains(grid: WfcGrid, library: ChainLibrary, forcedSeams: SkeletonSeam[]): boolean {
  const bridges = partBridges(library);
  const domainOf = (slot: number) => grid[slot]?.domain ?? [];
  let ok = true;
  for (const [slot, edges] of forcedEdgesBySlot(forcedSeams)) {
    const cell = grid[slot];
    if (!cell || edges.length <= 1 || cell.domain.length === 0) continue;
    const filtered = cell.domain.filter((option) => bridges(option, edges, domainOf));
    if (filtered.length < cell.domain.length) {
      cell.domain = filtered;
      if (filtered.length === 0) ok = false;
    }
  }
  return ok;
}

/**
 * The part filter against the options the solve chose (review 708). Once a slot with two or
 * more forced seams and every slot across them are placed, one part of the slot's design must
 * carry all those crossings. A refusal names those slots, so the solver backjumps to the
 * latest of them.
 */
export function skeletonPartRule(library: ChainLibrary, forcedSeams: SkeletonSeam[]): WfcAccept {
  const bridges = partBridges(library);
  const bySlot = forcedEdgesBySlot(forcedSeams);
  return (grid, placed) => {
    const checked = new Set<number>();
    const domainOf = (slot: number) => grid[slot]!.domain;
    for (const p of placed) {
      for (const slot of [p, ...(bySlot.get(p) ?? []).map((edge) => edge.nbr)]) {
        if (checked.has(slot)) continue;
        checked.add(slot);
        const edges = bySlot.get(slot);
        if (!edges || edges.length <= 1 || grid[slot]!.domain.length !== 1) continue;
        if (edges.some((edge) => grid[edge.nbr]!.domain.length !== 1)) continue;
        if (!bridges(grid[slot]!.domain[0]!, edges, domainOf)) return [slot, ...edges.map((edge) => edge.nbr)];
      }
    }
    return true;
  };
}

/** Runs each rule in turn; the first refusal stands. */
export function bothRules(first: WfcAccept, second: WfcAccept | undefined): WfcAccept {
  return second ? (grid, placed) => { const refused = first(grid, placed); return refused === true ? second(grid, placed) : refused; } : first;
}

/**
 * Applies forced-open relations to grid links for the selected skeleton seams.
 */
export function applySkeletonToGrid(
  grid: WfcGrid,
  library: ChainLibrary,
  skeletonResult: SkeletonResult,
  filterParts = true,
): boolean {
  for (const seam of skeletonResult.forcedSeams) {
    const { slotA, slotB, dir } = seam;
    const linkA = grid[slotA]!.links.find((l) => l.cell === slotB && l.relation === dir);
    if (linkA) linkA.relation = `${dir}:must-open`;

    const revDir = dir === "E" ? "W" : "N";
    const linkB = grid[slotB]!.links.find((l) => l.cell === slotA && l.relation === revDir);
    if (linkB) linkB.relation = `${revDir}:must-open`;
  }

  if (filterParts) {
    return filterSlotDomains(grid, library, skeletonResult.forcedSeams);
  }
  return true;
}
