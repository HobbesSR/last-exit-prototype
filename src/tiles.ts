/**
 * The tile authoring format: what a template may say, and what is rejected.
 *
 * Derivation lives in primitives.ts; this module only validates the shorthands
 * (`cells`, `legend`, `walls`, `edges`, `corners`) and the explicit
 * `primitives` overrides, and adapts the resolved model back to the older
 * class/solid/wall view.
 */
import type { InteriorWall, Orientation, TileDesign } from "./types.ts";
import {
  INTERIOR_MARGIN,
  TILE_SIZE,
  cellAt,
  isPerimeterVertex,
  resolvePrimitives,
  tilePrimitives,
  vertexAt,
  wallsFrom,
} from "./primitives.ts";

export { INTERIOR_MARGIN, TILE_SIZE };

/** Rotated per-cell classes, solid mask and interior walls, in tile-local cells. */
export interface TileShape {
  classes: string[];
  blocked: Uint8Array;
  walls: InteriorWall[];
}

const inside = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= INTERIOR_MARGIN &&
  v <= TILE_SIZE - INTERIOR_MARGIN;
const marginBound = (i: number) =>
  i >= INTERIOR_MARGIN && i <= TILE_SIZE - 1 - INTERIOR_MARGIN;

/** Does the template say anything beyond an empty box with deferring sides? */
export function hasInterior(tile: TileDesign | null | undefined): boolean {
  return Boolean(
    tile?.cells?.length ||
    tile?.walls?.length ||
    tile?.edges ||
    tile?.corners ||
    tile?.primitives,
  );
}

function validateDeclaration(value: unknown, where: string): string[] {
  if (value === "any" || value === "open" || value === "wall") return [];
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    value[0]! >= 0 &&
    value[1]! <= 1 &&
    value[0]! < value[1]!
  )
    return [];
  return [`${where} must be "any", "open", "wall" or an open span in 0..1`];
}

