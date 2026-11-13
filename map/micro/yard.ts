import type { Cell } from './types.ts';

/** A hunter occupies a 2x2 block of clear access cells, anchored at its top left. */
export function hunterBlockFits(clear: (x: number, y: number) => boolean): (x: number, y: number) => boolean {
  return (x, y) => clear(x, y) && clear(x + 1, y) && clear(x, y + 1) && clear(x + 1, y + 1);
}

/** Flood one-cell steps between fitting hunter blocks, east, west, south, north.
 * Seeds join one reached set. Passing existing labels adds a component whose id
 * is the prior reached-block count; callers choose component seed order. */
export function floodHunterYard(fits: (x: number, y: number) => boolean, seeds: readonly Cell[], reached = new Map<string, number>()) {
  const id = reached.size, cells: Cell[] = [];
  const add = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (reached.has(key) || !fits(x, y)) return;
    reached.set(key, id); cells.push({ x, y });
  };
  for (const { x, y } of seeds) add(x, y);
  for (let head = 0; head < cells.length; head++) {
    const { x, y } = cells[head]!;
    add(x + 1, y); add(x - 1, y); add(x, y + 1); add(x, y - 1);
  }
  return { reached, cells };
}
