import type { Orientation } from "./chain/types.ts";

export interface TileOption {
  templateId: string;
  orientation: Orientation;
  difficulty: number;
  weight: number;
  id?: number;
  /** Per relation, the ids of the options this one admits across it. The solver fills it. */
  valid?: Map<string, Set<number>>;
}

/**
 * One constraint from a cell to another: `relation` names what must hold between them,
 * and `WfcCompatibility` answers it. A cell may link one neighbour by several relations.
 */
export interface WfcLink {
  cell: number;
  relation: string;
}

export interface WfcCell {
  x: number;
  y: number;
  domain: TileOption[];
  /** Checked, and queued on a change, in this order. */
  links: WfcLink[];
}

export type WfcGrid = WfcCell[];

export function propagate(grid: WfcGrid, _columns: number, _rows: number, startQueue?: number): boolean {
  const inQueue = new Uint8Array(grid.length);
  const queue: number[] = [];
  
  const enqueue = (i: number) => {
    if (!inQueue[i]) { queue.push(i); inQueue[i] = 1; }
  };

  if (startQueue === undefined) {
    for (let i = 0; i < grid.length; i++) enqueue(i);
  } else {
    for (const link of grid[startQueue]!.links) enqueue(link.cell);
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    inQueue[i] = 0;
    const cell = grid[i]!;
    if (cell.domain.length === 0) return false;

    for (const { cell: n, relation } of cell.links) {
      const nCell = grid[n]!;
      const newDomain = cell.domain.filter(opt => {
        const validSet = opt.valid!.get(relation)!;
        for (let k = 0; k < nCell.domain.length; k++) {
          if (validSet.has(nCell.domain[k]!.id!)) return true;
        }
        return false;
      });

      if (newDomain.length < cell.domain.length) {
        cell.domain = newDomain;
        for (const link of cell.links) enqueue(link.cell);
      }
    }
  }

  return true;
}


/** Whether `b` may stand across `relation` from `a`. It reads only the two options. */
export type WfcCompatibility = (a: TileOption, relation: string, b: TileOption) => boolean;

/**
 * A rule checked during the solve, after each propagation. `placed` lists the cells
 * collapsed since the last check on this branch; the first check lists every collapsed
 * cell. It returns true, or refuses the branch by naming the collapsed cells whose
 * options alone make it fail, whatever the rest of the grid holds.
 */
export type WfcAccept = (grid: WfcGrid, placed: number[]) => true | number[];

export interface WfcOptions {
  /** Counts calls across the whole search; the solve gives up past `maxIterations`. */
  state?: { iterations: number; maxIterations: number };
  accept?: WfcAccept;
}

export function solveWfc(grid: WfcGrid, columns: number, rows: number, compatible: WfcCompatibility, random: () => number, options: WfcOptions = {}): WfcGrid | null {
  const result = search(grid, columns, rows, compatible, random, options.state ?? { iterations: 0, maxIterations: 10000 }, options.accept);
  return Array.isArray(result) ? result : null;
}

/**
 * Why a subtree failed, when `accept` was involved: the depths whose choices collapsed
 * the cells it named. The search backjumps to the deepest of them, since every choice
 * below leaves those cells as they are (conflict-directed backjumping). `null` is a
 * failure with no known cause, such as a contradiction, and backtracks one choice.
 *
 * A choice whose every option fails passes on its options' conflicts, and the depths of
 * its cell's collapsed neighbours, whose propagation shaped its domain. Propagation
 * through uncollapsed cells isn't traced, so a jump may skip a choice that mattered:
 * the search can miss a solution, as its iteration cap already can, but never returns
 * a grid `accept` refuses.
 */
type Conflict = { depths: Set<number> } | null;

