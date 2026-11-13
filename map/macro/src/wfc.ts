export interface TraceSlot<O extends number = number> { slot: number; design: string; orientation: O }
export type WfcTraceEvent<O extends number = number> =
  | { type: "node"; depth: number; iterations: number; stall: number }
  | { type: "collapse"; depth: number; slots: TraceSlot<O>[] }
  | { type: "undo"; slots: number[] }
  | { type: "contradiction"; depth: number; slots: number[] }
  | { type: "conflict"; depth: number; depths: number[]; backjump: number; stall: number }
  | { type: "backtrack"; fromDepth: number; toDepth: number }
  | { type: "give-up"; reason: "iterations" | "stall"; depth: number; iterations: number; stall: number };

export interface TileOption<O extends number = number> {
  templateId: string;
  orientation: O;
  difficulty: number;
  weight: number;
  id?: number;
  /** Per relation, the ids of the options this one admits across it. The solver fills it. */
  valid?: Map<string, Set<number>>;
  /** Per relation, the ids of the options this one connects to across it. */
  connects?: Map<string, Set<number>>;
}

/**
 * One constraint from a cell to another: `relation` names what must hold between them,
 * and `WfcCompatibility` answers it. A cell may link one neighbour by several relations.
 */
export interface WfcLink {
  cell: number;
  relation: string;
}

export interface WfcCell<O extends number = number> {
  x: number;
  y: number;
  domain: TileOption<O>[];
  /** Checked, and queued on a change, in this order. */
  links: WfcLink[];
  orthoLinks?: WfcLink[];
}

export type WfcGrid<O extends number = number> = WfcCell<O>[];

/**
 * Narrows domains to a fixed point, from `startQueue`'s links or from every cell. Given
 * `trail`, it records each domain it replaces, so the caller can undo the narrowing.
 */
