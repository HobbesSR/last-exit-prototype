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
  n?: number;
  s?: number;
  e?: number;
  w?: number;
  tl?: number;
  tr?: number;
  bl?: number;
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

export function matchEdge(optA: TileOption, sideA: Side, optB: TileOption, sideB: Side, libraryTiles: TileDesign[]): boolean {
  const segA = getRotatedEdge(optA, sideA, libraryTiles, false);
  const segB = getRotatedEdge(optB, sideB, libraryTiles, false);

  for (let i = 0; i < 6; i++) {
    const a = segA[i];
    const b = segB[i];
    if (a !== "any" && b !== "any" && a !== b) {
      return false;
    }
  }
  return true;
}

export function matchVertex(options: (TileOption | null)[], libraryTiles: TileDesign[]): boolean {
  // options is [TL, TR, BL, BR] surrounding a single vertex point
  const required = new Set<string>();
  
  const addReq = (opt: TileOption, side: Side, index: number) => {
    const verts = getRotatedEdge(opt, side, libraryTiles, true);
    const v = verts[index];
    if (v && v !== "any") required.add(v);
  };

  if (options[0]) addReq(options[0], "S", 6); // BottomRight of TopLeft tile
  if (options[1]) addReq(options[1], "S", 0); // BottomLeft of TopRight tile
  if (options[2]) addReq(options[2], "N", 6); // TopRight of BottomLeft tile
  if (options[3]) addReq(options[3], "N", 0); // TopLeft of BottomRight tile
  
  return required.size <= 1;
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
      
      const validProp = mySide === "N" ? "validN" : mySide === "S" ? "validS" : mySide === "E" ? "validE" : "validW";
      
      const newDomain = cell.domain.filter(opt => {
        const validSet = (opt as any)[validProp] as Set<number>;
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

  // Assign IDs and precalculate valid edges if not done yet
  let needsPrecalc = false;
  if (grid.length > 0 && grid[0]!.domain.length > 0 && grid[0]!.domain[0]!.id === undefined) {
    let id = 0;
    for (const opt of grid[0]!.domain) opt.id = id++;
    needsPrecalc = true;
  }

  if (needsPrecalc) {
    const domain = grid[0]!.domain;
    for (const opt of domain) {
      (opt as any).validN = new Set();
      (opt as any).validS = new Set();
      (opt as any).validE = new Set();
      (opt as any).validW = new Set();
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
      n: c.n, s: c.s, e: c.e, w: c.w, tl: c.tl, tr: c.tr, bl: c.bl,
      domain: c === cell ? [opt] : c.domain
    }));

    
    const result = solveWfc(clonedGrid, columns, rows, libraryTiles, random, state, bestCellIndex);
    if (result !== null) return result;
  }

  return null;
}
