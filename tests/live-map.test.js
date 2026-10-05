import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLiveMap, liveChainParams, liveMapFromBuilt, liveMismatch, liveRecipeMismatch, liveSeed } from '../map/live.ts';
import { generate } from '../map/chain.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { canOccupy, moveBody } from '../shared/movement.ts';
import { defaultContent, contentById } from '../shared/simulation/content.ts';
import { createGame, setInput, step } from '../shared/simulation.ts';
import { createMatch } from '../server/match.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let defaultMap;
const live = () => defaultMap ??= generateLiveMap(1);

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

test('the adapter is deterministic, content-sized, and is the default match map', () => {
  const map = live();
  assert.deepEqual(generateLiveMap(1), map);
  assert.deepEqual(createMatch(1).map(), map);
  const twoHunters = contentById('content-1');
  const earlier = generateLiveMap(1, twoHunters);
  assert.equal(earlier.hunterSpawns.length, twoHunters.roster.gladiators.length);
  assert.equal(earlier.spawns.length, twoHunters.roster.contestants.length);
});

test('a chain map the Map Lab calls live is the map a room with its seed plays', () => {
  const chain = generate('1', liveChainParams());
  assert.deepEqual(liveMismatch(chain), []);
  assert.deepEqual(liveMapFromBuilt(liveSeed(chain.layout.seed), composeRegions(chain.results)), live());
  const other = { ...chain, layout: { ...chain.layout, seed: '01', params: { ...chain.layout.params, exitCount: 2 } },
    library: { ...chain.library, name: 'draft' }, cellSize: 32, build: 'older' };
  assert.deepEqual(liveMismatch(other).map(reason => reason.split(' ').slice(0, 2).join(' ')),
    ['the seed', 'exitCount is', 'the library', 'the cell', 'the regions']);
  // A loaded save can keep its seed and recipe and still be edited: only the seed's own map is a room's.
  const turned = structuredClone(chain), slot = turned.layout.slots[0];
  slot.orientation = slot.orientation === 0 ? 90 : 0;
  assert.deepEqual(liveRecipeMismatch(turned), []);
  assert.match(liveMismatch(turned).join(), /^the map isn't the one its seed generates \(layout\.slots\[0\]\.orientation: /);
  const moved = structuredClone(chain);
  moved.results[0].coreElements.push({ kind: 'charger', x: 0, y: 0 });
  assert.match(liveMismatch(moved).join(), /\(results\[0\]\.coreElements/);
  for (const seed of ['0', '1e3', '2147483648', '1.5', ' 7', 'last-exit-001']) assert.equal(liveSeed(seed), null, seed);
  assert.equal(liveSeed('2147483647'), 2147483647);
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

test('live sites allow charging, extraction, and safe hunter redeployment', () => {
  const map = structuredClone(live()), game = createGame(1, map), contestant = game.players[0];
  for (const player of game.players) player.bot = false;
  game.map.traps = [];
  Object.assign(contestant, map.chargers[0]);
  contestant.inventory[0] = { kind: 'cell', charge: 0 };
  const press = (player, input) => { setInput(game, player.id, { seq: player.lastSeq + 1, ...input }); step(game); };
  press(contestant, { interact: true });
  for (let i = 1; i < game.content.cellChargeTicks; i++) step(game);
  assert.equal(contestant.inventory[0].charge, game.content.cellChargeTicks);
  Object.assign(contestant, map.exit);
  press(contestant, { interact: true });
  assert.equal(contestant.status, 'escaped');
  assert.equal(game.slots, 2);
  const hunter = game.players.find(player => player.role === 'gladiator');
  hunter.status = 'respawning'; hunter.respawnAt = game.tick + 1;
  step(game);
  assert.equal(hunter.status, 'active');
  assert.ok(map.stations.some(site => distance(hunter, site) === 0));
});

test('the adapter rejects missing and extra required core sites', () => {
  const content = defaultContent();
  const chain = generate(1, { mode: 'game', exitCount: 1, contestantCount: content.roster.contestants.length,
    hunterCount: content.roster.gladiators.length });
  const built = composeRegions(chain.results);
  const regionIds = new Set(built.regions.map(region => region.brief.id));
  const authored = [...live().chargers, ...live().stations, ...live().items.filter(item => item.nodeId)];
  assert.ok(authored.every(site => regionIds.has(site.nodeId)), 'node ownership names a built region');
  const authoredTiers = new Set(built.regions.flatMap(region => region.loot.map(site => site.tier)));
  assert.ok(live().items.filter(item => item.nodeId && item.tier != null).every(item => authoredTiers.has(item.tier)));
  const missing = structuredClone(built);
  const spawnRegion = missing.regions.find(region => region.coreElements.some(site => site.kind === 'spawn'));
  spawnRegion.coreElements.splice(spawnRegion.coreElements.findIndex(site => site.kind === 'spawn'), 1);
  assert.throws(() => liveMapFromBuilt(1, missing), /needs .* spawns/);
  const extra = structuredClone(built);
  const exitRegion = extra.regions.find(region => region.coreElements.some(site => site.kind === 'exit'));
  exitRegion.coreElements.push({ ...exitRegion.coreElements.find(site => site.kind === 'exit') });
  assert.throws(() => liveMapFromBuilt(1, extra), /one exit/);
});
