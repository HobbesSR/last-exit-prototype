/**
 * The macro partition: the first stage of the planned generation path.
 *
 * Everything downstream of here -- the perimeter ports, the reachability proof
 * over the region graph, the loot budgets, the micro conformance check -- is
 * stated about regions. So the regions have to exist before any of it, and they
 * have to be the kind of area those stages can say something useful about. That
 * is the whole job of this module, and it is why the shape rules below are not
 * cosmetic:
 *
 * - **Whole tiles.** A region is grown as a union of 6 x 6 tiles, so every
 *   border lands on a tile seam and the runs another stage turns into ports are
 *   straight, contiguous and aligned to the lattice micro already builds
 *   against. `plan/types.ts` explicitly permits ragged regions; this planner
 *   simply does not make them, because nothing is gained by it here.
 * - **Compact, never snaked.** Growth is a simultaneous breadth-first flood
 *   from spaced seeds, not a random walk. A walk produces two-tile-wide snakes,
 *   and a snake has no room for a building: the region is technically the right
 *   area and every structural builder still degrades to scatter inside it.
 * - **Never a sliver.** The registered builders declare `minArea` up to 36
 *   cells, and a region under its builder's minimum silently falls back rather
 *   than failing loudly. This project has been bitten by that twice. A region
 *   below `MIN_REGION_TILES` is therefore merged into the neighbour it shares
 *   the most border with, which puts the floor at 72 cells on a tile-aligned
 *   mask -- comfortably over the largest `minArea` in the catalogue.
 *
 * Determinism is structural rather than promised. Seed tiles are drawn from
 * named streams keyed by lattice block, so no draw depends on how many draws
 * came before it; growth breaks every tie by (region index, tile index); and
 * ids are assigned after sorting regions by their lowest cell, so an id is a
 * function of the shape rather than of the order the shapes were discovered in.
 */
import { createRng } from "../micro/rng.ts";
export type { PartitionedRegion } from "./types.ts";
import type { PartitionedRegion } from "./types.ts";
import type { Rng } from "../micro/types.ts";
import type { Box, MapParams, MapZone } from "../types.ts";

/** Candidate builder ids with relative weights. */
export interface RegionTypeTable {
  /** Weighted builder ids used when no tier-specific entry applies. */
  default: Array<{ type: string; weight: number }>;
  /** Optional per-tier override, tier 1..5. */
  byTier?: Record<number, Array<{ type: string; weight: number }>>;
}

export interface PartitionOptions {
  /** Target region area in TILES (not cells). Default 4. */
  tilesPerRegion?: number;
  /** Candidate builder ids with relative weights. */
  types?: RegionTypeTable;
}

/**
 * Untuned defaults. These numbers are a starting point picked to match the
 * design notes' intent -- "open, with obstruction rather than maze" -- and not
 * the result of any playtest. They are relative weights, not percentages; they
 * happen to sum to 100 only because that reads clearly.
 *
 * Open ground dominates at just over half the map between `open-field` and the
 * `loot-scatter` fallback treatment. `compound` and `pillar-hall` carry the
 * structure. `rubble` is uncommon because a map made of it is a maze, and
 * `courtyard` is rare because it is the most enclosing thing in the catalogue
 * and reads as a landmark only while it stays scarce.
 */
const UNTUNED_TYPE_WEIGHTS: ReadonlyArray<{ type: string; weight: number }> = [
  { type: "open-field", weight: 32 },
  { type: "loot-scatter", weight: 24 },
  { type: "pillar-hall", weight: 15 },
  { type: "compound", weight: 15 },
  { type: "rubble", weight: 9 },
  { type: "courtyard", weight: 5 },
];

/** The shipped weighting, over the six ids `micro/index.ts` registers. */
export const DEFAULT_TYPE_TABLE: RegionTypeTable = Object.freeze({
  default: UNTUNED_TYPE_WEIGHTS.map((entry) => ({ ...entry })),
});

/** Target region area in tiles when the caller does not say. 4 tiles = 144 cells. */
const DEFAULT_TILES_PER_REGION = 4;

/**
 * The floor a region is merged up to. Two tiles is 72 cells on a tile-aligned
 * mask, which clears the catalogue's largest `minArea` (36, `compound` and
 * `pillar-hall`) with room for the ragged case.
 */
