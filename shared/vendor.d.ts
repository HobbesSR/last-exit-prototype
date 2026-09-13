// Minimal ambient declarations for the two untyped vendor libraries. These describe only the
// surface this project actually calls, so an unused SAT or PathFinding entry point is a type
// error rather than an `any` that silently spreads through collision and routing code.

declare module 'sat' {
  export class Vector {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    sub(other: Vector): this;
  }
  export class Circle {
    constructor(pos: Vector, r: number);
    pos: Vector;
    r: number;
  }
  export class Polygon {
    /** Points are offsets from `pos`, wound consistently; SAT requires them to be convex. */
    constructor(pos?: Vector, points?: Vector[]);
    pos: Vector;
  }
  export class Box {
    constructor(pos: Vector, w: number, h: number);
    toPolygon(): Polygon;
  }
  export class Response {
    overlap: number;
    overlapV: Vector;
    clear(): this;
  }
  export function testCircleCircle(a: Circle, b: Circle, response?: Response): boolean;
  export function testCirclePolygon(a: Circle, b: Polygon, response?: Response): boolean;
  export function testPolygonPolygon(a: Polygon, b: Polygon, response?: Response): boolean;
  export function pointInPolygon(point: Vector, poly: Polygon): boolean;

  const SAT: {
    Vector: typeof Vector;
    Circle: typeof Circle;
    Polygon: typeof Polygon;
    Box: typeof Box;
    Response: typeof Response;
    testCircleCircle: typeof testCircleCircle;
    testCirclePolygon: typeof testCirclePolygon;
    testPolygonPolygon: typeof testPolygonPolygon;
    pointInPolygon: typeof pointInPolygon;
  };
  export default SAT;
}

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
