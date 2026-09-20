/**
 * The planned generation path, end to end: plan a map, then compose it.
 *
 * This is the second of two generators. `core.generateMap` is untouched and
 * still works; it composes authored tiles, discovers regions from the cell
 * classes that fall out, and only then finds out what it built. Because nothing
 * knows whether the result is walkable until the whole thing exists, keeping it
 * walkable while micro generation obstructs it needs `planStreets`: a reserved
 * route network threaded through finished geometry, plus a repair pass for what
 * still breaks. That costs about a third of the map.
 *
 * Here the order is inverted and none of that is needed.
 *
 *   plan:     partition the map into regions
 *             -> state a perimeter contract on every boundary
 *             -> prove reachability on the region graph, from the floors alone
 *   compose:  lay the contract down as geometry
 *             -> run one builder per region
 *             -> hold each builder to the contract it was given
 *
 * The proof is a statement about a graph of a few hundred nodes, and it is
 * sound only because `micro/conform.ts` separately holds every builder to the
 * floors the proof was computed from. Neither half needs to know anything about
 * the other: macro never learns what a region built inside itself, and a
 * builder never learns what the map looks like outside its own area.
 *
 * Two things are measured rather than planned, on purpose. Tile anchors are
 * chosen after micro generation from ground that is actually clear, because an
 * anchor is a fact about the composed geometry and planning one only creates
 * something to defend. And the artifact's regions come from a second search of
 * the finished grid, so they agree with their own cells by construction.
 */
import {
  DEFAULT_PARAMS,
  OUTSIDE_CLASS,
  findPath,
  ZONE_COLUMNS,
  ZONE_ROWS,
  deriveEdges,
  deriveWalls,
  makeZones,
  searchRegions,
  validateMap,
  wallsFromLattice,
} from "../core.ts";
import { encodeGrid } from "../coding.ts";
import {} from "../primitives.ts";
import { latticeFor, nodeIndex, LATTICE_STEP } from "../nav.ts";
import { getBuilder } from "../micro/catalogue.ts";
import { createMask } from "../micro/mask.ts";
import { createRng } from "../micro/rng.ts";
import { conformRegionEdit } from "../micro/conform.ts";
import { PASSAGE } from "../micro/scale.ts";
import "../micro/index.ts";
import { partitionRegions } from "./partition.ts";
import type { PartitionOptions } from "./partition.ts";
import { planPorts, proveReachability } from "./ports.ts";
import type { PortOptions, RouteRequirement } from "./ports.ts";
import { allocateLoot } from "./loot.ts";
import type { LootPolicy } from "./loot.ts";
import type { MapPlan, PlannedFeature, RegionPlan } from "./types.ts";
import type {
  Passage,
  PerimeterPort,
  RegionContext,
  RegionOpening,
  SegmentRef,
} from "../micro/types.ts";
import type {
  GeneratedMap,
  NavTarget,
  MapFeature,
  MapParams,
  MapZone,
  PlacedTile,
  Point,
  Span,
  Wall,
} from "../types.ts";

export interface PlanOptions {
  partition?: PartitionOptions;
  ports?: PortOptions;
  loot?: LootPolicy;
}

/** The class a planned region paints, so the artifact's regions match its plan. */
const CLASS_PREFIX = "";

/** The width macro lays down for each band before any builder touches it. */
function bandWidth(required: Passage, allowed: Passage): number {
  if (allowed === "none") return 0;
  if (allowed === "contestant") return PASSAGE.squeeze;
  if (required === "hunter") return PASSAGE.door;
  if (required === "contestant") return PASSAGE.squeeze;
  // Permissive: leave it open and let the builder decide within the band.
  return Infinity;
}

/**
 * Lay a port down as spans across its run of segments.
 *
 * A width of `Infinity` opens the whole run; anything else opens a centered
 * stretch of that many segments' worth and seals the rest, which is what makes
 * a planned door read as a gate rather than as a gap someone forgot to close.
 */