const MIN_REGION_TILES = 2;

/** 4-connectivity, in tile and in cell space alike. Order affects nothing. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];

/** One region while it is still a set of tiles rather than a set of cells. */
interface GrowingRegion {
  /** Tile indices, ascending. Emptied when the region is merged away. */
  tiles: number[];
}

/**
 * Partition the masked area into regions.
 *
 * Pure in its arguments: the same `(seed, params, zones, mask, options)` gives
 * a deep-equal result, on any machine, whatever else the process has generated.
 *
 * @param mask Cells covered by the map, ascending cell indices.
 */
export function partitionRegions(
  seed: string,
  params: MapParams,
  zones: MapZone[],
  mask: readonly number[],
  options: PartitionOptions = {},
): PartitionedRegion[] {
  const tileSize = params.tileSize;
  const width = params.columns * tileSize;
  const height = params.rows * tileSize;
  const tileCols = params.columns;
  const tileRows = params.rows;
  if (mask.length === 0) return [];

  // A membership test over the cell grid, so the cell-space passes below (the
  // border measurement, and the final tile-to-cell conversion) never have to
  // search the mask list. The grid is ~65k cells at default params.
  const masked = new Uint8Array(width * height);
  for (const cell of mask) {
    if (cell >= 0 && cell < masked.length) masked[cell] = 1;
  }

  // Cells are the contract; tiles are the working unit. A tile enters the
  // partition when it holds at least one masked cell, and it keeps only its
  // masked cells at the end -- so a mask that cuts a tile in half stays total
  // and disjoint without the growth pass ever knowing the mask was ragged.
  const tileCells = new Map<number, number[]>();
  for (const cell of mask) {
    if (cell < 0 || cell >= masked.length) continue;
    const x = cell % width;
    const y = (cell / width) | 0;
    const tile = ((y / tileSize) | 0) * tileCols + ((x / tileSize) | 0);
    const bucket = tileCells.get(tile);
    if (bucket) bucket.push(cell);
    else tileCells.set(tile, [cell]);
  }

  const tilesPerRegion = Math.max(
    1,
    Math.floor(options.tilesPerRegion ?? DEFAULT_TILES_PER_REGION),
  );
  const root = createRng(seed).stream("partition");

  const owner = new Int32Array(tileCols * tileRows).fill(-1);
  const seeds = pickSeedTiles(root, tileCells, tilesPerRegion, tileCols);
  const regions: GrowingRegion[] = seeds.map((tile, index) => {
    owner[tile] = index;
    return { tiles: [tile] };
  });

  growRegions(regions, owner, tileCells, tileCols, tileRows);
  mergeSlivers(
    regions,
    owner,
    tileCells,
    width,
    height,
    masked,
    tileCols,
    tileSize,
  );

  // Ids are a function of the shape, not of discovery order: sort by lowest
  // cell so that a partition which comes out the same comes out named the same,
  // whatever order the growth happened to assign region indices in.
  const shaped = regions
    .filter((region) => region.tiles.length > 0)
    .map((region) => cellsOf(region, tileCells))
    .filter((cells) => cells.length > 0)
    .sort((a, b) => a[0] - b[0]);

  return shaped.map((cells, index) => {
    const bounds = boundsOf(cells, width);
    // 32 bits derived from the map seed and the region's identity. The lowest
    // cell is that identity: it is what the id is sorted on, so the seed and
    // the id cannot drift apart.
    const regionSeed = createRng(`${seed}#region#${cells[0]}`).int(
      0,
      0xffffffff,
    );
    const zone = zoneOfCentre(cells, width, zones);
    return {
      id: `r-${index}`,
      type: pickType(
        regionSeed,
        zone.tier,
        options.types ?? DEFAULT_TYPE_TABLE,
      ),
      seed: regionSeed,
      cells,
      bounds,
      tier: zone.tier,
      bonus: zone.bonus,
    };
  });
}

/**
 * Seed tiles, spaced roughly `sqrt(tilesPerRegion)` apart.
 *
 * One seed per lattice block of that spacing, drawn from a stream named after
 * the block. Naming the stream after the block rather than advancing one shared
 * sequence is what makes the choice independent of the mask's shape elsewhere:
 * a block at the far side of the map cannot shift this block's draw by existing
 * or not existing.
 *
 * Jitter within the block is deliberate. A strict lattice of seeds produces a
 * grid of near-identical squares, which reads as tiling rather than as terrain;
 * one free choice per block keeps the sizes honest while the block structure
 * keeps the spacing.
 */
