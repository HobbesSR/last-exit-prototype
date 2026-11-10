/**
 * Experimental (#851): the bundled libraries with fewer passable halves on tile sides, so
 * regions have fewer portals (17.2.11 "Fewer portals per region", 52.1). Nothing generates
 * with these unless asked: the Map Lab offers them as a library source, and adoption is a
 * separate, versioned content batch (31). Results: 42.40.
 *
 * Only a side authored as the half-and-half pattern (`hhhPPP`, or `PPPhhh` once reversed)
 * changes, and it changes whole: it stays as authored or becomes fully hinted (`hhhhhh`). So
 * every opening that remains is still a whole 3-cell passable block (the width rule, 52.1),
 * and placement's open-face rule keeps regions connected to each other (51.3, #857). Each
 * region's builder still keeps its own portals reachable from one another (20.1).
 */
import type { ChainLibrary, ChainSetPiece, ChainTileDesign } from './macro/src/chain/library.ts';

type Tile = ChainTileDesign;
type Side = 'N' | 'E' | 'S' | 'W';
const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
/** The library writes `h:line,offset`: north h:0, south h:6, west v:0, east v:6 (52, "Coordinates"). */
const LINE: Record<Side, string> = { N: 'h:0', E: 'v:6', S: 'h:6', W: 'v:0' };
const HINT = 'not-passable-hint';

/**
 * How the fill's half-and-half tiles change.
 * - `bundled`: as authored.
 * - `sparse`: each fillable tile with two or more half-and-half sides becomes a family whose
 *   members keep only one or two of those sides open and hint the rest; the authored tile
 *   stays as a fallback with `SPARSE_FALLBACK_SHARE` of the family's weight. Existing
 *   closed-side variants (`-closed-*`) are replaced by the family.
 */
export type FillSides = 'bundled' | 'sparse';
/**
 * How set pieces' half-and-half sides change. Every scheme but `bundled` hints the seams
 * between a set piece's own slots, so no internal guaranteed run forms inside it.
 * - `inner`: outer sides as authored.
 * - `alternate`: walking each outer face, every other slot side stays open, from the first:
 *   about one portal per 12 cells of a set piece's border.
 * - `face`: one opening per outer face, at its middle slot.
 */
export type SetPieceSides = 'bundled' | 'inner' | 'alternate' | 'face';
export interface SparseSides { fill: FillSides; setPieces: SetPieceSides }

/** The share of a sparse family's weight its authored, all-open tile keeps as the fallback (52.1 "Keep today's tiles eligible"). */
export const SPARSE_FALLBACK_SHARE = 0.1;

const sideOf = (tile: Tile, side: Side): string => Array.from({ length: 6 }, (_, i) => {
  const passability = tile.segments?.[`${LINE[side]},${i}`]?.passability;
  return passability === 'passable' ? 'P' : passability === HINT ? 'h' : passability === 'any' ? 'a' : '.';
}).join('');
/** Whether a side is the half-and-half pattern, in either direction (rotation reverses a side). */
const halfAndHalf = (tile: Tile, side: Side): boolean => ['hhhPPP', 'PPPhhh'].includes(sideOf(tile, side));

function hintSides(tile: Tile, sides: Iterable<Side>): void {
  for (const side of sides) for (let i = 0; i < 6; i++)
    (tile.segments ??= {})[`${LINE[side]},${i}`] = { ...tile.segments?.[`${LINE[side]},${i}`], passability: HINT };
}

function sparseFill(library: ChainLibrary): void {
  library.tiles = library.tiles.filter((tile) => !(tile.fillable !== false && /-closed-[nesw]+$/.test(tile.id)));
  const added: Tile[] = [];
  for (const tile of library.tiles) {
    if (tile.fillable === false || tile.weight === 0) continue;
    const open = SIDES.filter((side) => halfAndHalf(tile, side));
    if (open.length < 2) continue;
    const keep = [...open.map((side) => [side]), ...(open.length > 2 ? open.flatMap((a, i) => open.slice(i + 1).map((b) => [a, b])) : [])];
    const weight = tile.weight ?? 1;
    tile.weight = weight * SPARSE_FALLBACK_SHARE;
    for (const kept of keep) {
      const variant = structuredClone(tile);
      variant.id = `${tile.id}-open-${kept.join('').toLowerCase()}`;
      variant.weight = weight * (1 - SPARSE_FALLBACK_SHARE) / keep.length;
      hintSides(variant, open.filter((side) => !kept.includes(side)));
      added.push(variant);
    }
  }
  library.tiles.push(...added);
}

