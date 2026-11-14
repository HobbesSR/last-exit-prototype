import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt, liveRecipeMismatch, LIVE_ZONE_SIZES } from '../../map/live.ts';
import { generate, generateMacro } from '../../map/chain.ts';
import { mapViews } from '../../map/macro/src/chain/map.ts';
import { chainMapToBson, chainMapToJson, decodeChainMap, readChainMap } from '../../map/macro/src/chain/saving.ts';
import { builtMapFrame } from '../../map/micro/adapter.ts';
import { composeRegions } from '../../map/micro/compose.ts';
import { canOccupy, moveBody } from '../../shared/movement.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { DEPOT_WAREHOUSE_APPEARANCE } from '../../map/micro/strategies/depot.ts';
import { resolveBuildingAppearance } from '../../public/appearance.js';
import { createGame, disposePhysics, step } from '../../shared/simulation.ts';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// One generation of seed 1's chain serves the cases below that read it, moved here from
// tests/live-map.test.js and tests/appearance-descriptor.test.js: building a map is slow-tier work
// (31, #1071). That it is the map a room generates from seed 1 is tests/slow/live-map-adapter.test.js's
// claim. No case mutates it.
let defaultMap, defaultChain, defaultBuilt;
const liveChain = () => defaultChain ??= generate('1', liveChainParams());
const liveBuilt = () => defaultBuilt ??= composeRegions(liveChain().results);
const live = () => defaultMap ??= liveMapFromBuilt(1, liveBuilt());

// Two maps: the claim is that the mechanism completes on a chain map, and more seeds only sample
// for stalls. 4217, the third seed here until #822, is the map physics-navigation plays. On the
// shipped content and its engine (#920).
test('combat-neutralized bots fill all three extraction slots on representative live chain maps', async () => {
  const content = defaultContent();
  for (const seed of [1, 9]) {
    const game = await createGame(seed, generateLiveMap(seed, content), content);
    try {
      game.map.traps = [];
      for (const player of game.players) {
        if (player.role === 'gladiator') player.status = 'eliminated';
        else player.shield = 1000000;
      }
      // The match ends at its declared duration however play goes, so a stalled one fails here.
      const limit = game.content.durationTicks;
      for (let i = 0; i <= limit && game.phase === 'live'; i++) step(game);
      assert.notEqual(game.phase, 'live', `seed ${seed}: the match ended within its ${limit}-tick duration`);
      assert.equal(game.slots, 0, `seed ${seed}: three extraction slots filled`);
      assert.equal(game.players.filter(player => player.status === 'escaped').length, 3, `seed ${seed}: three contestants escaped`);
    } finally { disposePhysics(game); }
  }
});

// Macro alone (#821): the recipe is all the map states, and the frame the adapter would give the
// built map is its briefs' cell extent. Building and converting the 1,049 regions took 18 s. No
// per-run test builds or converts a composed 24 x 12 map any more: micro-large-briefs builds each
// type's extreme stored brief at the larger sizes (13 types, not transit, arrival or departure),
// not these briefs, and the adapter has no size branch beyond the frame (#822).
test('at the larger authored size macro states a room recipe, and its briefs give the room frame', () => {
  const size = LIVE_ZONE_SIZES[1];
  const chain = generateMacro('1', liveChainParams(defaultContent(), size));
  assert.deepEqual(liveRecipeMismatch(chain), []);
  const { width, height } = builtMapFrame({ cellSize: chain.cellSize, regions: mapViews(chain).briefs.map(brief => ({ brief })) });
  assert.deepEqual([width, height], [34560, 17280]);
});

test('a chain live map supplies usable authored sites and retained loot metadata', () => {
  const map = live(), content = defaultContent();
  assert.equal(map.generator, 'chain-live-1');
  assert.deepEqual([map.width, map.height], [17280, 8640]);
  assert.equal(map.playableArea.cellSize, 48);
  assert.ok(map.playableArea.rows.length > 0);
  assert.equal(map.spawns.length, content.roster.contestants.length);
  assert.equal(map.hunterSpawns.length, content.roster.gladiators.length);
  assert.equal(map.stations.length, 6, 'distributed transit is authored');
  assert.ok(map.chargers.length > 0);
  for (const [sites, radius] of [[map.spawns, 12], [map.hunterSpawns, 23], [[map.exit], 23], [map.chargers, 24], [map.stations, 25]])
    for (const site of sites) assert.ok(canOccupy(map, site.x, site.y, radius), `site at ${site.x},${site.y}`);
  for (const spawn of map.spawns) {
    assert.ok(map.items.some(item => item.kind === 'weapon' && item.weaponType === 'pistol' && distance(item, spawn) <= 100), 'starter pistol');
    assert.ok(map.items.some(item => item.kind === 'cell' && distance(item, spawn) <= 100), 'early cell');
  }
  assert.ok(map.items.every(item => item.kind !== 'weapon' || ['pistol', 'rifle', 'scattergun'].includes(item.weaponType)));
  const owned = [...map.chargers, ...map.stations, ...map.items.filter(item => item.nodeId)];
  assert.ok(new Set(owned.map(site => site.nodeId)).size > 1, 'sites retain distinct region ownership');
  assert.ok(map.items.some(item => Number.isInteger(item.tier) && item.tier >= 1), 'micro loot tier survives runtime conversion');
});