function pickSeedTiles(
  root: Rng,
  tileCells: Map<number, number[]>,
  tilesPerRegion: number,
  tileCols: number,
): number[] {
  const spacing = Math.max(1, Math.round(Math.sqrt(tilesPerRegion)));
  const blocks = new Map<string, number[]>();
  // Ascending tile index, so each block's member list is in a fixed order
  // regardless of how the caller ordered the mask.
  const tiles = [...tileCells.keys()].sort((a, b) => a - b);
  for (const tile of tiles) {
    const col = tile % tileCols;
    const row = (tile / tileCols) | 0;
    const key = `${(col / spacing) | 0},${(row / spacing) | 0}`;
    const bucket = blocks.get(key);
    if (bucket) bucket.push(tile);
    else blocks.set(key, [tile]);
  }

  const picks: number[] = [];
  const seedStream = root.stream("seed-tiles");
  for (const [key, members] of blocks) {
    picks.push(members[seedStream.stream(key).int(0, members.length - 1)]);
  }
  // Region index order is tile order, so the tie-break in growth is a stable
  // spatial ordering rather than a hash ordering.
  return picks.sort((a, b) => a - b);
}

/**
 * Simultaneous breadth-first growth: every region advances one ring per round,
 * so regions arrive at their shared border at the same time and the border ends
 * up near the midpoint. Contested tiles go to the lower region index, and
 * within a region a lower tile index claims first -- both fixed, so nothing
 * here depends on iteration order of anything.
 *
 * The result is contiguous by construction: a tile is only ever claimed from a
 * tile already in the region.
 */
function growRegions(
  regions: GrowingRegion[],
  owner: Int32Array,
  tileCells: Map<number, number[]>,
  tileCols: number,
  tileRows: number,
): void {
  let frontier = regions.map((region) => region.tiles.slice());
  let live = frontier.some((wave) => wave.length > 0);
  while (live) {
    const next: number[][] = regions.map(() => []);
    for (let index = 0; index < regions.length; index += 1) {
      for (const tile of frontier[index]) {
        const col = tile % tileCols;
        const row = (tile / tileCols) | 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = col + dx;
          const ny = row + dy;
          if (nx < 0 || ny < 0 || nx >= tileCols || ny >= tileRows) continue;
          const neighbour = ny * tileCols + nx;
          if (owner[neighbour] !== -1) continue;
          if (!tileCells.has(neighbour)) continue;
          owner[neighbour] = index;
          regions[index].tiles.push(neighbour);
          next[index].push(neighbour);
        }
      }
    }
    for (const wave of next) wave.sort((a, b) => a - b);
    frontier = next;
    live = next.some((wave) => wave.length > 0);
  }
  for (const region of regions) region.tiles.sort((a, b) => a - b);
}

/**
 * Merge anything under `MIN_REGION_TILES` into the neighbour it shares the most
 * border with, measured in masked cell edges rather than in tile adjacencies so
 * that a partly-masked tile counts for what it actually contributes.
 *
 * Longest border rather than, say, smallest neighbour: a sliver absorbed across
 * its widest side stays compact, and compactness is what the builders need. The
 * loop repeats because two slivers may only have each other for neighbours;
 * merging strictly reduces the region count, so it terminates. A sliver with no
 * neighbour at all -- an isolated island in the mask -- is left as it is, since
 * there is nothing to merge it into and throwing would be worse.
 */