function spansForPort(port: PerimeterPort): Span[] {
  const count = port.segments.length;
  const want = bandWidth(port.required, port.allowed);
  if (want === 0) return new Array<Span>(count).fill(null);
  if (!Number.isFinite(want)) return new Array<Span>(count).fill([0, 1]);
  const open = Math.min(want, count);
  const lo = (count - open) / 2,
    hi = (count + open) / 2;
  const spans: Span[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = Math.min(1, Math.max(0, lo - i)),
      b = Math.min(1, Math.max(0, hi - i));
    spans.push(b - a <= 1e-9 ? null : [a, b]);
  }
  return spans;
}

/** Cells the occupied zones cover, ascending. The map is exactly this. */
export function maskFor(params: MapParams, zones: MapZone[]): number[] {
  const width = params.columns * params.tileSize;
  const cells: number[] = [];
  for (const zone of zones)
    for (let y = zone.cells[1]; y <= zone.cells[3]; y += 1)
      for (let x = zone.cells[0]; x <= zone.cells[2]; x += 1)
        cells.push(y * width + x);
  cells.sort((a, b) => a - b);
  return cells;
}

/**
 * Where a run starts and ends. The west edge is tier 1 and the east edge tier 5,
 * so the contestant starts west and leaves east, which is the progression the
 * zone grid already encodes.
 */
function chooseRoutes(
  regions: ReadonlyArray<{
    id: string;
    bounds: [number, number, number, number];
  }>,
  exitCount: number,
): RouteRequirement {
  const byWest = [...regions].sort(
    (a, b) => a.bounds[0] - b.bounds[0] || a.id.localeCompare(b.id),
  );
  const byEast = [...regions].sort(
    (a, b) => b.bounds[2] - a.bounds[2] || a.id.localeCompare(b.id),
  );
  const exits = byEast.slice(0, Math.max(1, exitCount)).map((r) => r.id);
  return {
    spawnRegion: byWest[0]!.id,
    // The hunter starts at the far end, on the exits the contestant is running for.
    hunterSpawnRegion: byEast[0]!.id,
    exitRegions: exits,
  };
}

export function planMap(
  seed: string | number = "planned",
  params: Partial<MapParams> = {},
  options: PlanOptions = {},
): MapPlan {
  const seedText = String(seed);
  const requested = { ...DEFAULT_PARAMS, ...params };
  const p: MapParams = {
    ...requested,
    columns: ZONE_COLUMNS * requested.zoneWidth,
    rows: ZONE_ROWS * requested.zoneHeight,
  };
  const zones = makeZones(p);
  const width = p.columns * p.tileSize,
    height = p.rows * p.tileSize;
  const mask = maskFor(p, zones);

  const partition = partitionRegions(
    seedText,
    p,
    zones,
    mask,
    options.partition,
  );
  const routes = chooseRoutes(partition, p.exitCount);
  const regions = planPorts(
    seedText,
    partition,
    width,
    height,
    routes,
    options.ports,
  );
  const { loot } = allocateLoot(partition, p, options.loot);
  for (const region of regions) {
    const criteria = loot.get(region.id);
    if (criteria) region.loot = criteria;
  }

  // The plan is only worth composing if its own contract carries the routes it
  // promises. This is the whole point of planning first, so it is an error
  // rather than a warning.
  const proof = proveReachability(regions, routes);
  if (!proof.valid)
    throw new Error(`plan is unreachable: ${proof.errors.join("; ")}`);

  const featureRegions: PlannedFeature[] = [
    { kind: "spawn" as const, regionId: routes.spawnRegion },
    { kind: "hunter-spawn" as const, regionId: routes.hunterSpawnRegion },
    ...routes.exitRegions.map((id) => ({
      kind: "exit" as const,
      regionId: id,
    })),
  ];
  // A charger is the thing worth a detour, so it goes somewhere off the direct
  // line: the region furthest from both ends by bounding-box centre.
  const middle = [...regions].sort((a, b) => {
    const score = (r: RegionPlan) =>
      Math.abs((r.bounds[0] + r.bounds[2]) / 2 - width / 2);
    return score(a) - score(b) || a.id.localeCompare(b.id);
  })[0];
  if (middle)
    featureRegions.push({ kind: "charger" as const, regionId: middle.id });

  return {
    version: 1,
    seed: seedText,
    params: p,
    width,
    height,
    zones,
    regions,
    features: featureRegions,
    spawnRegion: routes.spawnRegion,
    hunterSpawnRegion: routes.hunterSpawnRegion,
    exitRegions: routes.exitRegions,
  };
}

