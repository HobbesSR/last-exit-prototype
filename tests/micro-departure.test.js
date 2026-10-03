import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { circle } from '../shared/shape.ts';

const SIZE = 40;
const { clearance, lootRadius } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' });
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals = [], extra = {}) => ({
  id, seed, type: 'departure', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells }], portals,
  coreElements: { exit: 3, 'hunter-spawn': 3 }, ...extra,
});
const blockersOf = result => result.elements.flatMap(elementShapes);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const kind = (result, name) => result.coreElements.filter(site => site.kind === name);
const radiusOf = site => site.kind === 'hunter-spawn' ? clearance.hunter : clearance.contestant;

/** Every site stands clear inside the region, clear of cover and loot, and is reachable from the first portal. */
function assertSitesClear(result, label) {
  const mask = createRegionMask(result.brief), blockers = blockersOf(result);
  const root = portalStands(result.brief, mask).find(portal => portal.points.length)?.points[0];
  for (const site of result.coreElements) {
    const stand = circle(site.x, site.y, radiusOf(site));
    assert.ok(mask.contains(stand), `${label}: ${site.kind} ${site.x},${site.y} fits inside owned cells`);
    assert.ok(blockers.every(shape => !shapesOverlap(stand, shape)), `${label}: cover clears ${site.kind} ${site.x},${site.y}`);
    assert.ok(result.loot.every(loot => !shapesOverlap(stand, circle(loot.x, loot.y, lootRadius))), `${label}: loot clears ${site.kind}`);
    if (root) assert.ok(findRegionRoute(mask, blockers, root, site, radiusOf(site)), `${label}: ${site.kind} ${site.x},${site.y} reached from the first portal`);
  }
}

test('departure sites its exits and hunter spawns, set back, before cover and loot', () => {
  const result = buildRegion(brief('far-east', 7, cellsOf(30, 24), [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 4 },
    { id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
  ]));
  assert.equal(result.version, 'region-2');
  assert.equal(kind(result, 'exit').length, 3);
  assert.equal(kind(result, 'hunter-spawn').length, 3);
  assert.equal(result.manifest.coreElements, 6);
  assert.ok(result.elements.length > 0, 'the fixture exercises cover clearance');
  assert.ok(result.loot.length > 0, 'the fixture exercises loot clearance');
  assert.equal(result.manifest.loot, result.loot.length);
  assertSitesClear(result, 'far-east');
  for (const hunter of kind(result, 'hunter-spawn')) for (const exit of kind(result, 'exit'))
    assert.ok(distance(hunter, exit) >= 6 * SIZE - 1e-6, 'hunters start a tile back from every exit by default');
  const exits = kind(result, 'exit'), hunters = kind(result, 'hunter-spawn');
  for (const group of [exits, hunters]) for (let i = 0; i < group.length; i++) for (let j = 0; j < i; j++)
    assert.ok(distance(group[i], group[j]) >= 2 * radiusOf(group[i]) - 1e-6, 'bodies do not overlap');
});

test('departure honors its exit spacing and set-back, deterministically', () => {
  const input = brief('tuned', 13, cellsOf(40, 30), [], { parameters: { exitSpacing: 12, setBack: 10 } });
  const result = buildRegion(input);
  assert.deepEqual(buildRegion(input), result);
  const exits = kind(result, 'exit'), hunters = kind(result, 'hunter-spawn');
  assert.equal(exits.length, 3);
  assert.equal(hunters.length, 3);
  for (let i = 0; i < exits.length; i++) for (let j = 0; j < i; j++)
    assert.ok(distance(exits[i], exits[j]) >= 12 * SIZE - 1e-6, 'exit spacing is measured in cells');
  for (const hunter of hunters) for (const exit of exits)
    assert.ok(distance(hunter, exit) >= 10 * SIZE - 1e-6, 'set-back is measured in cells');
  assert.notDeepEqual(buildRegion({ ...input, seed: 14 }).coreElements, result.coreElements, 'seed affects equally good layouts');
});

test('departure leaves an impossible set-back or spacing as a shortfall', () => {
  const cells = cellsOf(12, 12);
  const crowded = buildRegion(brief('no-room', 5, cells, [], { parameters: { setBack: 30 } }));
  assert.equal(kind(crowded, 'exit').length, 3);
  assert.equal(kind(crowded, 'hunter-spawn').length, 0, 'no ground lies 30 cells from an exit');
  assert.equal(crowded.manifest.coreElements, crowded.coreElements.length);
  const spaced = buildRegion(brief('far-apart', 5, cells, [], { parameters: { exitSpacing: 20 } }));
  assert.ok(kind(spaced, 'exit').length > 0 && kind(spaced, 'exit').length < 3);
  assert.throws(() => buildRegion(brief('bad', 5, cells, [], { parameters: { setBack: -1 } })), /setBack must be a positive number/);
});

test('departure keeps the whole-portal promise over seeds and shaped masks', () => {
  const masks = [
    ['ell', cellsOf(30, 30, (x, y) => y < 15 || x < 15), [
      { id: 'east', axis: 'v', x: 30, y: 4, length: 3 },
      { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
      { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 },
    ]],
    ['ring', cellsOf(32, 32, (x, y) => x < 10 || x >= 22 || y < 10 || y >= 22), [
      { id: 'north', axis: 'h', x: 12, y: 0, length: 5 },
      { id: 'hole', axis: 'v', x: 22, y: 14, length: 4 },
      { id: 'south', axis: 'h', x: 3, y: 32, length: 3 },
    ]],
  ];
  for (const [name, cells, portals] of masks) for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(name, seed, cells, portals));
    const check = validatePortalReach({ ...result.brief, blockers: blockersOf(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
    assert.equal(kind(result, 'exit').length, 3, `${name} seed ${seed} exit count`);
    assert.equal(kind(result, 'hunter-spawn').length, 3, `${name} seed ${seed} hunter count`);
    assertSitesClear(result, `${name} seed ${seed}`);
  }
});