test('JSON map transfer keeps the mask and both roles can move from authored starts', () => {
  const map = live(), transferred = JSON.parse(JSON.stringify(map));
  assert.deepEqual(transferred.playableArea, map.playableArea);
  for (const [start, radius] of [[map.spawns[0], 12], [map.hunterSpawns[0], 23]]) {
    const direction = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => canOccupy(map, start.x + dx * 9, start.y + dy * 9, radius));
    assert.ok(direction, 'an authored start has an adjacent traversable step');
    const a = { ...start }, b = { ...start };
    moveBody(map, a, { x: direction[0], y: direction[1] }, radius, 9);
    moveBody(transferred, b, { x: direction[0], y: direction[1] }, radius, 9);
    assert.deepEqual(b, a, 'client movement from a JSON map agrees with the server');
    assert.ok(distance(a, start) > 0);
  }
});

test('each live site and item keeps its own source region, place and tier', () => {
  const map = live(), built = liveBuilt();
  const { origin } = builtMapFrame(built), regions = new Map(built.regions.map(region => [region.brief.id, region]));
  const world = site => `${site.x + origin.x},${site.y + origin.y}`;
  for (const [sites, kind] of [[map.chargers, 'charger'], [map.stations, 'warp']]) {
    assert.equal(sites.length, built.regions.flatMap(region => region.coreElements).filter(site => site.kind === kind).length, `every ${kind} is retained`);
    for (const site of sites) assert.ok(regions.get(site.nodeId)?.coreElements.some(source => source.kind === kind && world(source) === `${site.x},${site.y}`),
      `${kind} at ${site.x},${site.y} is a ${kind} of ${site.nodeId}`);
  }
  const loot = map.items.filter(item => item.nodeId);
  assert.ok(loot.length > 0, 'region loot is retained');
  for (const item of loot) {
    const source = regions.get(item.nodeId)?.loot.find(spot => world(spot) === `${item.x},${item.y}`);
    assert.ok(source, `${item.id} at ${item.x},${item.y} is a loot site of ${item.nodeId}`);
    assert.equal(item.tier, source.tier, `${item.id} keeps its site's tier`);
  }
});

test('chain map export/load round-trips via JSON and BSON and legacy maps load cleanly', () => {
  // 1. Generated chain map with adopted depot warehouses
  const chain = liveChain();
  const depotResult = chain.results.find(r => r.brief.type === 'depot');
  assert.ok(depotResult, 'depot region exists in live chain map');
  assert.ok(
    depotResult.elements.some(e => e.template.appearance?.building),
    'depot elements carry building appearance'
  );

  // JSON export & load
  const json = chainMapToJson(chain);
  const loadedJson = decodeChainMap(JSON.parse(json), chain.library);
  assert.deepEqual(loadedJson, chain, 'chain map with appearance round-trips via JSON');

  // BSON export & load
  const bson = chainMapToBson(chain);
  const loadedBson = readChainMap(bson, chain.library);
  assert.deepEqual(loadedBson, chain, 'chain map with appearance round-trips via BSON');

  // Stamping into live map preserves appearance on GameMap.buildings
  const liveMap = liveMapFromBuilt(1, composeRegions(loadedJson.results));
  const buildingsWithApp = liveMap.buildings.filter(b => b.appearance);
  assert.ok(buildingsWithApp.length > 0, 'live map has buildings with appearance');
  const depotBuildings = buildingsWithApp.filter(b => b.nodeId === depotResult.brief.id);
  assert.ok(depotBuildings.length > 0, 'depot buildings have appearance');
  for (const b of depotBuildings) {
    assert.deepEqual(b.appearance, DEPOT_WAREHOUSE_APPEARANCE);
  }

  // 2. Legacy map without appearance loads and plays cleanly
  const legacyMap = {
    ...liveMap,
    appearance: undefined,
    buildings: liveMap.buildings.map(b => ({ ...b, appearance: undefined })),
    obstacles: liveMap.obstacles.map(o => ({ ...o, appearance: undefined })),
  };
  assert.equal(legacyMap.appearance, undefined);
  for (const b of legacyMap.buildings) {
    assert.equal(b.appearance, undefined);
    const res = resolveBuildingAppearance(b, legacyMap.appearance, { palette: 'signature' });
    assert.ok(res.floorFill > 0);
    assert.ok(res.roofFill > 0);
    assert.equal(res.floorMarks.length, 0);
    assert.equal(res.roofMarks.length, 0);
  }
});
