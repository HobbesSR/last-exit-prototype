/** Chain-to-runtime conversion. Gameplay placement policy belongs here, never in the server. */
import { CHAIN_LIBRARIES, bundledLibrary, chainParams, generate } from './chain.ts';
import { DEFAULT_CELL_SIZE, GAME_ENGINES } from './engines.ts';
import { composeRegions } from './micro/compose.ts';
import { builtMapFrame, builtPlayableArea, stampBuiltMap } from './micro/adapter.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { canOccupy } from '../shared/movement.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { MAX_ARENA_SEED, isArenaSeed } from '../shared/simulation/rules.ts';
import { firstDifference } from './micro/difference.ts';
import type { ChainMap, ChainParams } from './macro/src/chain/types.ts';
import type { BuiltMap, RegionElement } from './micro/types.ts';
import type { ChargerId, GameMap, ItemKind, MatchContent, NodeId, StationId, Vec2, WeaponType } from '../shared/types.ts';

/** Names live placement policy without changing the chain library, strategies, or legacy generator. */
export const LIVE_MAP_VERSION = 'chain-live-1';
export const TRANSIT_STATION_COUNT = 6;
const LOOT_KINDS: readonly ItemKind[] = ['cell', 'cell', 'cell', 'weapon', 'weapon', 'weapon', 'med', 'shield', 'access'];
const WEAPON_TYPES: readonly WeaponType[] = ['pistol', 'rifle', 'scattergun'];

/** A map's size in tile zones. */
export interface ZoneSize { zoneWidth: number; zoneHeight: number }

/** The sizes a room can be created at: the ones a library is authored for (51). The first is the default. */
export const LIVE_ZONE_SIZES: readonly ZoneSize[] = Object.freeze(CHAIN_LIBRARIES.map(({ zoneWidth, zoneHeight }) => Object.freeze({ zoneWidth, zoneHeight })));
export const DEFAULT_LIVE_ZONE_SIZE: ZoneSize = LIVE_ZONE_SIZES[0]!;

/** The authored size a request names, or undefined when none is. */
export const liveZoneSize = (size: Partial<ZoneSize>): ZoneSize | undefined =>
  LIVE_ZONE_SIZES.find(({ zoneWidth, zoneHeight }) => zoneWidth === size.zoneWidth && zoneHeight === size.zoneHeight);
/** How a size is written in a request and shown to a player, such as `24x12`. */
export const zoneSizeName = ({ zoneWidth, zoneHeight }: ZoneSize): string => `${zoneWidth}x${zoneHeight}`;

/** The chain params a room generates with. The existing game has one extraction location with three shared slots. */
export function liveChainParams(content: MatchContent = defaultContent(), size: ZoneSize = DEFAULT_LIVE_ZONE_SIZE): ChainParams {
  return chainParams({ mode: 'game', zoneWidth: size.zoneWidth, zoneHeight: size.zoneHeight, exitCount: 1, contestantCount: content.roster.contestants.length, hunterCount: content.roster.gladiators.length });
}

export function generateLiveMap(seed: number, content: MatchContent = defaultContent(), size: ZoneSize = DEFAULT_LIVE_ZONE_SIZE): GameMap {
  const chain = generate(seed, liveChainParams(content, size), undefined, DEFAULT_CELL_SIZE);
  return liveMapFromBuilt(seed, composeRegions(chain.results), content);
}

/** The room seed a chain seed names: the number it spells exactly, when a room accepts it. */
export function liveSeed(seed: string): number | null {
  const n = Number(seed);
  return isArenaSeed(n) && String(n) === seed ? n : null;
}

/**
 * Why a chain map's recipe isn't a room's; empty when it is. A room's seed is a number, so
 * the seed text must be that number as the chain spells it, and the map must state the live
 * params, the bundled library, the game's cell size and the strategies the server runs. This
 * reads only what the map states, so it settles a map just generated from that recipe; a
 * loaded one needs {@link liveMismatch}.
 */
export function liveRecipeMismatch(map: Pick<ChainMap, 'layout' | 'library' | 'cellSize' | 'build'>, content: MatchContent = defaultContent()): string[] {
  const reasons: string[] = [], { seed, params } = map.layout;
  if (liveSeed(seed) === null) reasons.push(`the seed ${JSON.stringify(seed)} isn't a room seed: a whole number from 1 to ${MAX_ARENA_SEED}, without leading zeros`);
  const size = liveZoneSize(params);
  if (!size) return [...reasons, `${params.zoneWidth} x ${params.zoneHeight} zones isn't a size a room can use: ${LIVE_ZONE_SIZES.map(zoneSizeName).join(', ')}`];
  const live = liveChainParams(content, size);
  for (const key of Object.keys(live) as (keyof ChainParams)[])
    if (params[key] !== live[key]) reasons.push(`${key} is ${params[key]}; a room uses ${live[key]}`);
  if (firstDifference(map.library, bundledLibrary(live))) reasons.push(`the library isn't the bundled one`);
  if (map.cellSize !== DEFAULT_CELL_SIZE) reasons.push(`the cell size is ${map.cellSize}; a room uses ${DEFAULT_CELL_SIZE}`);
  if (map.build !== GAME_ENGINES.version) reasons.push(`the regions were built by ${map.build}; a room builds with ${GAME_ENGINES.version}`);
  return reasons;
}

