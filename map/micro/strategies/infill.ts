import { compareCells } from '../../kernel/cell.ts';
import { COVER_PIECE } from '../placeables/cover-piece.ts';
import { expectPlaced, placedElements } from '../placeables/placeable.ts';
import { draw } from '../random.ts';
import type { BuilderCanvas } from '../canvas.ts';
import type { Cell, RegionBrief, RegionElement } from '../types.ts';

type Channels = { infill: number; infillLength: number; infillOffset: number };

/** A canonical post-primary crate pass. Siting and any route proof belong to the builder. */
export function infillCrates({ brief, canvas, chance, channels, label, site, accept, drawAt, commitError }: {
  brief: RegionBrief;
  canvas: BuilderCanvas;
  chance: number;
  channels: Channels;
  label: string;
  site: (cell: Cell) => boolean;
  accept?: (element: RegionElement) => boolean;
  drawAt?: (cell: Cell) => Cell;
  commitError: (label: string) => string;
}): number {
  let count = 0;
  if (chance <= 0) return count;
  for (const cell of canvas.addressed.unaddressedComponents().flat().sort(compareCells)) {
    if (canvas.addressed.addressed(cell.x, cell.y)) continue;
    const at = drawAt?.(cell) ?? cell;
    if (draw(brief.seed, at.x, at.y, channels.infill) >= chance || !site(cell)) continue;
    const name = `${label}-${count + 1}`;
    const [element] = placedElements(expectPlaced(COVER_PIECE.build({
      piece: 'crate', turned: false,
      length: draw(brief.seed, at.x, at.y, channels.infillLength),
      offset: draw(brief.seed, at.x, at.y, channels.infillOffset),
    }, brief.cellSize)), name, cell.x, cell.y, brief.cellSize) as [RegionElement];
    if (accept && !accept(element)) continue;
    if (!canvas.commit({ elements: [element] })) throw new Error(commitError(name));
    count++;
  }
  return count;
}
