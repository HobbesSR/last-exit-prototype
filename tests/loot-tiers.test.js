import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, createPhysicsGame, disposePhysics, setInput, step, snapshot } from '../shared/simulation.ts';
import { contentById, defaultContent } from '../shared/simulation/content.ts';
import { collectInstanceEquipment } from '../shared/equipment.ts';
import { dropInventorySlot } from '../shared/simulation/loot.ts';
import { generatedMap } from './helpers/room-harness.js';
import { virtualZone, spatialMix, noveltyBand, qualityFromWeights, itemRoll, assignWeaponQualities, qualityDamage, STARTER_RESERVE } from '../shared/loot-tiers.ts';

const LOOT = contentById('content-loot-1');
const arena = () => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (id = 'content-loot-1') => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
/** A physics match on the arena (or `map`), disposed when test `t` ends. */
const fixture = async (t, map) => {
  const s = await createPhysicsGame(17, map ?? arena(), content());
  t.after(() => disposePhysics(s));
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0] };
};

test('the 5 x 5 selector reproduces the diamond drawing and caps at mix 5', () => {
  const grid = [0, 1, 2, 3, 4].map(row => [0, 1, 2, 3, 4].map(col => spatialMix({ col, row })));
  assert.deepEqual(grid, [[3, 4, 5, 5, 5], [2, 3, 4, 5, 5], [1, 2, 3, 4, 5], [2, 3, 4, 5, 5], [3, 4, 5, 5, 5]]);
  assert.deepEqual([0, 1, 2, 3, 4].map(row => noveltyBand({ col: 2, row })), [2, 1, 0, 1, 2]);
});

test('boundary mapping: edges clamp into the outer zone, a map without extent is column 0 middle row', () => {
  const map = { width: 1000, height: 500 };
  assert.deepEqual(virtualZone(map, { x: 0, y: 0 }), { col: 0, row: 0 });
  assert.deepEqual(virtualZone(map, { x: 199.999, y: 99.999 }), { col: 0, row: 0 });
  assert.deepEqual(virtualZone(map, { x: 200, y: 100 }), { col: 1, row: 1 });
  assert.deepEqual(virtualZone(map, { x: 1000, y: 500 }), { col: 4, row: 4 });
  assert.deepEqual(virtualZone(map, { x: -50, y: 9000 }), { col: 0, row: 4 });
  assert.deepEqual(virtualZone({ width: 0, height: 0 }, { x: 10, y: 10 }), { col: 0, row: 2 });
  assert.deepEqual(virtualZone(map, { x: NaN, y: 250 }), { col: 0, row: 2 });
});

test('weighted draws match each mix over many samples and never pick a zero weight', () => {
  const N = 20000;
  for (const weights of LOOT.lootTiers.mixes) {
    const counts = [0, 0, 0, 0, 0], total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < N; i++) counts[qualityFromWeights(weights, itemRoll(4217, `item-${i}`)) - 1]++;
    for (const [q, w] of weights.entries()) {
      if (!w) { assert.equal(counts[q], 0, `quality ${q + 1} has no weight`); continue; }
      assert.ok(Math.abs(counts[q] / N - w / total) < 0.015, `quality ${q + 1}: ${counts[q] / N} vs ${w / total}`);
    }
  }
  assert.equal(qualityFromWeights([0, 0, 10, 40, 50], 0), 3);
  assert.equal(qualityFromWeights([0, 0, 10, 40, 50], 0.9999999), 5);
});

test('item rolls are keyed by seed and id, not by order', () => {
  assert.equal(itemRoll(9, 'item-4'), itemRoll(9, 'item-4'));
  assert.notEqual(itemRoll(9, 'item-4'), itemRoll(10, 'item-4'));
  const map = arena(), weapons = [0, 1, 2, 3].map(i => ({ id: `item-${i}`, kind: 'weapon', weaponType: 'rifle', x: 590, y: 5 + i }));
  const a = { seed: 5, content: LOOT, map: { ...map, items: structuredClone(weapons) } };
  const b = { seed: 5, content: LOOT, map: { ...map, items: structuredClone(weapons).reverse() } };
  assignWeaponQualities(a); assignWeaponQualities(b);
  const byId = s => Object.fromEntries(s.map.items.map(i => [i.id, i.quality]));
  assert.deepEqual(byId(a), byId(b));
});

