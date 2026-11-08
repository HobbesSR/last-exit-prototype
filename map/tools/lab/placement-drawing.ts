import type { orientedDesigns } from '../../macro/src/chain/declared-grid.ts';

export type Slot = { slot: number; x: number; y: number; col: number; row: number };
export type Tile = { design: string; orientation: 0 | 90 | 180 | 270; depth: number; piece?: string };

/** Set pieces are shown as internally open; their authored perimeter remains visible. */
export function drawPlacementTiles(
  ctx: CanvasRenderingContext2D, slots: Slot[], tiles: Map<number, Tile>,
  turned: ReturnType<typeof orientedDesigns> | null, scale: number, maxDepth: number,
) {
  const at = new Map(slots.map(slot => [`${slot.x},${slot.y}`, slot]));
  const samePiece = (slot: Slot, dx: number, dy: number, piece: string) => {
    const neighbour = at.get(`${slot.x + dx},${slot.y + dy}`);
    return neighbour !== undefined && tiles.get(neighbour.slot)?.piece === piece;
  };
  // Fill first so a neighbouring tile cannot cover an already drawn boundary.
  for (const slot of slots) {
    const tile = tiles.get(slot.slot);
    ctx.fillStyle = tile ? tile.piece ? '#31547e' : `hsl(${220 - 190 * tile.depth / maxDepth} 48% 42%)` : '#172129';
    const overlap = tile?.piece ? 0.5 / scale : 0;
    ctx.fillRect(slot.x * 6 - overlap, slot.y * 6 - overlap, 6 + overlap * 2, 6 + overlap * 2);
  }
  for (const slot of slots) {
    const tile = tiles.get(slot.slot), x = slot.x * 6, y = slot.y * 6;
    ctx.lineWidth = 0.7 / scale; ctx.strokeStyle = '#63717a'; ctx.setLineDash([]);
    for (const [dx, dy, ax, ay, bx, by] of [[0, -1, 0, 0, 6, 0], [1, 0, 6, 0, 6, 6], [0, 1, 0, 6, 6, 6], [-1, 0, 0, 0, 0, 6]] as const) {
      if (tile?.piece && samePiece(slot, dx, dy, tile.piece)) continue;
      ctx.beginPath(); ctx.moveTo(x + ax, y + ay); ctx.lineTo(x + bx, y + by); ctx.stroke();
    }
    if (!tile || !turned) continue;
    for (const [key, segment] of turned(tile.design, tile.orientation).segments) {
      const [a, b] = key.slice(2).split(',').map(Number) as [number, number];
      const h = key[0] === 'h';
      if (tile.piece) {
        // Suppress interior prescriptions and shared edges of this instance.
        if (h ? b !== 0 && b !== 6 : a !== 0 && a !== 6) continue;
        const dx = h ? 0 : a === 0 ? -1 : 1, dy = h ? b === 0 ? -1 : 1 : 0;
        if (samePiece(slot, dx, dy, tile.piece)) continue;
      }
      const hint = segment.passability === 'not-passable-hint';
      ctx.lineWidth = (hint ? 2.4 : 0.8) / scale;
      ctx.strokeStyle = hint ? '#0b1015' : '#d2e0c4';
      ctx.setLineDash(segment.passability === 'any' || !segment.passability ? [1 / scale, 2 / scale] : []);
      ctx.beginPath(); ctx.moveTo(x + a, y + b); ctx.lineTo(x + a + (h ? 1 : 0), y + b + (h ? 0 : 1)); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}
