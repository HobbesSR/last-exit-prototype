export type Slot = { slot: number; x: number; y: number; col: number; row: number };
export type Tile = { design: string; orientation: 0 | 90 | 180 | 270; depth: number; piece?: string };

/** Depth/instance fills, with optional faint tile guides independent of connectivity. */
export function drawPlacementTiles(
  ctx: CanvasRenderingContext2D, slots: Slot[], tiles: Map<number, Tile>,
  scale: number, maxDepth: number, showGrid = false,
) {
  // Fill first so a neighbouring tile cannot cover an already drawn boundary.
  for (const slot of slots) {
    const tile = tiles.get(slot.slot);
    ctx.fillStyle = tile ? tile.piece ? '#31547e' : `hsl(${220 - 190 * tile.depth / maxDepth} 48% 42%)` : '#172129';
    const overlap = tile?.piece ? 0.5 / scale : 0;
    ctx.fillRect(slot.x * 6 - overlap, slot.y * 6 - overlap, 6 + overlap * 2, 6 + overlap * 2);
  }
  if (!showGrid) return;
  const at = new Map(slots.map(slot => [`${slot.x},${slot.y}`, slot]));
  const samePiece = (slot: Slot, dx: number, dy: number, piece: string) => {
    const neighbour = at.get(`${slot.x + dx},${slot.y + dy}`);
    return neighbour !== undefined && tiles.get(neighbour.slot)?.piece === piece;
  };
  for (const slot of slots) {
    const tile = tiles.get(slot.slot), x = slot.x * 6, y = slot.y * 6;
    ctx.lineWidth = 0.7 / scale; ctx.strokeStyle = '#63717a'; ctx.setLineDash([]);
    for (const [dx, dy, ax, ay, bx, by] of [[0, -1, 0, 0, 6, 0], [1, 0, 6, 0, 6, 6], [0, 1, 0, 6, 6, 6], [-1, 0, 0, 0, 0, 6]] as const) {
      if (tile?.piece && samePiece(slot, dx, dy, tile.piece)) continue;
      ctx.beginPath(); ctx.moveTo(x + ax, y + ay); ctx.lineTo(x + bx, y + by); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}
