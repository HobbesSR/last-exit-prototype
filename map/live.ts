/** Chain-to-runtime conversion. Gameplay placement policy belongs here, never in the server. */
import { generate } from './chain.ts';
import { DEFAULT_CELL_SIZE } from './engines.ts';
import { composeRegions } from './micro/compose.ts';
import { builtMapFrame, builtPlayableArea, stampBuiltMap } from './micro/adapter.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { canOccupy } from '../shared/movement.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import type { BuiltMap, RegionElement } from './micro/types.ts';
import type { ChargerId, GameMap, ItemKind, MatchContent, NodeId, StationId, Vec2, WeaponType } from '../shared/types.ts';

/** Names live placement policy without changing the chain library, strategies, or legacy generator. */
export const LIVE_MAP_VERSION = 'chain-live-1';
export const TRANSIT_STATION_COUNT = 6;
const LOOT_KINDS: readonly ItemKind[] = ['cell', 'cell', 'cell', 'weapon', 'weapon', 'weapon', 'med', 'shield', 'access'];
const WEAPON_TYPES: readonly WeaponType[] = ['pistol', 'rifle', 'scattergun'];

/** The existing game has one extraction location with three shared slots. */
export function generateLiveMap(seed: number, content: MatchContent = defaultContent()): GameMap {
  const chain = generate(seed, { mode: 'game', exitCount: 1,
    contestantCount: content.roster.contestants.length, hunterCount: content.roster.gladiators.length }, undefined, DEFAULT_CELL_SIZE);
  return liveMapFromBuilt(seed, composeRegions(chain.results), content);
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
