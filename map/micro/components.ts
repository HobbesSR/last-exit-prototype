import { cellKey, type Cell } from '../kernel/cell.ts';

/**
 * The 4-connected components of `cells` outside `kept`, the unused yard a builder may offer
 * (20.7). Each component starts at its first cell in `cells` order and grows breadth-first,
 * neighbours east, south, west, north, so offer identities and cell order follow the caller.
 * Unlike `connectedComponents`, it neither canonicalizes nor limits size or span.
 */
export function unusedComponents<C extends Cell>(cells: readonly C[], kept: ReadonlySet<string>): C[][] {
  const unused = new Map(cells.filter(c => !kept.has(cellKey(c))).map(c => [cellKey(c), c]));
  const components: C[][] = [];
  for (const start of cells) {
    if (!unused.delete(cellKey(start))) continue;
    const component = [start];
    for (let head = 0; head < component.length; head++) {
      const { x, y } = component[head]!;
      for (const [nx, ny] of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]] as const) {
        const key = cellKey({ x: nx, y: ny }), next = unused.get(key);
        if (next) { unused.delete(key); component.push(next); }
      }
    }
    components.push(component);
  }
  return components;
}
