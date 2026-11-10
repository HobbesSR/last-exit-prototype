import type { PlacementSeam, SeamSide } from '../../macro/src/chain/partial-connectivity.ts';
import type { Slot } from './placement-drawing.ts';

type Style = { colour: string; width: number; dash?: readonly number[] };
const derived: Partial<Record<PlacementSeam['kind'], Style>> = {
  'internal-hint': { colour: '#e879c6', width: 2 },
  blocked: { colour: '#03070a', width: 3 },
  guaranteed: { colour: '#d7f4d4', width: 1.4 },
  unresolved: { colour: '#98a7b7', width: 1, dash: [2, 3] },
  conflict: { colour: '#ff9d4d', width: 2, dash: [3, 2] },
  outside: { colour: '#596671', width: 1 },
};
const authored = (side: SeamSide): Style | undefined => {
  if (side.state === 'outside') return undefined;
  if (side.state === 'unplaced') return { colour: '#98a7b7', width: 1, dash: [2, 3] };
  if (side.passability === 'not-passable-hint') return { colour: '#03070a', width: 2 };
  if (side.passability === 'passable') return { colour: '#d7f4d4', width: 1.4 };
  return { colour: '#98a7b7', width: 1, dash: [2, 3] };
};

/** Draw canonical segments in style batches; widths and offsets are CSS pixels. */
export function drawPlacementSeams(ctx: CanvasRenderingContext2D, seams: readonly PlacementSeam[], scale: number,
  mode: 'connectivity' | 'authored'): number {
  const batches = new Map<string, { style: Style; lines: [number, number, number, number][] }>();
  const add = (seam: PlacementSeam, style: Style | undefined, offset = 0) => {
    if (!style) return false;
    const key = `${style.colour}/${style.width}/${style.dash?.join(',') ?? ''}`;
    let batch = batches.get(key);
    if (!batch) batches.set(key, batch = { style, lines: [] });
    const vertical = seam.a.x === seam.b.x;
    const dx = vertical ? offset / scale : 0, dy = vertical ? 0 : offset / scale;
    batch.lines.push([seam.a.x + dx, seam.a.y + dy, seam.b.x + dx, seam.b.y + dy]);
    return true;
  };
  let drawn = 0;
  for (const seam of seams) {
    if (mode === 'connectivity') {
      if (add(seam, derived[seam.kind])) drawn++;
    } else {
      const lower = add(seam, authored(seam.lower), -1.5);
      const upper = add(seam, authored(seam.upper), 1.5);
      if (lower || upper) drawn++;
    }
  }
  ctx.save();
  for (const { style, lines } of batches.values()) {
    ctx.strokeStyle = style.colour; ctx.lineWidth = style.width / scale;
    ctx.setLineDash((style.dash ?? []).map(n => n / scale));
    ctx.beginPath();
    for (const [ax, ay, bx, by] of lines) { ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
    ctx.stroke();
  }
  ctx.restore();
  return drawn;
}

/** Draw connectivity skeleton (#883): spanning tree and extra open seams. */
export function drawPlacementSkeleton(
  ctx: CanvasRenderingContext2D,
  slots: readonly Slot[],
  edges: readonly { slotA: number; slotB: number; dir: 'E' | 'S'; isTree: boolean }[],
  scale: number,
): number {
  if (!edges.length || !slots.length) return 0;
  const slotMap = new Map<number, Slot>(slots.map(s => [s.slot, s]));

  ctx.save();

  // First pass: center-to-center graph connections
  // Tree connections: teal
  ctx.strokeStyle = '#7adbc188';
  ctx.lineWidth = 2.5 / scale;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const edge of edges) {
    if (!edge.isTree) continue;
    const a = slotMap.get(edge.slotA), b = slotMap.get(edge.slotB);
    if (!a || !b) continue;
    ctx.moveTo(a.x * 6 + 3, a.y * 6 + 3);
    ctx.lineTo(b.x * 6 + 3, b.y * 6 + 3);
  }
  ctx.stroke();

  // Extra open connections: gold dashed
  ctx.strokeStyle = '#f7cd8b88';
  ctx.lineWidth = 2 / scale;
  ctx.setLineDash([3 / scale, 2 / scale]);
  ctx.beginPath();
  for (const edge of edges) {
    if (edge.isTree) continue;
    const a = slotMap.get(edge.slotA), b = slotMap.get(edge.slotB);
    if (!a || !b) continue;
    ctx.moveTo(a.x * 6 + 3, a.y * 6 + 3);
    ctx.lineTo(b.x * 6 + 3, b.y * 6 + 3);
  }
  ctx.stroke();

  // Second pass: boundary seam highlights
  // Tree seams: solid teal
  ctx.strokeStyle = '#7adbc1';
  ctx.lineWidth = 3 / scale;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const edge of edges) {
    if (!edge.isTree) continue;
    const a = slotMap.get(edge.slotA);
    if (!a) continue;
    if (edge.dir === 'E') {
      const x = (a.x + 1) * 6;
      ctx.moveTo(x, a.y * 6);
      ctx.lineTo(x, (a.y + 1) * 6);
    } else {
      const y = (a.y + 1) * 6;
      ctx.moveTo(a.x * 6, y);
      ctx.lineTo((a.x + 1) * 6, y);
    }
  }
  ctx.stroke();

  // Extra open seams: dashed gold
  ctx.strokeStyle = '#f7cd8b';
  ctx.lineWidth = 2.5 / scale;
  ctx.setLineDash([4 / scale, 2 / scale]);
  ctx.beginPath();
  for (const edge of edges) {
    if (edge.isTree) continue;
    const a = slotMap.get(edge.slotA);
    if (!a) continue;
    if (edge.dir === 'E') {
      const x = (a.x + 1) * 6;
      ctx.moveTo(x, a.y * 6);
      ctx.lineTo(x, (a.y + 1) * 6);
    } else {
      const y = (a.y + 1) * 6;
      ctx.moveTo(a.x * 6, y);
      ctx.lineTo((a.x + 1) * 6, y);
    }
  }
  ctx.stroke();

  ctx.restore();
  return edges.length;
}