function mergeSlivers(
  regions: GrowingRegion[],
  owner: Int32Array,
  tileCells: Map<number, number[]>,
  width: number,
  height: number,
  masked: Uint8Array,
  tileCols: number,
  tileSize: number,
): void {
  const tileAt = (x: number, y: number): number =>
    ((y / tileSize) | 0) * tileCols + ((x / tileSize) | 0);

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      if (region.tiles.length === 0) continue;
      if (region.tiles.length >= MIN_REGION_TILES) continue;

      // Border length per neighbouring region, in masked cell edges.
      const shared = new Map<number, number>();
      for (const tile of region.tiles) {
        for (const cell of tileCells.get(tile) ?? []) {
          const x = cell % width;
          const y = (cell / width) | 0;
          for (const [dx, dy] of NEIGHBOURS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (!masked[ny * width + nx]) continue;
            const other = owner[tileAt(nx, ny)];
            if (other === -1 || other === index) continue;
            shared.set(other, (shared.get(other) ?? 0) + 1);
          }
        }
      }

      // Ascending region index breaks a tie, so the choice never depends on the
      // insertion order of the map above.
      let target = -1;
      let longest = -1;
      for (const other of [...shared.keys()].sort((a, b) => a - b)) {
        const length = shared.get(other) ?? 0;
        if (length > longest) {
          longest = length;
          target = other;
        }
      }
      if (target === -1) continue;

      for (const tile of region.tiles) {
        owner[tile] = target;
        regions[target].tiles.push(tile);
      }
      regions[target].tiles.sort((a, b) => a - b);
      region.tiles = [];
      changed = true;
    }
  }
}

/** Masked cells of a region, ascending. */
function cellsOf(
  region: GrowingRegion,
  tileCells: Map<number, number[]>,
): number[] {
  const cells: number[] = [];
  for (const tile of region.tiles) {
    const bucket = tileCells.get(tile);
    if (bucket) cells.push(...bucket);
  }
  return cells.sort((a, b) => a - b);
}

/** Inclusive cell bounds of an ascending cell list. */
function boundsOf(cells: number[], width: number): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const cell of cells) {
    const x = cell % width;
    const y = (cell / width) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Progression in force over a region, from the zone covering its centre of
 * mass.
 *
 * One zone, not an average: `tier` indexes a five-step progression and `bonus`
 * a three-step one, and an average of two zones is a number that names neither
 * of them. A region spanning a tier boundary is richer at the far end anyway,
 * because loot density is sampled per cell from the zone covering that cell --
 * so nothing is lost by picking, and a fabricated tier 2.5 would be.
 */
function zoneOfCentre(
  cells: number[],
  width: number,
  zones: MapZone[],
): { tier: number; bonus: number } {
  let sumX = 0;
  let sumY = 0;
  for (const cell of cells) {
    sumX += cell % width;
    sumY += (cell / width) | 0;
  }
  const cx = Math.round(sumX / cells.length);
  const cy = Math.round(sumY / cells.length);

  for (const zone of zones) {
    const [x0, y0, x1, y1] = zone.cells;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
      return { tier: zone.tier, bonus: zone.bonus };
    }
  }
  // A concave region can put its centre of mass in an unoccupied zone. Fall to
  // the nearest occupied one by zone centre rather than inventing a tier.
  let best: MapZone | undefined;
  let bestDistance = Infinity;
  for (const zone of zones) {
    const [x0, y0, x1, y1] = zone.cells;
    const dx = cx - (x0 + x1) / 2;
    const dy = cy - (y0 + y1) / 2;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = zone;
    }
  }
  return best ? { tier: best.tier, bonus: best.bonus } : { tier: 1, bonus: 0 };
}

/**
 * Weighted choice of builder id, from a stream of the region's own seed.
 *
 * Drawing from the region seed rather than from a shared partition stream means
 * the type is a function of the region alone: adding a region on the far side
 * of the map does not re-roll every other region's type, which is the same
 * order-independence `micro/rng.ts` exists to provide.
 *
 * No `minArea` check is needed here. The sliver merge already puts every region
 * at or above 72 cells on a tile-aligned mask, which clears the largest
 * `minArea` in the catalogue; the size rule is the guard, not this function.
 */
function pickType(
  regionSeed: number,
  tier: number,
  table: RegionTypeTable,
): string {
  const tiered = table.byTier?.[tier];
  const entries =
    tiered && tiered.length > 0
      ? tiered
      : table.default.length > 0
        ? table.default
        : DEFAULT_TYPE_TABLE.default;

  let total = 0;
  for (const entry of entries) total += Math.max(0, entry.weight);
  // An all-zero table is a caller error that should not stop generation: treat
  // it as uniform rather than returning an id nobody asked for.
  const rng = createRng(regionSeed).stream("type");
  if (total <= 0) return entries[rng.int(0, entries.length - 1)].type;

  let roll = rng.next() * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight);
    if (roll < 0) return entry.type;
  }
  return entries[entries.length - 1].type;
}
