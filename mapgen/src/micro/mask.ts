/**
 * The region cell set, and the shape questions a builder actually asks of it.
 *
 * A region is an area, not an enclosure, and is not tile shaped: it is whatever
 * `core.searchRegions` flood filled, so it is routinely concave, sometimes has
 * holes, and never has a natural origin. A builder written against that shape
 * needs three things it cannot get from a bare index list -- constant time
 * membership, how far a cell is from the outside, and where the rectangles are
 * -- and getting them wrong is expensive rather than merely slow: a region here
 * can be a thousand cells, and a builder asks these per candidate.
 *
 * So everything below is precomputed once over the region's bounding box. The
 * box is the right frame because a region is dense inside it and the map grid
 * is not: a 30 x 30 region in a 120 x 72 map pays for 900 cells, not 8640.
 * Queries are in map cell coordinates throughout, never box-local, because the
 * box is an implementation detail a builder should never have to subtract.
 */
import type { Box } from "../types.ts";
import type { CellRef, RegionMask } from "./types.ts";

/**
 * An empty region's bounds. Inverted deliberately: every containment test
 * written as `x >= b[0] && x <= b[2]` is then false without a special case, and
 * the width `b[2] - b[0] + 1` is zero rather than one.
 */
const EMPTY_BOUNDS: Box = [0, 0, -1, -1];

/**
 * Build a mask over the region's cells. Indices outside the grid, non-integer
 * or repeated are dropped rather than trusted -- the mask is the thing every
 * later query believes, so it is the place to stop a bad index.
 */
