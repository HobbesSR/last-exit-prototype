/** The cells of a `w` × `h` rectangle at the origin, row by row, keeping those `keep(x, y)` accepts. */
export function cellsOf(w, h, keep = () => true) {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
}
