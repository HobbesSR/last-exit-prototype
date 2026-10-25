import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createGame, setInput, step, snapshot } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { collectInstanceEquipment } from '../shared/equipment.ts';
import { dropInventorySlot } from '../shared/simulation/loot.ts';
import { generateLiveMap } from '../map/live.ts';
import { virtualZone, spatialMix, noveltyBand, qualityFromWeights, itemRoll, assignWeaponQualities, qualityDamage, STARTER_RESERVE } from '../shared/loot-tiers.ts';

const LOOT = contentById('content-loot-1');
const arena = () => ({ width: 600, height: 400,
  playableArea: { cellSize: 100, rows: Array.from({ length: 4 }, (_, y) => ({ y, runs: [[0, 6]] })) },
  obstacles: [], gates: [], hazards: [], spawns: [{ x: 120, y: 200 }, { x: 400, y: 200 }],
  stations: [], chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
  modules: [], buildings: [], exit: { x: 550, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] });
const content = (id = 'content-loot-1') => ({ ...structuredClone(contentById(id)), roster: { contestants: ['A', 'B'], gladiators: [] }, discovery: false });
const fixture = map => {
  const s = createGame(17, map ?? arena(), content());
  for (const p of s.players) { p.bot = false; p.input = {}; }
  return { s, p: s.players[0] };
};
const fixtureMaps = () => Object.values(JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/behavior-nav-1.json.gz', import.meta.url)))).maps);

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

test('stored diamond maps: the population improves with mix, the spawn kit is quality 1, tier metadata is untouched', () => {
  const byMix = [[], [], [], [], []];
  for (const stored of fixtureMaps()) {
    const s = createGame(4217, structuredClone(stored), contentById('content-loot-1'));
    const l0 = createGame(4217, structuredClone(stored), contentById('content-equipment-1'));
    assert.equal(s.version, 'last-exit-0.8-loot-1');
    for (const [i, item] of s.map.items.entries()) {
      const before = l0.map.items[i];
      assert.deepEqual({ ...item, quality: undefined }, { ...before, quality: undefined }, 'only quality is added');
      if (item.kind !== 'weapon') { assert.equal(item.quality, undefined); continue; }
      assert.ok(Number.isInteger(item.quality) && item.quality >= 1 && item.quality <= 5);
      if (s.map.spawns.some(sp => Math.hypot(item.x - sp.x, item.y - sp.y) <= STARTER_RESERVE)) assert.equal(item.quality, 1, 'spawn kit');
      else byMix[spatialMix(virtualZone(s.map, item)) - 1].push(item.quality);
    }
  }
  const means = byMix.map(q => q.length ? q.reduce((a, b) => a + b, 0) / q.length : null).filter(m => m !== null);
  assert.ok(means.length >= 4, `mixes sampled: ${means.length}`);
  for (let i = 1; i < means.length; i++) assert.ok(means[i] > means[i - 1], `mean quality rises with mix: ${means.map(m => m.toFixed(2))}`);
});

test('a live chain map: virtual columns are the generator zone tiers, and weapon quality rises with mix', () => {
  const map = generateLiveMap(1), loot = map.items.filter(item => item.nodeId);
  assert.ok(loot.length > 500, `generated loot: ${loot.length}`);
  for (const item of loot) assert.equal(virtualZone(map, item).col + 1, item.tier, `${item.id} at ${item.x},${item.y}`);
  const s = createGame(1, map, contentById('content-loot-1')), byMix = [[], [], [], [], []];
  for (const item of s.map.items) if (item.kind === 'weapon' && item.nodeId) byMix[spatialMix(virtualZone(s.map, item)) - 1].push(item.quality);
  // Authored set pieces can now place loot in mix 1. Every sampled quality must be
  // possible under that mix's weights, regardless of the chosen layout (#530).
  for (const [mixIndex, qualities] of byMix.entries()) for (const quality of qualities)
    assert.ok(Number.isInteger(quality) && quality >= 1 && quality <= 5 && LOOT.lootTiers.mixes[mixIndex][quality - 1] > 0,
      `mix ${mixIndex + 1} sampled unsupported quality ${quality}`);
  const means = byMix.slice(1).map(q => q.reduce((a, b) => a + b, 0) / q.length);
  assert.ok(byMix.slice(1).every(q => q.length >= 10), `weapons per mix: ${byMix.map(q => q.length)}`);
  for (let i = 1; i < means.length; i++) assert.ok(means[i] > means[i - 1], `mean quality rises over mixes 2..5: ${means.map(m => m.toFixed(2))}`);
});

test('L1 is explicit: default and L0 content assign no quality and consume the same RNG', () => {
  const [stored] = fixtureMaps();
  const legacy = createGame(4217, structuredClone(stored));
  assert.ok(legacy.map.items.every(i => i.quality === undefined));
  const l0 = createGame(4217, structuredClone(stored), contentById('content-equipment-1'));
  const l1 = createGame(4217, structuredClone(stored), contentById('content-loot-1'));
  assert.ok(l0.map.items.every(i => i.quality === undefined));
  assert.equal(l1.rng, l0.rng);
  assert.equal(l1.itemSerial, l0.itemSerial);
  assert.equal(qualityDamage(legacy.content, { quality: 5 }), 1);
  assert.throws(() => createGame(1, arena(), { ...content(), itemInstances: undefined }), /requires L0/);
});

test('an authored quality is kept; quality scales damage only', () => {
  const map = arena();
  map.items.push({ id: 'rifle-q4', kind: 'weapon', weaponType: 'rifle', x: 120, y: 200, quality: 4 });
  const { s, p } = fixture(map);
  assert.equal(s.map.items[0].quality, 4);
  step(s);
  const carried = p.inventory.find(Boolean);
  assert.deepEqual([carried.instanceId, carried.quality], ['rifle-q4', 4]);
  setInput(s, p.id, { seq: 1, attack: true, aim: 0 }); step(s);
  const rifle = s.content.weapons.rifle;
  assert.equal(s.projectiles.length, rifle.spread.length);
  assert.ok(s.projectiles.every(b => b.damage === rifle.damage * 1.24), `damage ${s.projectiles.map(b => b.damage)}`);
  assert.equal(p.attackCd, rifle.cooldown);
});

test('different qualities never merge or refill; quality survives drop and pickup', () => {
  const { s, p } = fixture();
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

test('the same match replays to identical quality-bearing frames', () => {
  const run = () => {
    const map = arena();
    for (let i = 0; i < 6; i++) map.items.push({ id: `w-${i}`, kind: 'weapon', weaponType: 'scattergun', x: 130 + i * 70, y: 40 + i * 60 });
    const { s, p } = fixture(map), frames = [];
    for (let t = 0; t < 30; t++) { setInput(s, p.id, { seq: t + 1, x: 1, attack: t % 5 === 0, aim: 0 }); step(s); frames.push(JSON.stringify(snapshot(s))); }
    return frames;
  };
  const frames = run();
  assert.deepEqual(run(), frames);
  assert.ok(JSON.parse(frames[0]).items.every(i => Number.isInteger(i.quality)));
});