/**
 * Why a chain map isn't the map a room with its seed plays; empty when it is (53 "Play in
 * the game"). Beyond the recipe, the map must be the one its seed generates: a loaded save
 * can keep its seed and recipe and still carry an edited layout or results. This generates
 * the map again to compare, so it costs a generation.
 */
export function liveMismatch(map: Pick<ChainMap, 'layout' | 'library' | 'cellSize' | 'build' | 'results'>, content: MatchContent = defaultContent()): string[] {
  const reasons = liveRecipeMismatch(map, content);
  if (reasons.length) return reasons;
  const fresh = generate(map.layout.seed, liveChainParams(content, liveZoneSize(map.layout.params)), undefined, DEFAULT_CELL_SIZE);
  const differs = firstDifference(fresh.layout, map.layout, 'layout') ?? firstDifference(fresh.results, map.results, 'results');
  return differs ? [`the map isn't the one its seed generates (${differs.replace(' rebuilt, ', ' from the seed, ').replace(/ stored$/, ' here')})`] : [];
}

/** Accept completed region results; keep their geometry and site coordinates authoritative. */
export function liveMapFromBuilt(seed: number, built: BuiltMap<RegionElement>, content: MatchContent = defaultContent()): GameMap {
  const context = createGenerationContext(seed), { map } = context;
  const { width, height, origin } = builtMapFrame(built);
  map.width = width; map.height = height; map.generator = LIVE_MAP_VERSION;
  map.playableArea = builtPlayableArea(built, origin);
  stampBuiltMap(context, built, origin);
  const world = (p: Vec2): Vec2 => ({ x: p.x + origin.x, y: p.y + origin.y });
  const sites = built.regions.flatMap(region => region.coreElements.map(site => ({ ...world(site), kind: site.kind, nodeId: region.brief.id as NodeId })));
  const spawns = sites.filter(site => site.kind === 'spawn').map(({ x, y }) => ({ x, y }));
  const hunters = sites.filter(site => site.kind === 'hunter-spawn').map(({ x, y }) => ({ x, y }));
  const exits = sites.filter(site => site.kind === 'exit');
  if (spawns.length !== content.roster.contestants.length || hunters.length !== content.roster.gladiators.length || exits.length !== 1)
    throw new Error(`Live map needs ${content.roster.contestants.length} spawns, ${content.roster.gladiators.length} hunter spawns and one exit; got ${spawns.length}, ${hunters.length}, ${exits.length}.`);
  for (const [label, points, radius] of [['spawn', spawns, 12], ['hunter spawn', hunters, 23], ['exit', exits, 23]] as const)
    for (const point of points) if (!canOccupy(map, point.x, point.y, radius)) throw new Error(`Live ${label} is obstructed at ${point.x},${point.y}.`);
  map.spawns = spawns; map.hunterSpawns = hunters;
  map.entry = { ...spawns[0]! }; map.exit = { x: exits[0]!.x, y: exits[0]!.y };
  for (const site of sites) {
    if (site.kind === 'charger') {
      if (!canOccupy(map, site.x, site.y, 24)) throw new Error('Live charger is obstructed.');
      map.chargers.push({ id: context.nextId('charger-') as ChargerId, x: site.x, y: site.y, nodeId: site.nodeId });
    } else if (site.kind === 'warp') {
      if (!canOccupy(map, site.x, site.y, 25)) throw new Error('Live transit site is obstructed.');
      map.stations.push({ id: context.nextId('rail-') as StationId, x: site.x, y: site.y, nodeId: site.nodeId });
    }
  }
  if (!map.chargers.length) throw new Error('Live map needs a charger.');

  if (map.stations.length !== TRANSIT_STATION_COUNT) throw new Error(`Live map needs ${TRANSIT_STATION_COUNT} authored transit sites.`);
  map.stations.sort((a, b) => a.x - b.x || a.y - b.y);

  // Retain the starter pistol and early-cell rules, on nearby collision-clear ground.
  for (const spawn of spawns) for (const kind of ['weapon', 'cell'] as const) {
    let placed = false;
    for (const radius of [40, 60, 80, 100, 0]) {
      for (let i = 0; i < 8; i++) {
        const x = spawn.x + Math.cos(i * Math.PI / 4) * radius, y = spawn.y + Math.sin(i * Math.PI / 4) * radius;
        if (!context.place(x, y, kind, kind === 'weapon' ? { weaponType: 'pistol', tier: 1 } : { charge: 0, tier: 1 })) continue;
        placed = true; break;
      }
      if (placed) break;
    }
    if (!placed) throw new Error(`Live map cannot place starting ${kind}.`);
  }
  // stampBuiltMap preserves loot order, so retain tier and building ownership by index.
  const tiers = built.regions.flatMap(r => r.loot.map(site => site.tier));
  for (const [i, spot] of context.spots.entries()) {
    const kind = LOOT_KINDS[Math.floor(context.random() * LOOT_KINDS.length)]!;
    const weaponType = kind === 'weapon' ? WEAPON_TYPES[Math.floor(context.random() * WEAPON_TYPES.length)]! : undefined;
    context.place(spot.x, spot.y, kind, { tier: tiers[i]!, ...(weaponType ? { weaponType } : {}),
      ...(kind === 'cell' ? { charge: 0 } : {}), ...(spot.buildingId ? { buildingId: spot.buildingId } : {}), nodeId: spot.nodeId }, 0);
  }
  return map as GameMap;
}