/** The tile-frame side a slot's piece-frame side shows, for a slot turned clockwise by `orientation`. */
const tileSide = (side: Side, orientation: number): Side => SIDES[(SIDES.indexOf(side) - orientation / 90 + 8) % 4]!;
const STEP: Record<Side, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Each outer face of a set piece: maximal runs of slots sharing an outer side and a line, in order along it. */
function outerFaces(piece: ChainSetPiece): Array<{ side: Side; slots: number[] }> {
  const at = new Map(piece.tiles.map((slot, i) => [`${slot.dx},${slot.dy}`, i]));
  const faces: Array<{ side: Side; slots: number[] }> = [];
  for (const side of SIDES) {
    const along: [number, number] = side === 'N' || side === 'S' ? [1, 0] : [0, 1];
    const outer = piece.tiles.map((slot, i) => ({ slot, i }))
      .filter(({ slot }) => !at.has(`${slot.dx + STEP[side][0]},${slot.dy + STEP[side][1]}`))
      .sort((a, b) => (along[0] ? a.slot.dy - b.slot.dy || a.slot.dx - b.slot.dx : a.slot.dx - b.slot.dx || a.slot.dy - b.slot.dy));
    for (const { slot, i } of outer) {
      const last = faces.at(-1);
      const prev = last?.side === side ? piece.tiles[last.slots.at(-1)!]! : undefined;
      if (prev && prev.dx + along[0] === slot.dx && prev.dy + along[1] === slot.dy) last!.slots.push(i);
      else faces.push({ side, slots: [i] });
    }
  }
  return faces;
}

function sparseSetPieces(library: ChainLibrary, scheme: Exclude<SetPieceSides, 'bundled'>): void {
  const tiles = new Map(library.tiles.map((tile) => [tile.id, tile]));
  const sets = new Map(library.tileSets.map((set) => [set.id, set]));
  const made = new Map<string, string>();
  for (const piece of library.setPieces) {
    const at = new Set(piece.tiles.map((slot) => `${slot.dx},${slot.dy}`));
    // Piece-frame sides to hint, per slot.
    const closed = piece.tiles.map((slot) => new Set(SIDES.filter((side) => at.has(`${slot.dx + STEP[side][0]},${slot.dy + STEP[side][1]}`))));
    if (scheme !== 'inner') for (const face of outerFaces(piece)) face.slots.forEach((i, k) => {
      const open = scheme === 'alternate' ? k % 2 === 0 : k === Math.floor((face.slots.length - 1) / 2);
      if (!open) closed[i]!.add(face.side);
    });
    piece.tiles = piece.tiles.map((slot, i) => {
      const members = sets.get(slot.tileSetId)?.members ?? [];
      const turned = (member: Tile) => slot.orientation !== undefined ? [slot.orientation] : member.orientations;
      // Only a member whose orientation the slot fixes can be rewritten side by side.
      if (slot.orientation === undefined && members.some((id) => (tiles.get(id)?.orientations.length ?? 1) > 1)) return slot;
      const rewritten = members.map((id) => {
        const member = tiles.get(id)!;
        const hint = [...closed[i]!].map((side) => tileSide(side, turned(member)[0]!)).filter((side) => halfAndHalf(member, side)).sort();
        if (!hint.length) return id;
        const variantId = `${id}-sp-${hint.join('').toLowerCase()}`;
        if (!tiles.has(variantId)) {
          const variant = structuredClone(member);
          variant.id = variantId;
          variant.fillable = false;
          hintSides(variant, hint);
          library.tiles.push(variant);
          tiles.set(variantId, variant);
        }
        return variantId;
      });
      if (rewritten.every((id, k) => id === members[k])) return slot;
      const key = rewritten.join('+');
      let setId = made.get(key);
      if (!setId) {
        setId = `${slot.tileSetId}-sp-${made.size}`;
        made.set(key, setId);
        library.tileSets.push({ id: setId, members: rewritten });
        sets.set(setId, library.tileSets.at(-1)!);
      }
      return { ...slot, tileSetId: setId };
    });
  }
}

/** The bundled library `bundled` with sparser sides (#851). Returns a new library; `bundled` is untouched. */
export function sparseSidesLibrary(bundled: ChainLibrary, options: SparseSides): ChainLibrary {
  const library = structuredClone(bundled);
  library.name = `${bundled.name}-sparse-${options.fill}-${options.setPieces}`;
  // A closed set-piece side can't meet another piece's open one, so placement checks pieces it places side by side (#856).
  library.fitPlacedSetPieces = true;
  if (options.fill === 'sparse') sparseFill(library);
  if (options.setPieces !== 'bundled') sparseSetPieces(library, options.setPieces);
  return library;
}