interface ComposeGrid {
  W: number;
  H: number;
  cellClass: string[];
  cellLevel: number[];
  segmentOpen: Span[];
  segmentIndex: (vertical: boolean, line: number, offset: number) => number;
}

function makeComposeGrid(W: number, H: number): ComposeGrid {
  const verticals = (W + 1) * H;
  return {
    W,
    H,
    cellClass: new Array<string>(W * H).fill(OUTSIDE_CLASS),
    cellLevel: new Array<number>(W * H).fill(0),
    segmentOpen: new Array<Span>(verticals + (H + 1) * W).fill(null),
    segmentIndex: (vertical, line, offset) =>
      vertical ? offset * (W + 1) + line : verticals + line * W + offset,
  };
}

/**
 * The openings a builder sees, derived from the ports it was given rather than
 * measured off the grid. On this path a port IS the opening: macro decided it,
 * and `required` is exactly the thing the builder may not take away.
 */
function openingsFromPorts(
  ports: PerimeterPort[],
  grid: ComposeGrid,
): RegionOpening[] {
  const openings: RegionOpening[] = [];
  for (const port of ports) {
    if (port.allowed === "none") continue;
    for (const ref of port.segments) {
      const [a, b] = ref.vertical
        ? [
            { x: ref.line - 1, y: ref.offset },
            { x: ref.line, y: ref.offset },
          ]
        : [
            { x: ref.offset, y: ref.line - 1 },
            { x: ref.offset, y: ref.line },
          ];
      const span =
        grid.segmentOpen[grid.segmentIndex(ref.vertical, ref.line, ref.offset)];
      if (!span) continue;
      openings.push({
        ...ref,
        inside: { cellIndex: a.y * grid.W + a.x, x: a.x, y: a.y },
        outside: { cellIndex: b.y * grid.W + b.x, x: b.x, y: b.y },
        width: span[1] - span[0],
        required: port.required !== "none",
      });
    }
  }
  return openings;
}

/** The narrowest opening a port's floor accepts. `"none"` demands nothing. */
function floorWidth(required: Passage): number {
  if (required === "hunter") return PASSAGE.door;
  if (required === "contestant") return PASSAGE.squeeze;
  return 0;
}

/** The widest opening a port's ceiling permits. `"hunter"` caps nothing. */
function ceilingWidth(allowed: Passage): number {
  if (allowed === "none") return 0;
  if (allowed === "contestant") return PASSAGE.squeeze;
  return Infinity;
}

/**
 * The contract, enforced once more on the finished grid.
 *
 * A port is shared, and each side's builder runs separately. `conformRegionEdit`
 * holds a builder to the contract as its own edit is made, but the region next
 * door runs afterwards and may declare the very same boundary segments, and the
 * later write wins. On a small map that silently left fourteen of a hundred and
 * sixty-six ports below their floor -- each one conformant when it was checked,
 * and the pair of them not.
 *
 * So the last word belongs to the plan rather than to whichever builder happened
 * to run second. Only ports actually out of band are rewritten, so a builder's
 * own choice *within* the band survives untouched: the contract is a floor and a
 * ceiling, not an instruction.
 */
function enforcePorts(
  grid: ComposeGrid,
  plan: MapPlan,
): { corrected: number; ports: number } {
  let corrected = 0,
    seen = 0;
  const done = new Set<string>();
  for (const region of plan.regions)
    for (const port of region.ports) {
      if (done.has(port.id)) continue;
      done.add(port.id);
      seen += 1;
      const spans = port.segments.map(
        (ref) =>
          grid.segmentOpen[
            grid.segmentIndex(ref.vertical, ref.line, ref.offset)
          ]!,
      );
      const width = widestRun(spans);
      const floor = floorWidth(port.required);
      const ceiling = ceilingWidth(port.allowed);
      if (width + 1e-9 >= floor && width <= ceiling + 1e-9) continue;
      const planned = spansForPort(port);
      port.segments.forEach((ref, i) => {
        grid.segmentOpen[
          grid.segmentIndex(ref.vertical, ref.line, ref.offset)
        ] = planned[i]!;
      });
      corrected += 1;
    }
  return { corrected, ports: seen };
}

