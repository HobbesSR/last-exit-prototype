import type { TileDesign } from "./types.ts";
import type { MacroStructure, MacroCell, MacroSegment } from "./macro-types.ts";
import {
  TILE_SIZE,
  channelSpan,
  segmentDeclaration,
  tilePrimitives,
} from "./primitives.ts";

export function compileTileDesign(
  design: TileDesign,
  orientation: number = 0,
): MacroStructure {
  const cells: MacroCell[] = [];
  const segments: MacroSegment[] = [];

  const parsed = tilePrimitives(design, orientation);

  for (let r = 0; r < TILE_SIZE; r++) {
    for (let c = 0; c < TILE_SIZE; c++) {
      const meta = parsed.cells[r * TILE_SIZE + c];
      if (meta && meta.class && meta.class !== design.defaultCellClass) {
        cells.push({ x: c, y: r, class: meta.class });
      } else {
        cells.push({ x: c, y: r });
      }
    }
  }

  const V_COUNT = TILE_SIZE * (TILE_SIZE + 1);
  for (let i = 0; i < V_COUNT; i++) {
    const decl = segmentDeclaration(parsed, i);
    if (decl !== undefined && decl !== "any") {
      const col = Math.floor(i / TILE_SIZE);
      const row = i % TILE_SIZE;
      segments.push({
        axis: "v",
        x: col,
        y: row,
        open: channelSpan(decl, "move"),
      });
    }
  }

  for (let i = 0; i < (TILE_SIZE + 1) * TILE_SIZE; i++) {
    const decl = segmentDeclaration(parsed, V_COUNT + i);
    if (decl !== undefined && decl !== "any") {
      const row = Math.floor(i / TILE_SIZE);
      const col = i % TILE_SIZE;
      segments.push({
        axis: "h",
        x: col,
        y: row,
        open: channelSpan(decl, "move"),
      });
    }
  }

  return {
    version: 1,
    id: design.id,
    defaultCellClass: design.defaultCellClass,
    cells,
    segments,
  };
}
