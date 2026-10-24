import { draw } from '../random.ts';
import { hintedCells } from '../hints.ts';
import type { Cell, RegionBrief, RegionMask } from '../types.ts';

/**
 * Slot origins `period` cells apart over the mask's bounds, in row order, so nothing depends on
 * the brief's cell order. The phase is seeded on `channels` at (0, 0), unless the brief has a
 * hint: then the first hinted cell lies on the lattice. Shared by `park` and `plant`.
 */
export function latticeSlots(brief: RegionBrief, mask: RegionMask, period: number, channels: { x: number; y: number }): Cell[] {
  const phase = { x: Math.floor(draw(brief.seed, 0, 0, channels.x) * period), y: Math.floor(draw(brief.seed, 0, 0, channels.y) * period) };
  const firstHint = hintedCells(brief)[0];
  if (firstHint) { phase.x = ((firstHint.x % period) + period) % period; phase.y = ((firstHint.y % period) + period) % period; }
  const span = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const { x, y } of mask.cells) Object.assign(span, { x0: Math.min(span.x0, x), y0: Math.min(span.y0, y), x1: Math.max(span.x1, x), y1: Math.max(span.y1, y) });
  const first = (min: number, offset: number) => offset + Math.floor((min - offset) / period) * period;
  const slots: Cell[] = [];
  for (let y = first(span.y0, phase.y); y <= span.y1; y += period)
    for (let x = first(span.x0, phase.x); x <= span.x1; x += period) slots.push({ x, y });
  return slots;
}
