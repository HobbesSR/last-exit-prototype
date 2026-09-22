import type { TileDesign, Side, Orientation } from "./types.js";

export interface TileOption {
  templateId: string;
  orientation: Orientation;
  difficulty: number;
  weight: number;
  id?: number;
}

export interface WfcCell {
  x: number;
  y: number;
  domain: TileOption[];
    setPieceInstance?: string;
  n?: number;
  s?: number;
  e?: number;
  w?: number;
  tl?: number;
  tr?: number;
  bl?: number;
  br?: number;
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

export function propagate(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], startQueue?: number): boolean {
  const inQueue = new Uint8Array(grid.length);
  const queue: number[] = [];
  
  if (startQueue === undefined) {
    for (let i = 0; i < grid.length; i++) {
      queue.push(i);
      inQueue[i] = 1;
    }
  } else {
    queue.push(startQueue);
    inQueue[startQueue] = 1;
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    inQueue[i] = 0;
    const cell = grid[i]!;
    if (cell.domain.length === 0) return false;

    const checkSide = (nIndex: number | undefined, mySide: Side, neighborSide: Side) => {
      if (nIndex === undefined) return;
      const nCell = grid[nIndex]!;
      if (!nCell) return;
        
      
      const validProp = "valid" + mySide;
      
      const newDomain = cell.domain.filter(opt => {
        const validSet = (opt as any)[validProp] as Set<number>;
        if (!validSet) { console.error("MISSING validSet for", opt, validProp, "id:", opt.id); }
        for (let k = 0; k < nCell.domain.length; k++) {
          if (validSet.has(nCell.domain[k]!.id!)) return true;
        }
        return false;
      });
      
      if (newDomain.length < cell.domain.length) {
        cell.domain = newDomain;
        if (cell.n !== undefined && !inQueue[cell.n]) { queue.push(cell.n); inQueue[cell.n] = 1; }
        if (cell.s !== undefined && !inQueue[cell.s]) { queue.push(cell.s); inQueue[cell.s] = 1; }
        if (cell.e !== undefined && !inQueue[cell.e]) { queue.push(cell.e); inQueue[cell.e] = 1; }
        if (cell.w !== undefined && !inQueue[cell.w]) { queue.push(cell.w); inQueue[cell.w] = 1; }
      }
    };

    checkSide(cell.n, "N", "S");
    checkSide(cell.s, "S", "N");
    checkSide(cell.e, "E", "W");
    checkSide(cell.w, "W", "E");
  }

  return true;
}


export function solveWfc(grid: WfcGrid, columns: number, rows: number, libraryTiles: TileDesign[], random: () => number, state = { iterations: 0, maxIterations: 10000 }, startQueue?: number): WfcGrid | null {
  if (state.iterations++ > state.maxIterations) return null;

  // Assign IDs and precalculate
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
      for (const opt of domain) {
        (opt as any).validN = new Set();
        (opt as any).validS = new Set();
        (opt as any).validE = new Set();
        (opt as any).validW = new Set();
      }
      for (const opt of domain) {
        for (const nOpt of domain) {
          if (matchEdge(opt, "N", nOpt, "S", libraryTiles)) (opt as any).validN.add(nOpt.id);
          if (matchEdge(opt, "S", nOpt, "N", libraryTiles)) (opt as any).validS.add(nOpt.id);
          if (matchEdge(opt, "E", nOpt, "W", libraryTiles)) (opt as any).validE.add(nOpt.id);
          if (matchEdge(opt, "W", nOpt, "E", libraryTiles)) (opt as any).validW.add(nOpt.id);
        }
      }
    }

    if (!propagate(grid, columns, rows, libraryTiles, startQueue)) return null;

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
    score: opt.difficulty + Math.pow(random(), 1 / (opt.weight || 1))
  })).sort((a, b) => b.score - a.score).map(x => x.opt);

  for (const opt of options) {
    const clonedGrid: WfcGrid = grid.map(c => ({
      x: c.x, y: c.y,
      n: c.n, s: c.s, e: c.e, w: c.w, tl: c.tl, tr: c.tr, bl: c.bl, br: c.br,
      domain: c === cell ? [opt] : c.domain
    }));

    
    const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, state, bestCellIndex);
    if (result !== null) return result;
  }

  return null;
}
