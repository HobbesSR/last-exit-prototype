import type { TileDesign, Side, Orientation } from "./types.js";

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

export function getDifficulty(design: TileDesign): number {
  let diff = 0;
  if (design.edges) {
    for (const side of Object.values(design.edges)) {
      if (Array.isArray(side)) {
        for (const seg of side) {
          if (seg !== "any") diff++;
        }
      }
    }
  }
  if (design.corners) {
    for (const side of Object.values(design.corners)) {
      if (Array.isArray(side)) {
        for (const vert of side) {
          if (vert !== "any") diff++;
        }
      }
    }
  }
  return diff;
}

const SIDES: Side[] = ["N", "E", "S", "W"];

export function getRotatedEdge(opt: TileOption, side: Side, libraryTiles: TileDesign[], isVertex: boolean = false): string[] {
  const design = libraryTiles.find(t => t.id === opt.templateId)!;
  const prop = isVertex ? design.corners : design.edges;
  const length = isVertex ? 7 : 6;
  
  const def: string[] = [];
  for (let i = 0; i < length; i++) def.push("any");
  
  if (!prop) return def;

  const rotIdx = opt.orientation / 90;
  const targetIdx = SIDES.indexOf(side);
  const sourceIdx = (targetIdx - rotIdx + 4) % 4;
  const sourceSide = SIDES[sourceIdx]!;

  const segs = prop[sourceSide];
  if (!Array.isArray(segs)) return def;

  const out = [...segs];
  while (out.length < length) out.push("any");

  let reversed = false;
  if (opt.orientation === 90 && (sourceSide === "E" || sourceSide === "W")) reversed = !reversed;
  if (opt.orientation === 180) reversed = !reversed;
  if (opt.orientation === 270 && (sourceSide === "N" || sourceSide === "S")) reversed = !reversed;

  if (reversed) out.reverse();
  return out;
}

export function getRotatedCells(opt: TileOption, side: Side, libraryTiles: TileDesign[]): string[] {
  const design = libraryTiles.find(t => t.id === opt.templateId)!;
  const rotIdx = opt.orientation / 90;
  const targetIdx = SIDES.indexOf(side);
  const sourceIdx = (targetIdx - rotIdx + 4) % 4;
  const sourceSide = SIDES[sourceIdx]!;

  const def: string[] = [];
  if (design.cells) {
    const getMark = (x: number, y: number) => {
      const c = design.cells![y]?.[x] || ".";
      if (c === ".") return design.defaultCellClass || "any";
      return design.legend?.[c] || "any";
    };
    if (sourceSide === "N") {
      for (let x = 0; x < 6; x++) def.push(getMark(x, 0));
    } else if (sourceSide === "S") {
      for (let x = 0; x < 6; x++) def.push(getMark(x, 5));
    } else if (sourceSide === "W") {
      for (let y = 0; y < 6; y++) def.push(getMark(0, y));
    } else if (sourceSide === "E") {
      for (let y = 0; y < 6; y++) def.push(getMark(5, y));
    }
  } else {
    const defClass = design.defaultCellClass || "any";
    for (let i = 0; i < 6; i++) def.push(defClass);
  }

  let reversed = false;
  if (opt.orientation === 90 && (sourceSide === "E" || sourceSide === "W")) reversed = !reversed;
  if (opt.orientation === 180) reversed = !reversed;
  if (opt.orientation === 270 && (sourceSide === "N" || sourceSide === "S")) reversed = !reversed;
  if (reversed) def.reverse();

  return def;
}


export function matchDiagonal(optA: TileOption, dir: "TL"|"TR"|"BL"|"BR", optB: TileOption, libraryTiles: TileDesign[]): boolean {
  if (dir === "BR") { // A is TL, B is BR
    const aEast = getRotatedEdge(optA, "E", libraryTiles)[5];
    const bNorth = getRotatedEdge(optB, "N", libraryTiles)[0];
    if (aEast !== "any" && bNorth !== "any" && aEast !== bNorth) return false;

    const aSouth = getRotatedEdge(optA, "S", libraryTiles)[5];
    const bWest = getRotatedEdge(optB, "W", libraryTiles)[0];
    if (aSouth !== "any" && bWest !== "any" && aSouth !== bWest) return false;
    return true;
  }
  if (dir === "TL") { // A is BR, B is TL
    const aWest = getRotatedEdge(optA, "W", libraryTiles)[0];
    const bSouth = getRotatedEdge(optB, "S", libraryTiles)[5];
    if (aWest !== "any" && bSouth !== "any" && aWest !== bSouth) return false;

    const aNorth = getRotatedEdge(optA, "N", libraryTiles)[0];
    const bEast = getRotatedEdge(optB, "E", libraryTiles)[5];
    if (aNorth !== "any" && bEast !== "any" && aNorth !== bEast) return false;
    return true;
  }
  if (dir === "TR") { // A is BL, B is TR
    const aNorth = getRotatedEdge(optA, "N", libraryTiles)[5];
    const bWest = getRotatedEdge(optB, "W", libraryTiles)[5];
    if (aNorth !== "any" && bWest !== "any" && aNorth !== bWest) return false;

    const aEast = getRotatedEdge(optA, "E", libraryTiles)[0];
    const bSouth = getRotatedEdge(optB, "S", libraryTiles)[0];
    if (aEast !== "any" && bSouth !== "any" && aEast !== bSouth) return false;
    return true;
  }
  if (dir === "BL") { // A is TR, B is BL
    const aSouth = getRotatedEdge(optA, "S", libraryTiles)[0];
    const bEast = getRotatedEdge(optB, "E", libraryTiles)[0];
    if (aSouth !== "any" && bEast !== "any" && aSouth !== bEast) return false;

    const aWest = getRotatedEdge(optA, "W", libraryTiles)[5];
    const bNorth = getRotatedEdge(optB, "N", libraryTiles)[5];
    if (aWest !== "any" && bNorth !== "any" && aWest !== bNorth) return false;
    return true;
  }
  return true;
}

