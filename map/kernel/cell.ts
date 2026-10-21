/** A cell in global integer cell coordinates, the unit both levels count space in. */
export interface Cell { x: number; y: number }

/** A cell's set and map key, `x,y`. */
export function cellKey(cell: Cell): string { return `${cell.x},${cell.y}`; }

/** Row-major cell order: by y, then x. */
export function compareCells(a: Cell, b: Cell): number { return a.y - b.y || a.x - b.x; }
