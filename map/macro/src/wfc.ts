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

/**
 * Narrows domains to a fixed point, from `startQueue`'s links or from every cell. Given
 * `trail`, it records each domain it replaces, so the caller can undo the narrowing.
 */
export function propagate(grid: WfcGrid, _columns: number, _rows: number, startQueue?: number, trail?: { cells: number[]; domains: TileOption[][] }): boolean {
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
        if (trail) { trail.cells.push(i); trail.domains.push(cell.domain); }
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
  return search(grid, columns, rows, compatible, random, options.state ?? { iterations: 0, maxIterations: 10000 }, options.accept);
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

/** A search node that chose a cell and is trying its options in turn. */
interface Frame {
  depth: number;
  cell: number;
  options: TileOption[];
  next: number;
  /** The trail length before the first option was set, to undo each option's narrowing. */
  mark: number;
  /** The cells this node collapsed, whose depth labels it clears on leaving. */
  placed: number[];
  depths: Set<number>;
  unknown: boolean;
}

/**
 * Assigns ids and precalculates, for each option and relation, the ids it admits across
 * it. Choices only narrow domains, so it runs once, before the first node.
 */
function prepare(grid: WfcGrid, compatible: WfcCompatibility): void {
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

/**
 * Depth-first search, narrowing `grid` in place. A trail of the domains each choice and
 * its propagation replaced is undone on backtrack, so memory doesn't grow with depth
 * times grid size, and an explicit stack of frames replaces recursion, so depth isn't
 * bounded by the call stack. Choices, `random()` calls and iteration counts follow the
 * recursive search this replaced, node for node.
 */
function search(grid: WfcGrid, columns: number, rows: number, compatible: WfcCompatibility, random: () => number, state: { iterations: number; maxIterations: number }, accept?: WfcAccept): WfcGrid | null {
  const trail: { cells: number[]; domains: TileOption[][] } = { cells: [], domains: [] };
  const undoTo = (mark: number) => {
    while (trail.cells.length > mark) grid[trail.cells.pop()!]!.domain = trail.domains.pop()!;
  };

  // Each collapsed cell is labelled with the depth that collapsed it, plus one; a node
  // sees its ancestors' labels, and clears its own on leaving.
  const now = new Int32Array(grid.length);

  // One node: propagate, check `accept`, pick a cell. It returns a frame to try that
  // cell's options, true when every cell is collapsed, or the node's failure.
  const enter = (depth: number, startQueue?: number): Frame | true | Conflict => {
    if (state.iterations++ > state.maxIterations) return null;
    if (depth === 0) prepare(grid, compatible);
    if (!propagate(grid, columns, rows, startQueue, trail)) return null;

    const placed: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i]!.domain.length === 1 && !now[i]) {
      now[i] = depth + 1;
      placed.push(i);
    }
    if (accept && placed.length) {
      const refused = accept(grid, placed);
      if (refused !== true) {
        const depths = new Set(refused.map((i) => now[i]! - 1));
        for (const i of placed) now[i] = 0;
        return { depths };
      }
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
    if (bestCellIndex === -1) return true;

    const options = [...grid[bestCellIndex]!.domain].map(opt => ({
      opt,
      score: (opt.difficulty + 12) * Math.pow(random(), 1 / (opt.weight || 1))
    })).sort((a, b) => b.score - a.score).map(x => x.opt);

    return { depth, cell: bestCellIndex, options, next: 0, mark: trail.cells.length, placed, depths: new Set<number>(), unknown: false };
  };

  const stack: Frame[] = [];
  let outcome = enter(0);
  for (;;) {
    if (outcome === true) return grid;
    if (outcome !== null && "options" in outcome) stack.push(outcome);
    else {
      // The child just left failed, and its parent takes the result.
      const frame = stack[stack.length - 1];
      if (!frame) return null;
      undoTo(frame.mark);
      if (outcome === null) frame.unknown = true;
      else if (!outcome.depths.has(frame.depth + 1)) {
        // A conflict fixed before this choice fails every other option here too.
        for (const i of frame.placed) now[i] = 0;
        stack.pop();
        continue;
      } else for (const d of outcome.depths) if (d !== frame.depth + 1) frame.depths.add(d);
    }

    const frame = stack[stack.length - 1]!;
    if (frame.next < frame.options.length) {
      const target = grid[frame.cell]!;
      trail.cells.push(frame.cell);
      trail.domains.push(target.domain);
      target.domain = [frame.options[frame.next++]!];
      outcome = enter(frame.depth + 1, frame.cell);
      continue;
    }

    // Every option failed.
    outcome = null;
    if (!frame.unknown && accept) {
      for (const { cell: n } of grid[frame.cell]!.links) if (now[n]) frame.depths.add(now[n]! - 1);
      if (!frame.depths.size) frame.depths.add(frame.depth);
      outcome = { depths: frame.depths };
    }
    for (const i of frame.placed) now[i] = 0;
    stack.pop();
  }
}

