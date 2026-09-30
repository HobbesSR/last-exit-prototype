import type { TileDesign, SetPiece, Library } from "./types.ts";
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


export function compileSetPiece(
  setPiece: SetPiece,
  library: Library,
  random: () => number,
): MacroStructure {
  const cellsMap = new Map<string, MacroCell>();
  const segments: MacroSegment[] = [];

  for (const slot of setPiece.tiles) {
    const tileSet = library.tileSets?.find((ts) => ts.id === slot.tileSetId);
    if (!tileSet || !tileSet.members.length) continue;
    
    // Pick a random member
    const memberId = tileSet.members[Math.floor(random() * tileSet.members.length)];
    const design = library.tiles.find((t) => t.id === memberId);
    if (!design) continue;

    // Default to orientation 0 for predictability unless the SetPiece specifies it
    const orientation = (slot as any).orientation !== undefined ? (slot as any).orientation : 0;

    const sub = compileTileDesign(design, orientation);

    const ox = slot.dx * TILE_SIZE;
    const oy = slot.dy * TILE_SIZE;

    for (const c of sub.cells) {
      cellsMap.set(`${c.x + ox},${c.y + oy}`, { x: c.x + ox, y: c.y + oy, class: c.class });
    }
    if (sub.segments) {
      for (const s of sub.segments) {
        segments.push({ axis: s.axis, x: s.x + ox, y: s.y + oy, open: s.open });
      }
    }
  }

  return {
    version: 1,
    id: setPiece.id,
    defaultCellClass: "grass", // or we could read from the first tile
    cells: Array.from(cellsMap.values()),
    segments,
  };
}