function search(grid: WfcGrid, columns: number, rows: number, compatible: WfcCompatibility, random: () => number, state: { iterations: number; maxIterations: number }, accept?: WfcAccept, startQueue?: number, collapsed?: Int32Array, depth = 0): WfcGrid | Conflict {
  if (state.iterations++ > state.maxIterations) return null;

  // Assign IDs and precalculate. Choices only narrow domains, so below the first call
  // every option already has its id.
  if (depth === 0) {
    const allOpts = new Set<TileOption>();
    for (let i = 0; i < grid.length; i++) {
      const cell = grid[i]!;
      for (let j = 0; j < cell.domain.length; j++) allOpts.add(cell.domain[j]!);
    }
    const domain = Array.from(allOpts);
    
    let needsPrecalc = false;
    let nextId = 0;
    for (const opt of domain) {
      if (opt.id === undefined) {
        opt.id = nextId++;
        needsPrecalc = true;
      } else {
        if (opt.id >= nextId) nextId = opt.id + 1;
      }
    }

    if (needsPrecalc) {
      const relations = [...new Set(grid.flatMap((c) => c.links.map((link) => link.relation)))];
      for (const opt of domain) opt.valid = new Map(relations.map((relation) => [relation, new Set<number>()]));
      // Compatibility depends only on template and orientation, and every
      // pre-assigned set-piece slot is its own option object, so match each
      // distinct pair once and share the answer across its options.
      const byKind = new Map<string, TileOption[]>();
      for (const opt of domain) {
        const kind = `${opt.templateId}@${opt.orientation}`;
        const kin = byKind.get(kind);
        if (kin) kin.push(opt);
        else byKind.set(kind, [opt]);
      }
      const kinds = [...byKind.values()];
      for (const mine of kinds) {
        const opt = mine[0]!;
        for (const theirs of kinds) {
          const nOpt = theirs[0]!;
          for (const relation of relations) {
            if (!compatible(opt, relation, nOpt)) continue;
            for (const o of mine) for (const n of theirs) o.valid!.get(relation)!.add(n.id!);
          }
        }
      }
    }
  }

    if (!propagate(grid, columns, rows, startQueue)) return null;

  // Each collapsed cell is labelled with the depth that collapsed it, plus one; the
  // parent's labels tell which ones this branch placed.
  const now = new Int32Array(grid.length);
  const placed: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i]!.domain.length === 1) {
    now[i] = collapsed?.[i] || depth + 1;
    if (!collapsed?.[i]) placed.push(i);
  }
  if (accept && placed.length) {
    const refused = accept(grid, placed);
    if (refused !== true) return { depths: new Set(refused.map((i) => now[i]! - 1)) };
  }

  let minEntropy = Infinity;
  let bestCellIndex = -1;

  for (let i = 0; i < grid.length; i++) {
    const cell = grid[i]!;
    if (cell.domain.length > 1 && cell.domain.length < minEntropy) {
      minEntropy = cell.domain.length;
      bestCellIndex = i;
    }
  }

  // All cells collapsed
  if (bestCellIndex === -1) return grid;

  const cell = grid[bestCellIndex]!;
  
  const options = [...cell.domain].map(opt => ({
    opt,
    score: (opt.difficulty + 12) * Math.pow(random(), 1 / (opt.weight || 1))
  })).sort((a, b) => b.score - a.score).map(x => x.opt);

  const depths = new Set<number>();
  let unknown = false;
  for (const opt of options) {
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      links: c.links,
      domain: c === cell ? [opt] : c.domain
    }));

    
    const result = search(clonedGrid, columns, rows, compatible, random, state, accept, bestCellIndex, now, depth + 1);
    if (Array.isArray(result)) return result;
    if (result === null) { unknown = true; continue; }
    // A conflict fixed before this choice fails every other option here too.
    if (!result.depths.has(depth + 1)) return result;
    for (const d of result.depths) if (d !== depth + 1) depths.add(d);
  }

  if (unknown || !accept) return null;
  for (const { cell: n } of cell.links) if (now[n]) depths.add(now[n]! - 1);
  if (!depths.size) depths.add(depth);
  return { depths };
}