export function matchEdge(optA: TileOption, sideA: Side, optB: TileOption, sideB: Side, libraryTiles: TileDesign[]): boolean {
  const segA = getRotatedEdge(optA, sideA, libraryTiles);
  const cellA = getRotatedCells(optA, sideA, libraryTiles);
  const segB = getRotatedEdge(optB, sideB, libraryTiles);
  const cellB = getRotatedCells(optB, sideB, libraryTiles);

  for (let i = 0; i < 6; i++) {
    // A's segment constrains B's cell
    if (segA[i] !== "any" && cellB[i] !== "any" && segA[i] !== cellB[i]) return false;
    // B's segment constrains A's cell
    if (segB[i] !== "any" && cellA[i] !== "any" && segB[i] !== cellA[i]) return false;
  }

  const cornerA = getRotatedEdge(optA, sideA, libraryTiles, true);
  const cornerB = getRotatedEdge(optB, sideB, libraryTiles, true);
  for (let i = 0; i < 7; i++) {
    if (cornerA[i] !== "any" && cornerB[i] !== "any" && cornerA[i] !== cornerB[i]) return false;
  }

  return true;
}

export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
  // options is [TL, TR, BL, BR] surrounding a single vertex point
  
  const checkCell = (optCell: TileOption | null, sideCell: Side, indexCell: number,
                     optSeg1: TileOption | null, sideSeg1: Side, indexSeg1: number,
                     optSeg2: TileOption | null, sideSeg2: Side, indexSeg2: number) => {
    let cellClass = "any";
    if (optCell) cellClass = getRotatedCells(optCell, sideCell, libraryTiles)[indexCell];
    
    let seg1 = "any";
    if (optSeg1) seg1 = getRotatedEdge(optSeg1, sideSeg1, libraryTiles)[indexSeg1];
    
    let seg2 = "any";
    if (optSeg2) seg2 = getRotatedEdge(optSeg2, sideSeg2, libraryTiles)[indexSeg2];

    const reqs = new Set<string>();
    if (cellClass !== "any") reqs.add(cellClass);
    if (seg1 !== "any") reqs.add(seg1);
    if (seg2 !== "any") reqs.add(seg2);
    
    return reqs.size <= 1;
  };

  const tl = options[0];
  const tr = options[1];
  const bl = options[2];
  const br = options[3];

  // TL cell (S-5, E-5) constrained by BL North-5 and TR West-5
  if (!checkCell(tl, "S", 5, bl, "N", 5, tr, "W", 5)) return false;

  // TR cell (S-0, W-0) constrained by BR North-0 and TL East-0 (wait, East edge goes from y=0 to y=5, so y=0 is index 0. Yes, TL East-0... wait! TR's South-West corner is at y=5! So TR South-0, TR West-5? Let's trace carefully.)
  // TR tile. Bottom-left cell. 
  // South edge goes x=0 to x=5. Bottom-left cell is x=0, index 0.
  // West edge goes y=0 to y=5. Bottom-left cell is y=5, index 5!
  // It is constrained by BR's North segment 0, and TL's East segment 5.
  if (!checkCell(tr, "S", 0, br, "N", 0, tl, "E", 5)) return false;

  // BL tile. Top-right cell.
  // North edge goes x=0 to x=5. Top-right is x=5, index 5.
  // East edge goes y=0 to y=5. Top-right is y=0, index 0.
  // Constrained by TL's South segment 5, and BR's West segment 0.
  if (!checkCell(bl, "N", 5, tl, "S", 5, br, "W", 0)) return false;

  // BR tile. Top-left cell.
  // North edge x=0 to x=5. Top-left is x=0, index 0.
  // West edge y=0 to y=5. Top-left is y=0, index 0.
  // Constrained by TR's South segment 0, and BL's East segment 0.
  if (!checkCell(br, "N", 0, tr, "S", 0, bl, "E", 0)) return false;

  return true;
}

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

/** The old path's relations: a neighbour's direction, diagonals included. */
export type WfcDirection = Side | "TL" | "TR" | "BL" | "BR";
const COMPASS: Array<[WfcDirection, number, number]> = [
  ["N", 0, -1], ["S", 0, 1], ["E", 1, 0], ["W", -1, 0],
  ["TL", -1, -1], ["TR", 1, -1], ["BL", -1, 1], ["BR", 1, 1],
];

/** Links each cell to its eight neighbours by direction, as the old path always has. */
export function compassLinks(grid: WfcGrid): void {
  const at = new Map<string, number>();
  grid.forEach((c, i) => at.set(`${c.x},${c.y}`, i));
  for (const c of grid) {
    c.links = [];
    for (const [relation, dx, dy] of COMPASS) {
      const cell = at.get(`${c.x + dx},${c.y + dy}`);
      if (cell !== undefined) c.links.push({ cell, relation });
    }
  }
}

/** The old library's compatibility: matching edge, cell and corner declarations. */
export function tileCompatibility(libraryTiles: TileDesign[]): WfcCompatibility {
  const opposite: Record<Side, Side> = { N: "S", S: "N", E: "W", W: "E" };
  return (a, relation, b) => relation.length === 1
    ? matchEdge(a, relation as Side, b, opposite[relation as Side], libraryTiles)
    : matchDiagonal(a, relation as "TL" | "TR" | "BL" | "BR", b, libraryTiles);
}

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