export function createMask(
  cellIndices: readonly number[],
  width: number,
  height: number,
): RegionMask {
  const W = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const H = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  const limit = W * H;

  const sorted = [...new Set(cellIndices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < limit)
    .sort((a, b) => a - b);

  const cells: CellRef[] = sorted.map((cellIndex) => {
    const x = cellIndex % W;
    return Object.freeze({ cellIndex, x, y: (cellIndex - x) / W });
  });
  Object.freeze(cells);

  // Ascending indices already order rows, so only the x extent needs looking
  // for: the first cell is on the top row and the last on the bottom.
  const bounds: Box = [
    EMPTY_BOUNDS[0],
    EMPTY_BOUNDS[1],
    EMPTY_BOUNDS[2],
    EMPTY_BOUNDS[3],
  ];
  if (cells.length) {
    let minX = cells[0]!.x;
    let maxX = minX;
    for (const cell of cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.x > maxX) maxX = cell.x;
    }
    bounds[0] = minX;
    bounds[1] = cells[0]!.y;
    bounds[2] = maxX;
    bounds[3] = cells[cells.length - 1]!.y;
  }
  Object.freeze(bounds);
  const [bx0, by0, bx1, by1] = bounds;
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  const span = Math.max(0, bw * bh);

  // Occupancy carries the cell's position in `cells` plus one, so the same
  // array answers `has` and `indexOf` without a second structure and without a
  // scan. Zero is "absent", which is why the stored value is offset.
  const occupancy = new Int32Array(span);
  for (let at = 0; at < cells.length; at += 1) {
    const cell = cells[at]!;
    occupancy[(cell.y - by0) * bw + (cell.x - bx0)] = at + 1;
  }

  /**
   * Chebyshev distance to the nearest cell not in the region, by the two-pass
   * sequential distance transform (Rosenfeld-Pfaltz): a forward sweep taking
   * the minimum over the four already-visited neighbours of the 3 x 3 mask, and
   * a backward sweep over the other four. Two passes are exact for the
   * chessboard metric, which is why it is the metric used -- the alternative is
   * a per-cell search, and a builder calling `depthAt` over a thousand cells
   * would turn that into a million.
   *
   * Everything off the bounding box is outside the region by construction, so
   * an absent neighbour contributes distance 0 and a cell against the box edge
   * lands at depth 1, exactly as a cell against a concave notch does.
   */
  const depth = new Int32Array(span);
  {
    const unreached = bw + bh + 2;
    const read = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= bw || y >= bh ? 0 : depth[y * bw + x]!;
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        const at = y * bw + x;
        if (occupancy[at] === 0) continue;
        depth[at] =
          Math.min(
            unreached,
            read(x - 1, y),
            read(x - 1, y - 1),
            read(x, y - 1),
            read(x + 1, y - 1),
          ) + 1;
      }
    }
    for (let y = bh - 1; y >= 0; y -= 1) {
      for (let x = bw - 1; x >= 0; x -= 1) {
        const at = y * bw + x;
        if (occupancy[at] === 0) continue;
        const behind =
          Math.min(
            read(x + 1, y),
            read(x + 1, y + 1),
            read(x, y + 1),
            read(x - 1, y + 1),
          ) + 1;
        if (behind < depth[at]!) depth[at] = behind;
      }
    }
  }

  const inBox = (x: number, y: number): boolean =>
    x >= bx0 && x <= bx1 && y >= by0 && y <= by1;
  const slot = (x: number, y: number): number =>
    inBox(x, y) ? occupancy[(y - by0) * bw + (x - bx0)]! : 0;
  const depthAt = (x: number, y: number): number =>
    slot(x, y) === 0 ? 0 : depth[(y - by0) * bw + (x - bx0)]!;

  /**
   * Every maximal rectangle, found once and filtered per call -- maximality is
   * a property of the rectangle, not of the minimum a caller asked for, so the
   * enumeration does not depend on the arguments.
   *
   * Method: sweep rows as histogram bottoms. For row r, `runs[x]` is the number
   * of region cells ending at r in column x; the rectangle anchored at column x
   * is then `runs[x]` tall and spans from the nearest strictly shorter column on
   * the left to the nearest on the right, both found with a monotonic stack.
   * That candidate is already maximal in three directions -- it cannot grow left
   * or right because the bounding columns are shorter, and cannot grow up
   * because column x's run ends where it does -- so the only test left is
   * whether row r + 1 is solid across the span, which a prefix count answers in
   * constant time. The sweep is O(cells in the box) per row, against O(n^4) for
   * enumerating boxes, and it is complete: a maximal rectangle's bottom row is
   * some r, and at that row its own shortest column reproduces it exactly.
   *
   * Columns of equal height reproduce the same rectangle, so each row dedupes.
   */
  const allRects: Box[] = (() => {
    if (span === 0) return [];
    const found: Box[] = [];
    const runs = new Int32Array(bw);
    const prevShorter = new Int32Array(bw);
    const nextShorter = new Int32Array(bw);
    // Solid cells in the row below, as a prefix count, so "can this grow down"
    // is one subtraction instead of a walk along the span.
    const below = new Int32Array(bw + 1);
    const stack: number[] = [];
    const seen = new Set<number>();

    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1)
        runs[x] = occupancy[y * bw + x] === 0 ? 0 : runs[x]! + 1;

      stack.length = 0;
      for (let x = 0; x < bw; x += 1) {
        while (stack.length && runs[stack[stack.length - 1]!]! >= runs[x]!)
          stack.pop();
        prevShorter[x] = stack.length ? stack[stack.length - 1]! : -1;
        stack.push(x);
      }
      stack.length = 0;
      for (let x = bw - 1; x >= 0; x -= 1) {
        while (stack.length && runs[stack[stack.length - 1]!]! >= runs[x]!)
          stack.pop();
        nextShorter[x] = stack.length ? stack[stack.length - 1]! : bw;
        stack.push(x);
      }

      below[0] = 0;
      for (let x = 0; x < bw; x += 1)
        below[x + 1] =
          below[x]! + (y + 1 < bh && occupancy[(y + 1) * bw + x] !== 0 ? 1 : 0);

      seen.clear();
      for (let x = 0; x < bw; x += 1) {
        const tall = runs[x]!;
        if (tall === 0) continue;
        const x0 = prevShorter[x]! + 1;
        const x1 = nextShorter[x]! - 1;
        // Solid underneath across the whole span means this is a slice of a
        // taller rectangle the sweep will reach on a later row.
        if (below[x1 + 1]! - below[x0]! === x1 - x0 + 1) continue;
        const key = (x0 * bw + x1) * (bh + 1) + tall;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push([bx0 + x0, by0 + y - tall + 1, bx0 + x1, by0 + y]);
      }
    }

    // Area first, then top to bottom and left to right, with the far corner
    // breaking the last ties: a builder that takes `rects()[0]` must get the
    // same rectangle on every run, and two maximal rectangles can share an
    // area, a top edge and a left edge.
    found.sort((a, b) => {
      const areaA = (a[2] - a[0] + 1) * (a[3] - a[1] + 1);
      const areaB = (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
      return (
        areaB - areaA ||
        a[1] - b[1] ||
        a[0] - b[0] ||
        a[2] - b[2] ||
        a[3] - b[3]
      );
    });
    return found;
  })();

  const rects = (minWidth: number, minHeight: number): Box[] => {
    const wantW = Math.max(1, Math.ceil(minWidth) || 1);
    const wantH = Math.max(1, Math.ceil(minHeight) || 1);
    return allRects.filter(
      (r) => r[2] - r[0] + 1 >= wantW && r[3] - r[1] + 1 >= wantH,
    );
  };

  return {
    width: W,
    height: H,
    cells,
    bounds,
    area: cells.length,
    has: (x, y) => slot(x, y) !== 0,
    /**
     * The cell's index into the map grid, or -1 when it is not in the region.
     * Same addressing as `CellRef.cellIndex` and every other index in the
     * project; the -1 is what makes it worth calling over the arithmetic.
     */
    indexOf: (x, y) => (slot(x, y) === 0 ? -1 : y * W + x),
    depthAt,
    interior: (d) => cells.filter((c) => depthAt(c.x, c.y) >= d),
    border: () => cells.filter((c) => depthAt(c.x, c.y) === 1),
    rects,
    largestRect: (minWidth = 1, minHeight = 1) =>
      rects(minWidth, minHeight)[0] ?? null,
    /**
     * A step of 1 is every cell and a step below that is nothing; phases are
     * reduced into the step, so a caller may pass the raw offset it was
     * thinking in. `lattice(2, 1, 1)` is the candidate set `core.generateMicro`
     * already spaces spawns on.
     */
    lattice: (step, phaseX = 0, phaseY = 0) => {
      const s = Math.floor(step);
      if (!Number.isFinite(s) || s < 1) return [];
      const px = ((Math.floor(phaseX) % s) + s) % s;
      const py = ((Math.floor(phaseY) % s) + s) % s;
      return cells.filter((c) => c.x % s === px && c.y % s === py);
    },
    within: (box) => {
      const x0 = Math.min(box[0], box[2]);
      const x1 = Math.max(box[0], box[2]);
      const y0 = Math.min(box[1], box[3]);
      const y1 = Math.max(box[1], box[3]);
      const boxArea = (x1 - x0 + 1) * (y1 - y0 + 1);
      // A builder that partitioned its area asks about small boxes far more
      // often than large ones; walking the smaller of the two keeps that cheap
      // without changing the answer, which is ascending by index either way.
      if (boxArea > 0 && boxArea < cells.length) {
        const out: CellRef[] = [];
        for (let y = Math.max(y0, by0); y <= Math.min(y1, by1); y += 1)
          for (let x = Math.max(x0, bx0); x <= Math.min(x1, bx1); x += 1) {
            const at = slot(x, y);
            if (at !== 0) out.push(cells[at - 1]!);
          }
        return out;
      }
      return cells.filter(
        (c) => c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1,
      );
    },
  };
}
