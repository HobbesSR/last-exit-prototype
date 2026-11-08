import type { PlacementSeam, SeamSide } from '../../macro/src/chain/partial-connectivity.ts';

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
