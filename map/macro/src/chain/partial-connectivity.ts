/** Conservative connectivity view of collapsed placement slots (51.3, 51.4). */
import { orientedDesigns, parseKey } from "./declared-grid.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary, PassabilityPrescription, SegmentPrescription } from "./library.ts";
import { guaranteesPassability, passabilityFits, resolveSettledClass } from "./resolution.ts";
import type { Orientation, SegmentKey } from "./types.ts";

export type ConnectivityKind = "internal-hint" | "same-region" | "blocked" | "guaranteed" | "unresolved" | "conflict" | "outside";
/** Coordinates are tile coordinates, as in the placement trace's slot mask. */
export interface PlacementSlot { slot: number; x: number; y: number }
export interface PartialPlacedTile { design: string; orientation: Orientation }
export interface SeamSide {
  state: "outside" | "unplaced" | "placed";
  declared?: string;
  resolved?: string;
  passability?: PassabilityPrescription;
  adjacency?: string;
}
export interface PlacementSeam {
  key: SegmentKey;
  a: { x: number; y: number };
  b: { x: number; y: number };
  kind: ConnectivityKind;
  /** West for vertical segments, north for horizontal segments. */
  lower: SeamSide;
  upper: SeamSide;
}

const S = CHAIN_TILE_SIZE;
const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
interface CellView { side: SeamSide; conflict: boolean; slot?: PlacementSlot; design?: OrientedDesign }

/**
 * One canonical segment, with both authored sides. No WFC domains are needed: an
 * in-mask unplaced neighbour remains unknown. Caches belong to this call so undo
 * and replay seek cannot retain classes from an earlier placement.
 */
export function placementSeams(library: ChainLibrary, slots: readonly PlacementSlot[],
  tiles: ReadonlyMap<number, PartialPlacedTile>, turned = orientedDesigns(library)): PlacementSeam[] {
  const at = new Map(slots.map((slot) => [`${slot.x},${slot.y}`, slot]));
  const cells = new Map<string, CellView>();
  const designs = new Map<number, OrientedDesign>();
  const designOf = (slot: PlacementSlot): OrientedDesign | undefined => {
    let design = designs.get(slot.slot);
    const tile = tiles.get(slot.slot);
    if (!design && tile) designs.set(slot.slot, design = turned(tile.design, tile.orientation));
    return design;
  };
  const slotOf = (x: number, y: number) => at.get(`${Math.floor(x / S)},${Math.floor(y / S)}`);
  const stated = (slot: PlacementSlot, design: OrientedDesign, key: SegmentKey): SegmentPrescription | undefined => {
    const { axis, x, y } = parseKey(key);
    return design.segments.get(`${axis}:${x - slot.x * S},${y - slot.y * S}`);
  };
  const between = (x: number, y: number, dx: number, dy: number): SegmentKey =>
    dx ? `v:${x + Math.max(dx, 0)},${y}` : `h:${x},${y + Math.max(dy, 0)}`;
  const cellAt = (x: number, y: number): CellView => {
    const key = `${x},${y}`;
    const cached = cells.get(key);
    if (cached) return cached;
    const slot = slotOf(x, y), design = slot && designOf(slot);
    const result: CellView = { side: { state: !slot ? "outside" : !design ? "unplaced" : "placed" }, conflict: false, slot, design };
    cells.set(key, result);
    if (!slot || !design) return result;
    const declared = design.cells[(y - slot.y * S) * S + x - slot.x * S]!;
    result.side.declared = declared;
    let asked: string | undefined, waiting = false;
    for (const [dx, dy] of SIDES) {
      const beside = slotOf(x + dx, y + dy);
      if (!beside) continue;
      const neighbour = designOf(beside);
      if (!neighbour) { waiting = true; continue; }
      const required = stated(beside, neighbour, between(x, y, dx, dy))?.adjacency;
      if (required === undefined || required === "any") continue;
      if (declared !== "any" ? declared !== required : asked !== undefined && asked !== required) result.conflict = true;
      asked ??= required;
    }
    if (!result.conflict) {
      const resolved = resolveSettledClass(declared, asked, waiting);
      if (resolved !== undefined) result.side.resolved = resolved;
    }
    return result;
  };

  const candidates = new Set<SegmentKey>();
  for (const slot of slots) {
    const ox = slot.x * S, oy = slot.y * S;
    for (let i = 0; i < S; i++) {
      candidates.add(`h:${ox + i},${oy}`); candidates.add(`h:${ox + i},${oy + S}`);
      candidates.add(`v:${ox},${oy + i}`); candidates.add(`v:${ox + S},${oy + i}`);
    }
    const design = designOf(slot);
    if (!design) continue;
    for (const key of design.segments.keys()) {
      const { axis, x, y } = parseKey(key);
      candidates.add(`${axis}:${ox + x},${oy + y}`);
    }
    // Fixed uniform interiors have no visible seam. `any` endpoints can settle
    // differently, so keep those candidates and resolve only queried cells.
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const here = design.cells[y * S + x]!;
      if (x < S - 1) {
        const there = design.cells[y * S + x + 1]!;
        if (here !== there || here === "any") candidates.add(`v:${ox + x + 1},${oy + y}`);
      }
      if (y < S - 1) {
        const there = design.cells[(y + 1) * S + x]!;
        if (here !== there || here === "any") candidates.add(`h:${ox + x},${oy + y + 1}`);
      }
    }
  }

  const result: PlacementSeam[] = [];
  for (const key of candidates) {
    const { axis, x, y } = parseKey(key);
    const l = cellAt(x - (axis === "v" ? 1 : 0), y - (axis === "h" ? 1 : 0)), u = cellAt(x, y);
    const side = (cell: CellView): SeamSide => ({ ...cell.side,
      ...(cell.slot && cell.design ? stated(cell.slot, cell.design, key) : undefined) });
    const lower = side(l), upper = side(u);
    if (l.slot === u.slot && lower.resolved !== undefined && lower.resolved === upper.resolved &&
      !stated(l.slot!, l.design!, key)) continue;
    let kind: ConnectivityKind;
    if (lower.state === "outside" || upper.state === "outside") kind = "outside";
    else if (l.conflict || u.conflict || (lower.state === "placed" && upper.state === "placed" && !passabilityFits(lower.passability, upper.passability))) kind = "conflict";
    else if (lower.state === "unplaced" || upper.state === "unplaced") kind = "unresolved";
    else if (guaranteesPassability(lower.passability, upper.passability,
      lower.resolved === undefined || upper.resolved === undefined || lower.resolved === upper.resolved)) kind = "guaranteed";
    else if (lower.resolved !== undefined && lower.resolved === upper.resolved) {
      kind = lower.passability === "not-passable-hint" || upper.passability === "not-passable-hint" ? "internal-hint" : "same-region";
    } else if (lower.resolved === undefined || upper.resolved === undefined) kind = "unresolved";
    else kind = "blocked";
    result.push({ key, a: { x, y }, b: { x: x + (axis === "h" ? 1 : 0), y: y + (axis === "v" ? 1 : 0) }, kind, lower, upper });
  }
  return result;
}