function propagate<O extends number = number>(grid: WfcGrid<O>, startQueue?: number | number[], trail?: { cells: number[]; domains: TileOption<O>[][] }): boolean {
  const inQueue = new Uint8Array(grid.length);
  const queue: number[] = [];
  
  const enqueue = (i: number) => {
    if (!inQueue[i]) { queue.push(i); inQueue[i] = 1; }
  };

  if (startQueue === undefined) {
    for (let i = 0; i < grid.length; i++) enqueue(i);
  } else if (typeof startQueue === "number") {
    for (const link of grid[startQueue]!.links) enqueue(link.cell);
  } else {
    for (const s of startQueue) for (const link of grid[s]!.links) enqueue(link.cell);
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
export type WfcCompatibility<O extends number = number> = (a: TileOption<O>, relation: string, b: TileOption<O>) => boolean;

/**
 * A rule checked during the solve, after each propagation. `placed` lists the cells
 * collapsed since the last check on this branch; the first check lists every collapsed
 * cell. It returns true, or refuses the branch by naming the collapsed cells whose
 * options alone make it fail, whatever the rest of the grid holds.
 */
export type WfcAccept<O extends number = number> = (grid: WfcGrid<O>, placed: number[]) => true | number[];

export interface WfcConnects<O extends number = number> {
  /** Whether two options connect across `relation` (shared class or portal). */
  test: (a: TileOption<O>, relation: string, b: TileOption<O>) => boolean;
  /** Which link relations are orthogonal for `connects` pruning. */
  isOrthogonal: (relation: string) => boolean;
}

export interface WfcOptions<O extends number = number> {
  /** Detached diagnostic deltas; absent by default. Does not draw randomness. */
  trace?: (event: WfcTraceEvent<O>) => void;
  /** Counts calls across the whole search; the solve gives up past `maxIterations`. */
  state?: { iterations: number; maxIterations: number };
  accept?: WfcAccept<O>;
  /**
   * How many times `accept` may refuse since the search last reached a depth it hadn't, before
   * the solve gives up (`null`), so that a caller can restart it on a fresh stream. A solve that
   * stops gaining depth while `accept` keeps refusing is churning among its last few cells,
   * which the iteration cap alone bounds only after a very long time (#849). Unbounded by default.
   */
  stallLimit?: number;
  /** When given, the most refusals the search made between two new depths is recorded here. */
  stall?: { most: number };
  /** Prunes single-tile dead ends (#894) across orthogonal relations. */
  connects?: WfcConnects<O>;
}

/**
 * The default search cap: 10 nodes a cell, and never under 10,000. A solve makes about one
 * choice a free cell before any backtracking, so a fixed cap ran out on 36 x 18 zones
 * (#171). Every game map at 12 x 6 zones keeps the 10,000 it always had.
 */
export const wfcIterationCap = (cells: number): number => Math.max(10_000, 10 * cells);

export function solveWfc<O extends number = number>(grid: WfcGrid<O>, compatible: WfcCompatibility<O>, random: () => number, options: WfcOptions<O> = {}): WfcGrid<O> | null {
  return search(grid, compatible, random, options.state ?? { iterations: 0, maxIterations: wfcIterationCap(grid.length) }, options.accept,
    { limit: options.stallLimit ?? Infinity, record: options.stall }, options.trace, options.connects);
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
interface Frame<O extends number = number> {
  depth: number;
  cell: number;
  options: TileOption<O>[];
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
 *
 * Compatibility depends only on template and orientation, so the options of one kind
 * share an id and one table. Every pre-assigned set piece slot is its own option object,
 * and a table per option grew with the square of those slots (#171).
 */
function prepare<O extends number = number>(grid: WfcGrid<O>, compatible: WfcCompatibility<O>, connects?: WfcConnects<O>): void {
  if (connects) {
    for (let i = 0; i < grid.length; i++) grid[i]!.orthoLinks = grid[i]!.links.filter((l) => connects.isOrthogonal(l.relation));
  }
  const allOpts = new Set<TileOption<O>>();
  for (let i = 0; i < grid.length; i++) {
    const cell = grid[i]!;
    for (let j = 0; j < cell.domain.length; j++) allOpts.add(cell.domain[j]!);
  }
  const domain = Array.from(allOpts);
  if (domain.every((opt) => opt.id !== undefined)) return;

  const byKind = new Map<string, TileOption<O>[]>();
  for (const opt of domain) {
    const kind = `${opt.templateId}@${opt.orientation}`;
    const kin = byKind.get(kind);
    if (kin) kin.push(opt);
    else byKind.set(kind, [opt]);
  }
  const kinds = [...byKind.values()];
  const relations = [...new Set(grid.flatMap((c) => c.links.map((link) => link.relation)))];
  kinds.forEach((kin, id) => {
    const valid = new Map(relations.map((relation) => [relation, new Set<number>()]));
    const connMap = connects ? new Map(relations.map((relation) => [relation, new Set<number>()])) : undefined;
    for (const opt of kin) {
      opt.id = id;
      opt.valid = valid;
      if (connMap) opt.connects = connMap;
    }
  });
  for (const mine of kinds) for (const [id, theirs] of kinds.entries()) for (const relation of relations) {
    if (compatible(mine[0]!, relation, theirs[0]!)) mine[0]!.valid!.get(relation)!.add(id);
    if (connects && connects.test(mine[0]!, relation, theirs[0]!)) mine[0]!.connects!.get(relation)!.add(id);
  }
}

/** Added to each option's difficulty before its weighted draw, so an unconstrained option's score stays above zero. */
const DIFFICULTY_OFFSET = 12;

/**
 * Depth-first search, narrowing `grid` in place. A trail of the domains each choice and
 * its propagation replaced is undone on backtrack, so memory doesn't grow with depth
 * times grid size, and an explicit stack of frames replaces recursion, so depth isn't
 * bounded by the call stack.
 */
function search<O extends number = number>(grid: WfcGrid<O>, compatible: WfcCompatibility<O>, random: () => number, state: { iterations: number; maxIterations: number }, accept?: WfcAccept<O>,
  stall: { limit: number; record?: { most: number } | undefined } = { limit: Infinity }, trace?: (event: WfcTraceEvent<O>) => void,
  connects?: WfcConnects<O>): WfcGrid<O> | null {
  // Refusals since the search last reached a new depth (`stallLimit`).
  let deepest = -1, refusals = 0;
  const trail: { cells: number[]; domains: TileOption<O>[][] } = { cells: [], domains: [] };
  const shown = trace ? new Map<number, TileOption<O>>() : undefined;
  const showCollapsed = (depth: number) => {
    if (!trace) return;
    const slots: TraceSlot<O>[] = [];
    for (let slot = 0; slot < grid.length; slot++) {
      const domain = grid[slot]!.domain;
      if (domain.length !== 1 || shown!.get(slot) === domain[0]) continue;
      const option = domain[0]!;
      shown!.set(slot, option);
      slots.push({ slot, design: option.templateId, orientation: option.orientation });
    }
    if (slots.length) trace({ type: "collapse", depth, slots });
  };
  const undoTo = (mark: number) => {
    const removed = trace ? new Set<number>() : undefined;
    while (trail.cells.length > mark) {
      const slot = trail.cells.pop()!;
      grid[slot]!.domain = trail.domains.pop()!;
      if (shown?.has(slot) && (grid[slot]!.domain.length !== 1 || grid[slot]!.domain[0] !== shown.get(slot))) {
        shown.delete(slot);
        removed!.add(slot);
      }
    }
    if (removed?.size) trace!({ type: "undo", slots: [...removed] });
  };
  showCollapsed(0);

  // Each collapsed cell is labelled with the depth that collapsed it, plus one; a node
  // sees its ancestors' labels, and clears its own on leaving.
  const now = new Int32Array(grid.length);

  // One node: propagate, check `accept`, pick a cell. It returns a frame to try that
  // cell's options, true when every cell is collapsed, or the node's failure.
  const enter = (depth: number, startQueue?: number): Frame<O> | true | Conflict => {
    if (state.iterations++ > state.maxIterations) {
      trace?.({ type: "give-up", reason: "iterations", depth, iterations: state.iterations, stall: refusals });
      return null;
    }
    if (depth > deepest) { deepest = depth; refusals = 0; }
    trace?.({ type: "node", depth, iterations: state.iterations, stall: refusals });
    if (depth === 0) prepare(grid, compatible, connects);
    const trailStart = trail.cells.length;
    const propagated = propagate(grid, startQueue, trail);
    showCollapsed(depth);
    if (!propagated) {
      if (trace) trace({ type: "contradiction", depth, slots: grid.flatMap((cell, slot) => cell.domain.length ? [] : [slot]) });
      return null;
    }

    if (connects) {
      const candidates = new Set<number>();
      if (depth === 0) {
        for (let i = 0; i < grid.length; i++) candidates.add(i);
      } else {
        if (startQueue !== undefined) candidates.add(startQueue);
        for (let t = trailStart; t < trail.cells.length; t++) {
          const changed = trail.cells[t]!;
          const ortho = grid[changed]!.orthoLinks!;
          for (let l = 0; l < ortho.length; l++) candidates.add(ortho[l]!.cell);
        }
      }

      const queue = [...candidates];
      const rePropagate: number[] = [];
      while (queue.length > 0) {
        const i = queue.pop()!;
        const cell = grid[i]!;
        if (cell.domain.length <= 1) continue;
        const orthoLinks = cell.orthoLinks!;
        const newDomain = cell.domain.filter((opt) => {
          for (let l = 0; l < orthoLinks.length; l++) {
            const link = orthoLinks[l]!;
            const connectSet = opt.connects?.get(link.relation);
            if (!connectSet) continue;
            const nDomain = grid[link.cell]!.domain;
            for (let k = 0; k < nDomain.length; k++) {
              if (connectSet.has(nDomain[k]!.id!)) return true;
            }
          }
          return false;
        });
        if (newDomain.length < cell.domain.length) {
          trail.cells.push(i);
          trail.domains.push(cell.domain);
          cell.domain = newDomain;
          rePropagate.push(i);
          if (newDomain.length === 0) {
            if (trace) trace({ type: "contradiction", depth, slots: [i] });
            return null;
          }
          for (let l = 0; l < orthoLinks.length; l++) queue.push(orthoLinks[l]!.cell);
        }
      }
      if (rePropagate.length > 0) {
        if (!propagate(grid, rePropagate, trail)) {
          if (trace) trace({ type: "contradiction", depth, slots: grid.flatMap((cell, slot) => cell.domain.length ? [] : [slot]) });
          return null;
        }
        showCollapsed(depth);
      }
    }

    const placed: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i]!.domain.length === 1 && !now[i]) {
      now[i] = depth + 1;
      placed.push(i);
    }
    if (accept && placed.length) {
      const refused = accept(grid, placed);
      if (refused !== true) {
        refusals++;
        if (stall.record && refusals > stall.record.most) stall.record.most = refusals;
        // Past the limit every later node fails at once, as past the cap, so the search unwinds.
        if (refusals > stall.limit) {
          state.iterations = state.maxIterations + 1;
          trace?.({ type: "give-up", reason: "stall", depth, iterations: state.iterations, stall: refusals });
        }
        const depths = new Set(refused.map((i) => now[i]! - 1));
        if (trace) trace({ type: "conflict", depth, depths: [...depths], backjump: Math.max(-1, ...depths), stall: refusals });
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
      score: (opt.difficulty + DIFFICULTY_OFFSET) * Math.pow(random(), 1 / (opt.weight || 1))
    })).sort((a, b) => b.score - a.score).map(x => x.opt);

    return { depth, cell: bestCellIndex, options, next: 0, mark: trail.cells.length, placed, depths: new Set<number>(), unknown: false };
  };

  const stack: Frame<O>[] = [];
  let outcome = enter(0);
  for (;;) {
    if (outcome === true) return grid;
    if (outcome !== null && "options" in outcome) stack.push(outcome);
    else {
      // The child just left failed, and its parent takes the result.
      const frame = stack[stack.length - 1];
      if (!frame) return null;
      trace?.({ type: "backtrack", fromDepth: frame.depth + 1, toDepth: frame.depth });
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
      showCollapsed(frame.depth + 1);
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