export function validateTileShape(tile: TileDesign): string[] {
  const errors: string[] = [];
  const legend = tile.legend ?? {};
  if (tile.legend !== undefined) {
    if (!tile.legend || typeof legend !== "object" || Array.isArray(legend))
      errors.push("legend must be an object");
    else
      for (const [mark, value] of Object.entries(legend)) {
        if (mark.length !== 1 || mark === "." || mark === "#")
          errors.push(`legend key ${mark} must be one character, not . or #`);
        if (typeof value !== "string" || !value.trim())
          errors.push(`legend ${mark} needs a cell class name`);
      }
  }
  if (tile.cells !== undefined) {
    if (
      !Array.isArray(tile.cells) ||
      tile.cells.length !== TILE_SIZE ||
      tile.cells.some(
        (row) => typeof row !== "string" || row.length !== TILE_SIZE,
      )
    )
      errors.push(
        `cells must be ${TILE_SIZE} strings of ${TILE_SIZE} characters`,
      );
    else
      for (let row = 0; row < TILE_SIZE; row++)
        for (let col = 0; col < TILE_SIZE; col++) {
          const mark = tile.cells[row]![col]!;
          if (mark === ".") continue;
          if (mark === "#") {
            if (!marginBound(row) || !marginBound(col))
              errors.push(
                `solid cell ${col},${row} must keep the ${INTERIOR_MARGIN}-cell tile margin`,
              );
            continue;
          }
          if (!Object.hasOwn(legend, mark))
            errors.push(`cells use ${mark} without a legend entry`);
        }
  }
  if (tile.walls !== undefined) {
    if (!Array.isArray(tile.walls)) errors.push("walls must be an array");
    else
      for (const wall of tile.walls) {
        if (!wall || typeof wall !== "object") {
          errors.push("malformed interior wall");
          continue;
        }
        const { x1, y1, x2, y2 } = wall;
        if (![x1, y1, x2, y2].every(inside)) {
          errors.push(
            `interior wall must stay within ${INTERIOR_MARGIN}..${TILE_SIZE - INTERIOR_MARGIN}`,
          );
          continue;
        }
        const vertical = x1 === x2,
          horizontal = y1 === y2;
        if (vertical === horizontal) {
          errors.push("interior wall must be axis aligned and have length");
          continue;
        }
        // Whole-cell endpoints keep every segment open in at most one place, so
        // a segment's metadata stays a single span.
        if (![x1, y1, x2, y2].every((v) => Number.isInteger(v)))
          errors.push("interior wall endpoints must be whole cells");
        const length = vertical ? Math.abs(y2 - y1) : Math.abs(x2 - x1);
        if (wall.gap !== undefined)
          if (!Number.isFinite(wall.gap) || wall.gap <= 0 || wall.gap >= length)
            errors.push(
              "interior wall gap must be positive and shorter than the wall",
            );
      }
  }
  for (const [side, value] of Object.entries(tile.edges ?? {})) {
    if (typeof value === "string") {
      if (value.length !== TILE_SIZE)
        errors.push(`edges.${side} must be ${TILE_SIZE} marks`);
      else if (/[^.o#]/.test(value))
        errors.push(`edges.${side} marks must be ".", "o" or "#"`);
      continue;
    }
    if (!Array.isArray(value) || value.length !== TILE_SIZE) {
      errors.push(`edges.${side} must be ${TILE_SIZE} declarations`);
      continue;
    }
    value.forEach((entry, i) =>
      errors.push(...validateDeclaration(entry, `edges.${side}[${i}]`)),
    );
  }
  for (const [side, value] of Object.entries(tile.corners ?? {})) {
    if (!Array.isArray(value) || value.length !== TILE_SIZE + 1) {
      errors.push(`corners.${side} must be ${TILE_SIZE + 1} declarations`);
      continue;
    }
    for (const entry of value)
      if (
        entry !== undefined &&
        typeof entry !== "string" &&
        (typeof entry !== "object" || Array.isArray(entry))
      )
        errors.push(`corners.${side} entries must be a class or an object`);
  }
  const overrides = tile.primitives;
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      errors.push("primitives must be an object");
    else {
      for (const [addr, value] of Object.entries(overrides.cells ?? {})) {
        const parts = addr.split(",").map(Number);
        if (parts.length !== 2 || parts.some((v) => !Number.isInteger(v)))
          errors.push(`primitives.cells key ${addr} must be "col,row"`);
        else if (
          value?.class === "solid" &&
          (!marginBound(parts[0]!) || !marginBound(parts[1]!))
        )
          errors.push(
            `primitives.cells ${addr} may not make a border cell solid`,
          );
      }
      for (const [addr, value] of Object.entries(overrides.segments ?? {})) {
        if (!/^[vh]:\d+,\d+$/.test(addr))
          errors.push(
            `primitives.segments key ${addr} must be "v:line,offset" or "h:line,offset"`,
          );
        errors.push(
          ...validateDeclaration(value, `primitives.segments ${addr}`),
        );
      }
      for (const addr of Object.keys(overrides.vertices ?? {})) {
        if (!/^\d+,\d+$/.test(addr)) {
          errors.push(`primitives.vertices key ${addr} must be "x,y"`);
          continue;
        }
        const [vx, vy] = addr.split(",").map(Number);
        // Interior vertices carry nothing a flat map cannot derive, so giving
        // one metadata is a mistake worth reporting rather than ignoring.
        if (!isPerimeterVertex(vertexAt(vx!, vy!)))
          errors.push(
            `primitives.vertices ${addr} is interior; only perimeter vertices carry metadata`,
          );
      }
    }
  }
  return errors;
}

/** The older class/solid/wall view, derived from the primitive model. */
export function tileShape(
  tile: TileDesign,
  orientation: Orientation | number = 0,
): TileShape {
  const primitives = tilePrimitives(tile, orientation);
  const resolved = resolvePrimitives(primitives, {})!;
  const blocked = new Uint8Array(TILE_SIZE * TILE_SIZE);
  for (let row = 0; row < TILE_SIZE; row++)
    for (let col = 0; col < TILE_SIZE; col++)
      blocked[cellAt(col, row)] = 0;
  return {
    classes: resolved.cells.map((cell) => cell.class),
    blocked,
    walls: wallsFrom(resolved),
  };
}
