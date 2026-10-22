import { rect } from '../../../shared/shape.ts';
import type { ObstacleKind } from '../../../shared/types.ts';
import type { Placeable } from './placeable.ts';

/*
 * `cover-piece`: one crate, barrier or container standing in its cells. `cover` clusters them on
 * open ground, and `coverNear` guards a site with a container.
 */

/** Each piece's kind and footprint in cells, unturned. */
export const COVER_PIECES = Object.freeze({
  crate: { kind: 'crate', w: 1, h: 1 },
  barrier: { kind: 'ruin-wall', w: 2, h: 1 },
  container: { kind: 'container', w: 2, h: 1 },
} satisfies Record<string, { kind: ObstacleKind; w: number; h: number }>);
export type CoverPieceName = keyof typeof COVER_PIECES;

export interface CoverPieceParams {
  piece: CoverPieceName;
  /** Whether its footprint is turned a quarter, swapping width and height. */
  turned: boolean;
  /** From 0 to 1: how much of its footprint's length a crate or barrier takes. A container ignores it. */
  length: number;
  /** From 0 to 1: where along its footprint a shorter piece stands. */
  offset: number;
}

/** A piece's shape inside its footprint of `w` × `h` world units, along the footprint's long axis. */
function drawn(piece: CoverPieceName, w: number, h: number, length: number, offset: number) {
  const along = w >= h, long = Math.max(w, h), short = Math.min(w, h);
  const [l, t] = piece === 'crate' ? [long * (0.6 + length * 0.25), long * (0.6 + length * 0.25)]
    : piece === 'barrier' ? [long * (0.7 + length * 0.25), short * 0.3] : [long * 0.95, short * 0.9];
  const a = (long - l) * offset, b = (short - t) / 2;
  return along ? rect(Math.round(a), Math.round(b), Math.round(l), Math.round(t)) : rect(Math.round(b), Math.round(a), Math.round(t), Math.round(l));
}

export const COVER_PIECE = Object.freeze<Placeable<CoverPieceParams>>({
  id: 'cover-piece',
  version: 'cover-piece-1',
  summary: 'A crate, barrier or container: low cover standing inside its cells.',
  params: [
    { name: 'piece', summary: 'Which piece.', kind: 'enum', values: Object.keys(COVER_PIECES) },
    { name: 'turned', summary: 'Footprint turned a quarter.', kind: 'boolean' },
    { name: 'length', summary: 'Share of the footprint a crate or barrier takes.', kind: 'number', min: 0, max: 1 },
    { name: 'offset', summary: 'Where a shorter piece stands along its footprint.', kind: 'number', min: 0, max: 1 },
  ],
  examples: [
    { piece: 'crate', turned: false, length: 0.5, offset: 0.5 },
    { piece: 'barrier', turned: true, length: 0.2, offset: 0.9 },
    { piece: 'container', turned: false, length: 1, offset: 0.5 },
  ],
  build({ piece, turned, length, offset }: CoverPieceParams, cellSize: number) {
    const { kind, w: across, h: down } = COVER_PIECES[piece], w = turned ? down : across, h = turned ? across : down;
    const shape = drawn(piece, w * cellSize, h * cellSize, length, offset);
    return { elements: [{ x: 0, y: 0, template: { w: w * cellSize, h: h * cellSize, parts: [{ part: 'obstacle' as const, shape, kind }] } }],
      demand: { body: { w, h }, clear: [] }, details: undefined };
  },
});
