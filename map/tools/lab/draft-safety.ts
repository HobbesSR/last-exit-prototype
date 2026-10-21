import { CHAIN_LIBRARY_VERSION, CHAIN_TILE_SIZE } from "../../macro/src/chain/library.ts";
import type { ChainLibrary } from "../../macro/src/chain/library.ts";

// This is an editor safety gate, not publish/generate validation (53, "Saved drafts").
// Empty collections, unresolved references and invalid rule values must survive a draft
// round trip. Every rule here must be no stricter than validateLibrary's, or a valid
// import is refused; tests/map-lab-draft-safety.test.js holds that.
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const arrayOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);
const optional = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  value === undefined || check(value);
const valuesOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  record(value) && Object.values(value).every(check);
const counts = (value: unknown): boolean => valuesOf(value, (v) => string(v) || finite(v));

export function renderableDraft(raw: unknown): raw is ChainLibrary {
  if (!record(raw) || raw.version !== CHAIN_LIBRARY_VERSION ||
    !string(raw.name) || !string(raw.zonePlan) || !finite(raw.zoneWidth) || !finite(raw.zoneHeight)) return false;
  return valuesOf(raw.cellClasses, (entry) => record(entry) && string(entry.regionType) &&
      optional(entry.params, (v) => valuesOf(v, (p) => string(p) || finite(p) || typeof p === "boolean")) &&
      optional(entry.coreElements, counts)) &&
    arrayOf(raw.tiles, (tile) => {
      if (!record(tile) || !string(tile.id) || !string(tile.defaultCellClass) ||
        !arrayOf(tile.orientations, finite) ||
        !optional(tile.eligibleTiers, (v) => arrayOf(v, finite)) ||
        !optional(tile.eligibleBonus, (v) => arrayOf(v, finite)) ||
        !optional(tile.labels, (v) => arrayOf(v, string)) ||
        !optional(tile.weight, finite) ||
        !optional(tile.legend, (v) => valuesOf(v, string))) return false;
      // orientDesign dereferences every non-default mark; do not let a broken
      // grid/legend reach thumbnails (which are rendered outside the preview catch).
      if (tile.cells !== undefined && (!Array.isArray(tile.cells) ||
        tile.cells.length !== CHAIN_TILE_SIZE || !tile.cells.every((row: unknown) =>
          string(row) && row.length === CHAIN_TILE_SIZE && row.split("").every((mark) =>
            mark === "." || (record(tile.legend) && Object.hasOwn(tile.legend, mark) && string(tile.legend[mark])))))) return false;
      return optional(tile.segments, (segments) => record(segments) &&
        Object.entries(segments).every(([key, value]) =>
          /^[vh]:[0-6],[0-5]$/.test(key) && record(value) &&
          optional(value.adjacency, string) && optional(value.passability, string)));
    }) &&
    arrayOf(raw.tileSets, (set) => record(set) && string(set.id) && arrayOf(set.members, string)) &&
    arrayOf(raw.setPieces, (piece) => record(piece) && string(piece.id) &&
      arrayOf(piece.tiles, (slot) => record(slot) && finite(slot.dx) &&
        finite(slot.dy) && string(slot.tileSetId) && optional(slot.orientation, finite)) &&
      optional(piece.eligibleTiers, (v) => arrayOf(v, finite)) && optional(piece.primaryRegionClass, string)) &&
    arrayOf(raw.setPieceClasses, (group) => record(group) && string(group.id) &&
      string(group.placementRule) && finite(group.quota) && arrayOf(group.setPieces, string) &&
      optional(group.coreElements, counts));
}