/** The widest continuous opening across a run of segments laid end to end. */
function widestRun(spans: readonly Span[]): number {
  let best = 0,
    run = 0;
  for (const span of spans) {
    if (!span) {
      run = 0;
      continue;
    }
    const open = span[1] - span[0];
    // A run only continues across a segment that is open to both its ends.
    run = span[0] <= 1e-9 ? run + open : open;
    if (run > best) best = run;
    if (span[1] < 1 - 1e-9) run = 0;
  }
  return best;
}

export function composeMap(plan: MapPlan): GeneratedMap {
  const p = plan.params;
  const grid = makeComposeGrid(plan.width, plan.height);
  const byId = new Map(plan.regions.map((r) => [r.id, r]));

  // Paint every region's cells with its own type, and open every segment inside
  // a region. A region is one place; the contract only speaks about its edges.
  for (const region of plan.regions)
    for (const cell of region.cells)
      grid.cellClass[cell] = `${CLASS_PREFIX}${region.type}`;
  const inMask = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < grid.W &&
    y < grid.H &&
    grid.cellClass[y * grid.W + x] !== OUTSIDE_CLASS;
  for (let y = 0; y < grid.H; y += 1)
    for (let x = 0; x < grid.W; x += 1) {
      if (!inMask(x, y)) continue;
      if (inMask(x - 1, y))
        grid.segmentOpen[grid.segmentIndex(true, x, y)] = [0, 1];
      if (inMask(x, y - 1))
        grid.segmentOpen[grid.segmentIndex(false, y, x)] = [0, 1];
    }
  // Then lay the contract over the boundaries. Ports are mirrored, so writing
  // both sides writes the same span twice, which is the point of them agreeing.
  for (const region of plan.regions) {
    for (const port of region.ports) {
      const spans = spansForPort(port);
      port.segments.forEach((ref, i) => {
        grid.segmentOpen[
          grid.segmentIndex(ref.vertical, ref.line, ref.offset)
        ] = spans[i]!;
      });
    }
  }

  const spawns: Array<{ cell: number; kind: string }> = [];
  const obstacles = new Map<string, Wall[]>();
  const manifests = new Map<string, string>();
  const featurePoints: Array<{ kind: string; x: number; y: number }> = [];
  let declaredCells = 0,
    declaredSegments = 0,
    conformed = 0;

  for (const region of plan.regions) {
    const mask = createMask(region.cells, grid.W, grid.H);
    const zone = plan.zones.find((z) => z.tier === region.tier);
    const context: RegionContext = {
      regionId: region.id,
      cellClass: region.type,
      rule: {},
      seed: region.seed,
      rng: createRng(region.seed),
      mask,
      grid: {
        tileSize: p.tileSize,
        tileOf: (x, y) => ({
          col: Math.floor(x / p.tileSize),
          row: Math.floor(y / p.tileSize),
        }),
        tileBounds: (col, row) => [
          col * p.tileSize,
          row * p.tileSize,
          col * p.tileSize + p.tileSize - 1,
          row * p.tileSize + p.tileSize - 1,
        ],
        onTileBorder: (x, y) =>
          x % p.tileSize === 0 ||
          y % p.tileSize === 0 ||
          x % p.tileSize === p.tileSize - 1 ||
          y % p.tileSize === p.tileSize - 1,
        onTileSeam: (ref) => ref.line % p.tileSize === 0,
        snap: (value) => Math.round(value / p.tileSize) * p.tileSize,
      },
      params: p,
      candidates: mask.lattice(2, 1, 1).map((c) => ({
        cellIndex: c.cellIndex,
        x: c.x,
        y: c.y,
        lootChance: region.loot.density,
      })),
      budget: region.loot.budget,
      // Nothing is reserved on this path. There is no street network to keep
      // clear and no anchor to defend, because connectivity is carried by the
      // perimeter contract instead of by ground held back from the builders.
      isReserved: () => false,
      isStandingRoom: () => false,
      openings: openingsFromPorts(region.ports, grid),
      ports: region.ports,
      loot: region.loot,
      corridors: [],
      clearance: { contestant: p.contestantRadius, hunter: p.hunterRadius },
      zoneAt: () => ({
        tier: region.tier,
        bonus: region.bonus,
        lootChance: zone?.lootChance ?? region.loot.density,
      }),
    };

    const builder = getBuilder(region.type) ?? getBuilder("loot-scatter");
    if (!builder) throw new Error(`no builder for region type ${region.type}`);
    const edit = conformRegionEdit(context, builder.build(context));
    conformed += edit.manifest.corridorsHonored ? 0 : 1;

    for (const cell of edit.cells) {
      if (cell.class !== undefined) grid.cellClass[cell.cellIndex] = cell.class;
      if (cell.height !== undefined)
        grid.cellLevel[cell.cellIndex] = cell.height;
    }
    for (const segment of edit.segments)
      grid.segmentOpen[
        grid.segmentIndex(
          segment.ref.vertical,
          segment.ref.line,
          segment.ref.offset,
        )
      ] = segment.open;
    for (const slot of edit.spawns)
      spawns.push({ cell: slot.cellIndex, kind: slot.kind });
    obstacles.set(region.id, edit.obstacles);
    manifests.set(region.id, edit.manifest.generator);
    for (const feature of edit.features) featurePoints.push(feature);
    declaredCells += edit.cells.length;
    declaredSegments += edit.segments.length;
  }
  spawns.sort((a, b) => a.cell - b.cell);
  const enforced = enforcePorts(grid, plan);

  // Anchors are measured, not planned: a tile's anchor is standing room this
  // map actually has, found after the builders finished. Planning one would
  // only create a point that has to be defended from the builders, which is the
  // legacy path's problem and not this one's.
  const probe = {
    width: grid.W,
    height: grid.H,
    walls: wallsFromLattice(
      grid.W,
      grid.H,
      (index) => grid.cellClass[index]!,
      (vertical, line, offset) =>
        grid.segmentOpen[grid.segmentIndex(vertical, line, offset)]!,
    ).concat(...obstacles.values()),
    navBoxes: [[0, 0, grid.W, grid.H]] as Array<
      [number, number, number, number]
    >,
  };
  // Both bodies have to reach every tile, so anchors come from ground the
  // LARGER body can move through; a node only a contestant fits in is not a
  // place the tile graph may hang a route on.
  const main = mainComponent(probe, p.hunterRadius);
  const tiles: PlacedTile[] = [];
  const regionOfCell = new Map<number, string>();
  for (const region of plan.regions)
    for (const cell of region.cells) regionOfCell.set(cell, region.id);

  for (let row = 0; row < p.rows; row += 1)
    for (let col = 0; col < p.columns; col += 1) {
      const x0 = col * p.tileSize,
        y0 = row * p.tileSize;
      if (!inMask(x0, y0)) continue;
      const anchor = findAnchor(probe, main.nodes, x0, y0, p.tileSize);
      if (!anchor) continue;
      const zone = plan.zones.find(
        (z) =>
          col >= z.tiles[0] &&
          row >= z.tiles[1] &&
          col <= z.tiles[2] &&
          row <= z.tiles[3],
      );
      tiles.push({
        id: `t-${col}-${row}`,
        col,
        row,
        x: x0,
        y: y0,
        zoneId: zone?.id ?? "",
        templateId: `planned:${regionOfCell.get(y0 * grid.W + x0) ?? ""}`,
        orientation: 0,
        anchor,
      });
    }

  // The artifact's regions come from a second search of the finished grid, so
  // they describe what was built rather than what was planned -- a builder that
  // stated a wall genuinely split its area, and the two have to agree.
  const regions = searchRegions(grid, plan.seed);
  const regionAt = new Map<number, number>();
  regions.forEach((region, index) => {
    for (const cell of region.cells) regionAt.set(cell, index);
  });
  for (const [id, walls] of obstacles) {
    const generator = manifests.get(id) ?? "";
    for (const wall of walls) {
      const cx = Math.floor((wall.x1 + wall.x2) / 2),
        cy = Math.floor((wall.y1 + wall.y2) / 2);
      const at = regionAt.get(cy * grid.W + cx);
      if (at !== undefined) regions[at]!.obstacles.push(wall);
    }
    void generator;
  }
  const spawnCells = new Set(spawns.map((s) => s.cell));
  for (const region of regions) {
    const planned = byId.get(regionOfCell.get(region.cells[0]!) ?? "");
    region.manifest = {
      ...(planned ? { generator: planned.type } : {}),
      spawnsPlaced: region.cells.filter((cell) => spawnCells.has(cell)).length,
      obstaclesPlaced: region.obstacles.length,
      corridorsHonored: true,
    };
  }

  // A feature has to land on a tile that exists. A region's own tiles are the
  // first choice, but a region whose every tile was sealed off has none, and a
  // map with no spawn is not a map -- so it falls back to the nearest tile that
  // did survive rather than dropping the feature and failing validation later.
  const tileFor = (regionId: string): PlacedTile | undefined => {
    const region = byId.get(regionId);
    if (!region || !tiles.length) return undefined;
    const own = new Set(region.cells);
    const inside = tiles.find((t) => own.has(t.y * grid.W + t.x));
    if (inside) return inside;
    const cx = (region.bounds[0] + region.bounds[2]) / 2,
      cy = (region.bounds[1] + region.bounds[3]) / 2;
    return [...tiles].sort(
      (a, b) =>
        Math.hypot(a.anchor.x - cx, a.anchor.y - cy) -
          Math.hypot(b.anchor.x - cx, b.anchor.y - cy) ||
        a.id.localeCompare(b.id),
    )[0];
  };
  const features: MapFeature[] = [];
  const usedTiles = new Set<string>();
  let exitIndex = 0;
  for (const planned of plan.features) {
    const tile = tileFor(planned.regionId);
    if (!tile) continue;
    // Two features on one tile is legal but uninteresting; prefer a free one.
    const spot =
      usedTiles.has(tile.id) && tiles.some((t) => !usedTiles.has(t.id))
        ? tiles.find((t) => !usedTiles.has(t.id))!
        : tile;
    usedTiles.add(spot.id);
    features.push({
      id: planned.kind === "exit" ? `exit-${exitIndex++}` : planned.kind,
      kind: planned.kind,
      tileId: spot.id,
      x: spot.anchor.x,
      y: spot.anchor.y,
    });
  }

  const map: GeneratedMap = {
    version: 1,
    seed: plan.seed,
    params: p,
    width: grid.W,
    height: grid.H,
    zones: plan.zones,
    tiles,
    edges: [],
    walls: [],
    features,
    grid: {
      width: grid.W,
      height: grid.H,
      cells: {
        class: encodeGrid(grid.cellClass),
        ...(grid.cellLevel.some((level) => level !== 0)
          ? { level: encodeGrid(grid.cellLevel) }
          : {}),
        spawns,
      },
      segments: { open: encodeGrid(grid.segmentOpen) },
      vertices: [],
    },
    regions,
    metrics: {
      tileCount: tiles.length,
      deadEnds: 0,
      squeezes: 0,
      contestantDistance: 0,
      hunterDistance: 0,
      detourRatio: 0,
      regionCount: regions.length,
      templateFallbacks: 0,
      lootCount: spawns.length,
      interiorWalls: 0,
      solidFraction: 0,
      largestRegion: regions.reduce((n, r) => Math.max(n, r.cells.length), 0),
      plannedRegions: plan.regions.length,
      microCells: declaredCells,
      microSegments: declaredSegments,
      conformedRegions: conformed,
      portsCorrected: enforced.corrected,
      sealedPockets: main.pockets,
      portCount: enforced.ports,
      obstacleCount: regions.reduce((n, r) => n + r.obstacles.length, 0),
    },
    validation: { valid: false, errors: [] },
  };
  map.walls = deriveWalls(map);
  map.edges = deriveEdges(map);
  // Measured off the composed result, exactly as the legacy path does it, so
  // the two generators' numbers mean the same thing and can be compared.
  map.metrics.interiorWalls = map.walls.filter(
    (w) =>
      (w.x1 === w.x2 && w.x1 % p.tileSize !== 0) ||
      (w.y1 === w.y2 && w.y1 % p.tileSize !== 0),
  ).length;
  map.metrics.solidFraction =
    grid.cellClass.filter((c) => c === "solid").length /
    Math.max(1, grid.cellClass.filter((c) => c !== OUTSIDE_CLASS).length);
  // A seam a contestant fits through and a hunter does not, read off the
  // measured widths rather than off anyone's intent.
  map.metrics.squeezes = map.edges.filter(
    (e) => e.width >= PASSAGE.squeeze && e.width < PASSAGE.door,
  ).length;
  const spawnTile = map.features.find((f) => f.kind === "spawn")?.tileId;
  const exitTile = map.features.find((f) => f.kind === "exit")?.tileId;
  if (spawnTile && exitTile) {
    const contestant = findPath(map, spawnTile, exitTile, "contestant");
    const hunter = findPath(map, spawnTile, exitTile, "hunter");
    // An empty path means no route, which must not read as a distance of zero:
    // zero is what an adjacent tile looks like, and the two are opposites.
    map.metrics.contestantDistance = contestant.length
      ? Math.max(0, contestant.length - 1) * p.tileSize
      : Infinity;
    map.metrics.hunterDistance = hunter.length
      ? Math.max(0, hunter.length - 1) * p.tileSize
      : Infinity;
    const from = tiles.find((t) => t.id === spawnTile),
      to = tiles.find((t) => t.id === exitTile);
    map.metrics.detourRatio =
      map.metrics.contestantDistance /
      Math.max(1, Math.abs((to?.x ?? 0) - (from?.x ?? 0)));
  }
  {
    const degree = new Map<string, number>(map.tiles.map((t) => [t.id, 0]));
    for (const e of map.edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    // A tile-graph leaf, which is not the same thing as a geometric cul-de-sac.
    map.metrics.deadEnds = [...degree.values()].filter((d) => d === 1).length;
  }
  map.validation = validateMap(map);
  return map;
}

/**
 * The lattice nodes of the largest connected piece of the map.
 *
 * An anchor has to be standing room a body can actually *get to*, not merely
 * standing room. A builder may legitimately seal a pocket -- a courtyard
 * interior is supposed to be hard to reach, and a compound room is a room --
 * and a tile whose centre lands in one is not somewhere routes pass through.
 * Choosing the nearest occupiable node without asking that question put anchors
 * inside sealed structures, and the tile graph then reported the thing it was
 * told: those tiles are unreachable.
 *
 * The largest component is the map proper. Anything else is a pocket.
 */
function mainComponent(
  target: NavTarget,
  radius: number,
): { nodes: Set<number>; pockets: number } {
  const lattice = latticeFor(target, radius);
  const { W, node, hEdge, vEdge } = lattice;
  const seen = new Uint8Array(node.length);
  let best = new Set<number>();
  let pockets = 0;
  for (let start = 0; start < node.length; start += 1) {
    if (!node[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    const found = new Set<number>([start]);
    for (let head = 0; head < queue.length; head += 1) {
      const at = queue[head]!,
        gx = at % W;
      const step = (next: number) => {
        if (next < 0 || next >= node.length || seen[next] || !node[next])
          return;
        seen[next] = 1;
        found.add(next);
        queue.push(next);
      };
      if (hEdge[at]) step(at + 1);
      if (gx > 0 && hEdge[at - 1]) step(at - 1);
      if (vEdge[at]) step(at + W);
      if (at >= W && vEdge[at - W]) step(at - W);
    }
    if (found.size > best.size) {
      if (best.size) pockets += 1;
      best = found;
    } else pockets += 1;
  }
  return { nodes: best, pockets };
}

/** The clearest standing room nearest a tile's centre, or none. */
function findAnchor(
  probe: { width: number; height: number },
  reachable: ReadonlySet<number>,
  x0: number,
  y0: number,
  size: number,
): Point | undefined {
  const cx = x0 + size / 2,
    cy = y0 + size / 2;
  let best: Point | undefined;
  let bestScore = Infinity;
  // Strictly inside, not merely within: `validateMap` rejects an anchor sitting
  // on its own tile's edge, because a point on a seam belongs to neither tile.
  for (let y = y0 + LATTICE_STEP; y < y0 + size; y += LATTICE_STEP)
    for (let x = x0 + LATTICE_STEP; x < x0 + size; x += LATTICE_STEP) {
      const at = nodeIndex(probe as never, x, y);
      if (at < 0 || !reachable.has(at)) continue;
      const score = Math.hypot(x - cx, y - cy);
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  return best;
}

export function generatePlannedMap(
  seed: string | number = "planned",
  params: Partial<MapParams> = {},
  options: PlanOptions = {},
): GeneratedMap {
  return composeMap(planMap(seed, params, options));
}

export type { SegmentRef };