test('a live chain map: virtual columns are the generator zone tiers, only quality is added, the spawn kit is quality 1, and weapon quality rises with mix', () => {
  const map = generatedMap(), loot = map.items.filter(item => item.nodeId);
  assert.ok(loot.length > 500, `generated loot: ${loot.length}`);
  for (const item of loot) assert.equal(virtualZone(map, item).col + 1, item.tier, `${item.id} at ${item.x},${item.y}`);
  // Item setup needs no engine, so the shared constructor stands in for a match.
  const plain = createGame(9, structuredClone(map), defaultContent());
  const s = createGame(9, map, contentById('content-loot-1')), byMix = [[], [], [], [], []];
  let kit = 0;
  for (const [i, item] of s.map.items.entries()) {
    assert.deepEqual({ ...item, quality: undefined }, { ...plain.map.items[i], quality: undefined }, 'only quality is added');
    if (item.kind !== 'weapon') { assert.equal(item.quality, undefined); continue; }
    if (s.map.spawns.some(sp => Math.hypot(item.x - sp.x, item.y - sp.y) <= STARTER_RESERVE)) { kit++; assert.equal(item.quality, 1, 'spawn kit'); }
    else if (item.nodeId) byMix[spatialMix(virtualZone(s.map, item)) - 1].push(item.quality);
  }
  assert.ok(kit > 0, 'the map has a spawn kit');
  // Non-entry regions in mix 1 roll loot too, and the #530 layouts place weapons there. Every sampled quality must be
  // possible under that mix's weights, regardless of the chosen layout (#530).
  for (const [mixIndex, qualities] of byMix.entries()) for (const quality of qualities)
    assert.ok(Number.isInteger(quality) && quality >= 1 && quality <= 5 && LOOT.lootTiers.mixes[mixIndex][quality - 1] > 0,
      `mix ${mixIndex + 1} sampled unsupported quality ${quality}`);
  const means = byMix.slice(1).map(q => q.reduce((a, b) => a + b, 0) / q.length);
  // A floor, so no mean is one roll. It is not a content target: denser region content leaves fewer clear
  // loot sites, while the stored seed-9 arena still leaves enough weapons per mix for means to rise (#759).
  assert.ok(byMix.slice(1).every(q => q.length >= 5), `weapons per mix: ${byMix.map(q => q.length)}`);
  for (let i = 1; i < means.length; i++) assert.ok(means[i] > means[i - 1], `mean quality rises over mixes 2..5: ${means.map(m => m.toFixed(2))}`);
});

test('weapon quality is explicit: the default content assigns none and consumes the same RNG and item ids', () => {
  const map = arena();
  for (let i = 0; i < 6; i++) map.items.push({ id: `w-${i}`, kind: 'weapon', weaponType: 'rifle', x: 130 + i * 70, y: 40 + i * 60 });
  const plain = createGame(4217, structuredClone(map), defaultContent());
  const tiered = createGame(4217, structuredClone(map), contentById('content-loot-1'));
  assert.ok(plain.map.items.every(i => i.quality === undefined));
  assert.ok(tiered.map.items.every(i => Number.isInteger(i.quality)));
  assert.equal(tiered.rng, plain.rng);
  assert.equal(tiered.itemSerial, plain.itemSerial);
  assert.equal(qualityDamage(plain.content, { quality: 5 }), 1);
  assert.throws(() => createGame(1, arena(), { ...content(), itemInstances: undefined }), /item instances required/);
});

test('an authored quality is kept; quality scales damage only', async t => {
  const map = arena();
  map.items.push({ id: 'rifle-q4', kind: 'weapon', weaponType: 'rifle', x: 120, y: 200, quality: 4 });
  const { s, p } = await fixture(t, map);
  assert.equal(s.map.items[0].quality, 4);
  // A pickup needs a tick that spends an input.
  setInput(s, p.id, { seq: 0 }); step(s);
  const carried = p.inventory.find(Boolean);
  assert.deepEqual([carried.instanceId, carried.quality], ['rifle-q4', 4]);
  setInput(s, p.id, { seq: 1, attack: true, aim: 0 }); step(s);
  const rifle = s.content.weapons.rifle;
  assert.equal(s.projectiles.length, rifle.spread.length);
  assert.ok(s.projectiles.every(b => b.damage === rifle.damage * 1.24), `damage ${s.projectiles.map(b => b.damage)}`);
  assert.equal(p.attackCd, rifle.cooldown);
});

test('different qualities never merge or refill; quality survives drop and pickup', async t => {
  const { s, p } = await fixture(t);
  const take = item => { s.map.items.push(item); const done = collectInstanceEquipment(s, p, item); if (done) s.map.items = s.map.items.filter(i => i !== item); return done; };
  assert.equal(take({ id: 'p1', kind: 'weapon', weaponType: 'pistol', x: 120, y: 200, ammo: 10, quality: 1 }), true);
  assert.equal(take({ id: 'p3', kind: 'weapon', weaponType: 'pistol', x: 120, y: 200, ammo: 10, quality: 3 }), true);
  assert.deepEqual(p.inventory.filter(Boolean).map(i => [i.instanceId, i.quality, i.ammo]), [['p1', 1, 10], ['p3', 3, 10]]);
  assert.equal(take({ id: 'p3b', kind: 'weapon', weaponType: 'pistol', x: 120, y: 200, ammo: 5, quality: 3 }), true);
  assert.deepEqual(p.inventory.filter(Boolean).map(i => [i.instanceId, i.quality, i.ammo]), [['p1', 1, 10], ['p3', 3, 15]], 'only the equal quality refills');
  assert.equal(dropInventorySlot(s, p, 1), true);
  const dropped = s.map.items.find(i => i.id === 'p3');
  assert.deepEqual([dropped.quality, dropped.ammo, dropped.lineageId], [3, 15, 'p3']);
});

test('the same match replays to identical quality-bearing frames', async t => {
  const run = async () => {
    const map = arena();
    for (let i = 0; i < 6; i++) map.items.push({ id: `w-${i}`, kind: 'weapon', weaponType: 'scattergun', x: 130 + i * 70, y: 40 + i * 60 });
    const { s, p } = await fixture(t, map), frames = [];
    for (let i = 0; i < 30; i++) { setInput(s, p.id, { seq: i + 1, x: 1, attack: i % 5 === 0, aim: 0 }); step(s); frames.push(JSON.stringify(snapshot(s))); }
    return frames;
  };
  const frames = await run();
  assert.deepEqual(await run(), frames);
  assert.ok(JSON.parse(frames[0]).items.every(i => Number.isInteger(i.quality)));
});
