import {
  DEFAULT_LIBRARY,
  DEFAULT_PARAMS,
  deriveEdges,
  deriveWalls,
        zoneOccupied,
  key,
      planStreets,
  generateMicro,
  clearStreets,
  searchRegions,
      ZONE_COLUMNS,
  ZONE_ROWS,
  } from "./core.ts";

import { composeMacro } from "./macro.ts";
import type { MacroPlacement } from "./macro-types.ts";
import { encodeGrid } from "./coding.ts";
import type { GridBuild } from "./core.ts";
import { compileTileDesign,  } from "./macro-compiler.ts";
import type { 
  GeneratedMap, MapParams, Library, MapZone, MaskCell, 
  PlacedTile, Point, TileDesign, SetPieceSlot 
} from "./types.ts";

export function generateMapV2(
  seed: string | number = "last-exit",
  params: Partial<MapParams> = {},
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  const seedText = typeof seed === "number" ? seed.toString() : seed;
  const requested = { ...DEFAULT_PARAMS, ...params };
  const p: MapParams = { ...requested, columns: ZONE_COLUMNS * requested.zoneWidth, rows: ZONE_ROWS * requested.zoneHeight };
  
  let map: GeneratedMap | null = null;
  
  for (let attempt = 0; attempt < 50; attempt++) {
    
    let seedState = 0;
    for (let i = 0; i < seedText.length; i++) seedState = Math.imul(seedState ^ seedText.charCodeAt(i), 3432918353);
    seedState += attempt;
    const random = () => { seedState = (seedState + 1831565813) | 0; let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    
    const zones: MapZone[] = [];
    for (let row = 0; row < ZONE_ROWS; row++) {
      for (let col = 0; col < ZONE_COLUMNS; col++) {
        if (!zoneOccupied(col, row)) continue;
        const x0 = col * p.zoneWidth, y0 = row * p.zoneHeight;
        const x1 = x0 + p.zoneWidth - 1, y1 = y0 + p.zoneHeight - 1;
        const tier = col + 1;
        zones.push({
          id: `z-${col}-${row}`, col, row, tier, bonus: Math.abs(row - ((ZONE_ROWS - 1) / 2)),
          lootChance: Math.min(1, Math.max(0, p.lootChance + (tier - 1) * p.lootTierStep)),
          tiles: [x0, y0, x1, y1], cells: [x0 * p.tileSize, y0 * p.tileSize, (x1 + 1) * p.tileSize - 1, (y1 + 1) * p.tileSize - 1],
        });
      }
    }

    const cells: MaskCell[] = [];
    const byKey = new Map<string, number>();
    for (const zone of zones) {
      const [x0, y0, x1, y1] = zone.tiles;
      for (let col = x0; col <= x1; col++) {
        for (let row = y0; row <= y1; row++) {
          byKey.set(key(col, row), cells.length);
          cells.push({ x: col, y: row, col, row, id: `t-${col}-${row}`, zoneId: zone.id });
        }
      }
    }

    const zoneOf = (c: MaskCell) => zones.find((z) => c.x >= z.tiles[0]! && c.x <= z.tiles[2]! && c.y >= z.tiles[1]! && c.y <= z.tiles[3]!)!;

    const assigned = new Array<{
      template: TileDesign; templateId: string; orientation: number; anchor: Point; setPieceId?: string;
    } | undefined>(cells.length);

    const fallbackDesign = library.tiles.find(t => t.id === "open") || library.tiles.find(t => t.id === "plain") || library.tiles[0]!;

    const orderedSetPieces = (library.setPieces || []).sort((a, b) => b.tiles.length - a.tiles.length);
    let allPlaced = true;
    for (const setPiece of orderedSetPieces) {
      const placements: Array<{ i: number; slots: Array<{ s: SetPieceSlot; j: number | undefined }> }> = [];
      for (let i = 0; i < cells.length; i++) {
        const anchor = cells[i]!;
        const slots = setPiece.tiles.map((s) => ({ s, j: byKey.get(key(anchor.x + s.dx, anchor.y + s.dy)) }));
        if (slots.every((x) => x.j !== undefined && setPiece.eligibleTiers.includes(zoneOf(cells[x.j]!).tier) && !assigned[x.j])) {
          placements.push({ i, slots });
        }
      }
      if (!placements.length) { allPlaced = false; break; }
      const place = placements[Math.floor(random() * placements.length)]!;
      
      for (const { s, j: slot } of place.slots) {
        const j = slot!;
        const tileSet = library.tileSets?.find((ts) => ts.id === s.tileSetId);
        const memberId = tileSet ? tileSet.members[Math.floor(random() * tileSet.members.length)] : fallbackDesign.id;
        const design = library.tiles.find((t) => t.id === memberId) || fallbackDesign;
        const orientations = design.orientations && design.orientations.length ? design.orientations : [0];
        const orientation = (s as any).orientation !== undefined ? (s as any).orientation : orientations[Math.floor(random() * orientations.length)];
        
        assigned[j] = {
          template: design, templateId: design.id, orientation,
          anchor: { x: p.tileSize / 2, y: p.tileSize / 2 },
          setPieceId: setPiece.id,
        };
      }
    }
    
    if (!allPlaced) continue;

    for (let i = 0; i < cells.length; i++) {
      if (!assigned[i]) {
        assigned[i] = { template: fallbackDesign, templateId: fallbackDesign.id, orientation: 0, anchor: { x: p.tileSize / 2, y: p.tileSize / 2 } };
      }
    }

    const tiles: PlacedTile[] = cells.map((c, i) => ({
      ...c, x: c.x * p.tileSize, y: c.y * p.tileSize,
      templateId: assigned[i]!.templateId, orientation: assigned[i]!.orientation,
      anchor: { x: c.x * p.tileSize + assigned[i]!.anchor.x, y: c.y * p.tileSize + assigned[i]!.anchor.y },
      ...(assigned[i]!.setPieceId ? { setPieceId: assigned[i]!.setPieceId } : {})
    }));

    const placementsArray: MacroPlacement[] = tiles.map((tile) => {
      const design = library.tiles.find((t) => t.id === tile.templateId)!;
      return {
        id: tile.id, structure: compileTileDesign(design, tile.orientation),
        origin: { x: tile.x, y: tile.y }, orientation: 0,
      } as MacroPlacement;
    });

    const cellMask: Point[] = [];
    for (const c of cells) {
      for (let dy = 0; dy < p.tileSize; dy++) {
        for (let dx = 0; dx < p.tileSize; dx++) { cellMask.push({ x: c.x * p.tileSize + dx, y: c.y * p.tileSize + dy }); }
      }
    }

    const composition = composeMacro({
      version: 1, seed: seedText, width: p.columns * p.tileSize, height: p.rows * p.tileSize,
      mask: cellMask, defaultCellClass: "grass", placements: placementsArray,
    });

    let regions = composition.regions;
    const grid: GridBuild = {
      W: composition.width, H: composition.height,
      cellClass: composition.cellClass, segmentOpen: composition.segmentOpen,
      cellLevel: new Array(composition.width * composition.height).fill(0), vertices: new Map(),
      segmentIndex: (vertical: boolean, line: number, offset: number) =>
        vertical ? offset * (composition.width + 1) + line : (composition.width + 1) * composition.height + line * composition.width + offset,
    };

    
    
    
    const adj: any[][] = Array.from({ length: cells.length }, () => []);
    const DIRS = [[0, -1, "N", "S"], [1, 0, "E", "W"], [0, 1, "S", "N"], [-1, 0, "W", "E"]] as const;
    for (let i = 0; i < cells.length; i++) {
      for (const [dx, dy, side, opposite] of DIRS) {
        const j = byKey.get(key(cells[i]!.x + dx, cells[i]!.y + dy));
        if (j !== undefined) adj[i]!.push({ j, side, opposite });
      }
    }

    
    const left = cells.map((c, i) => ({ c, i })).filter((x) => x.c.x < p.columns / 3);
    const right = cells.map((c, i) => ({ c, i })).filter((x) => x.c.x > (p.columns * 2) / 3);
    const spawn = left.reduce((best, x) => (x.c.y > cells[best]!.y ? x.i : best), left[0]!.i);
    const hunter = right.reduce((best, x) => (x.c.x > cells[best]!.x ? x.i : best), right[0]!.i);
    const exits = right.slice(0, p.exitCount).map(x => ({ i: x.i, kind: "exit" }));
    
    const at = (i: number) => ({ x: tiles[i]!.anchor.x, y: tiles[i]!.anchor.y });
    
    let reservedStreets;
    try {
      reservedStreets = planStreets(tiles, adj, grid, p, spawn, seedText);
    } catch (e) {
      continue; // Failed route, try next sample
    }
    
    const regionOf = new Int32Array(grid.W * grid.H).fill(-1);
    regions.forEach((region, index) => {
      for (const cell of region.cells) regionOf[cell] = index;
    });
    
    const micro = generateMicro(
      regions, grid, library, zones, p, regionOf, reservedStreets.corridors,
      (x, y) => reservedStreets.standing[y * grid.W + x] === 1,
      (x, y) => reservedStreets.reserved[y * grid.W + x] === 1
    );
    
    micro.obstacles = clearStreets(micro.obstacles, reservedStreets.corridors);
    regions = searchRegions(grid, seedText);

    for (const wall of micro.obstacles) {
      const cx = Math.floor((wall.x1 + wall.x2) / 2), cy = Math.floor((wall.y1 + wall.y2) / 2);
      if (cx < 0 || cy < 0 || cx >= grid.W || cy >= grid.H) continue;
      const regionAt = new Int32Array(grid.W * grid.H).fill(-1);
      regions.forEach((r, i) => r.cells.forEach(c => regionAt[c] = i));
      if (regionAt[cy * grid.W + cx] !== -1) regions[regionAt[cy * grid.W + cx]!]?.obstacles.push(wall);
    }
    
    const spawnCells = new Set(micro.spawns.map((s) => s.cell));
    regions.forEach((region) => {
      region.manifest = {
        spawnsPlaced: region.cells.filter((cell) => spawnCells.has(cell)).length,
        obstaclesPlaced: region.obstacles.length,
        corridorsHonored: region.cells.every((cell) => micro.honored[cell] === 1),
      };
    });

    map = {
      version: 2, seed: seedText, params: p, width: grid.W, height: grid.H, zones, tiles, edges: [], walls: [],
      features: [
        { id: "spawn", kind: "spawn", tileId: tiles[spawn]!.id, ...at(spawn) },
        { id: "hunter-spawn", kind: "hunter-spawn", tileId: tiles[hunter]!.id, ...at(hunter) },
        ...exits.map((e, i) => ({ id: `exit-${i}`, kind: "exit" as const, tileId: tiles[e.i]!.id, ...at(e.i) }))
      ],
      
      grid: {
        width: grid.W,
        height: grid.H,
        cells: { class: encodeGrid(grid.cellClass), spawns: micro.spawns },
        segments: { open: encodeGrid(grid.segmentOpen) },
        vertices: []
      },
      regions,
      metrics: { tileCount: cells.length, deadEnds: 0, squeezes: 0, contestantDistance: 0, hunterDistance: 0, detourRatio: 0, regionCount: regions.length, templateFallbacks: 0, lootCount: micro.spawns.length, sealedSeams: 0, interiorWalls: 0, solidFraction: 0, largestRegion: 0 },
      validation: { valid: true, errors: [] }
    };
    
  map!.edges = deriveEdges(map!);
  map!.walls = deriveWalls(map!);
  break; 

  }
  
  if (!map) throw new Error("V2 Rejection sampling failed to find a walkable placement.");
  return map;
}
