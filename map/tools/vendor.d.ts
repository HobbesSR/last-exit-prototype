declare module 'pathfinding' {
  /** Row-major walkability: 0 is walkable, 1 is blocked. Indexed [y][x]. */
  export class Grid {
    constructor(matrix: number[][]);
  }
  export class AStarFinder {
    constructor(options?: { allowDiagonal?: boolean; dontCrossCorners?: boolean });
    /** Returns `[x, y]` pairs in grid coordinates, including both endpoints. */
    findPath(startX: number, startY: number, endX: number, endY: number, grid: Grid): number[][];
  }

  const PF: { Grid: typeof Grid; AStarFinder: typeof AStarFinder };
  export default PF;
}
