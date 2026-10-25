import test from 'node:test';
import assert from 'node:assert/strict';
import { REGION_SHAPES, regionExample } from '../map/micro/region-examples.ts';
import { briefErrors, buildRegion, REGION_TYPES } from '../map/micro/region-types.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';

const key = ({ x, y }) => `${x},${y}`;

function connected(cells) {
  const owned = new Set(cells.map(key));
  const seen = new Set([key(cells[0])]), queue = [cells[0]];
  for (const { x, y } of queue) for (const neighbour of [
    { x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 },
  ]) {
    const k = key(neighbour);
    if (owned.has(k) && !seen.has(k)) { seen.add(k); queue.push(neighbour); }
  }
  return seen.size === owned.size;
}

test('default rectangle, L and hole keep their 24 x 18 cells and side portals', () => {
  for (const [shape, missing] of [['rectangle', 0], ['l', 48], ['hole', 12]]) {
    const brief = regionExample({ shape });
    assert.equal(brief.cells.length, 24 * 18 - missing, shape);
    assert.deepEqual(brief.portals, [
      { id: 'hunter-west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'hunter-east', axis: 'v', x: 24, y: 8, length: 2 },
    ]);
    assert.deepEqual(regionExample({ shape, northPortal: true }).portals.at(-1),
      { id: 'contestant-north', axis: 'h', x: 10, y: 0, length: 2 });
  }
  const brief = regionExample();
  assert.equal(brief.seed, 4217);
  assert.equal(brief.cellSize, 40);
  assert.deepEqual(brief.zones, [{ tier: 2, bonus: 0, lootChance: 0.04, cells: brief.cells }]);
});

test('all shapes stay connected and carry valid external portal runs at varied sizes', () => {
  assert.deepEqual(REGION_SHAPES.map(s => s.id), ['rectangle', 'l', 'hole', 'neck', 'cross', 'stair']);
  for (const { id: shape } of REGION_SHAPES) for (const [width, height] of [[8, 8], [17, 13], [24, 18], [48, 48]]) {
    const brief = regionExample({ shape, width, height, northPortal: true });
    assert.ok(brief.cells.length > 0 && connected(brief.cells), `${shape} ${width}x${height}`);
    assert.equal(new Set(brief.cells.map(key)).size, brief.cells.length);
    assert.deepEqual(briefErrors(brief), [], `${shape} ${width}x${height}`);
    assert.deepEqual(portalStands(brief).map(s => s.points.length > 0), [true, true, true]);
    assert.equal(brief.zones[0].cells.length, brief.cells.length);
    if (width <= 24) assert.deepEqual(validatePortalReach({ ...brief, blockers: [] }).errors, [],
      `${shape} ${width}x${height} empty-mask portal reach`);
  }
});

test('inputs reject unknown types, unsupported shapes, and out-of-range controls', () => {
  for (const type of Object.keys(REGION_TYPES))
    assert.equal(regionExample({ type }).type, type);
  for (const options of [
    { type: 'missing' }, { type: '__proto__' },
    { shape: 'zigzag' }, { width: 7 }, { width: 49 }, { width: 8.5 },
    { height: 7 }, { height: 49 }, { height: NaN },
    { tier: 0 }, { tier: 6 }, { tier: 2.5 },
    { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { northPortal: 1 },
  ]) assert.throws(() => regionExample(options), JSON.stringify(options));
});

test('special builders receive their core requests and can build the example brief', () => {
  for (const [type, expected] of [
    ['arrival', { spawn: 8 }],
    ['departure', { exit: 3, 'hunter-spawn': 3 }],
    ['charging', { charger: 1 }],
    ['transit', { warp: 1 }],
  ]) {
    const brief = regionExample({ type });
    assert.deepEqual(brief.coreElements, expected);
    const built = buildRegion(brief);
    assert.equal(built.version, 'region-2');
    assert.ok(built.coreElements.length > 0, type);
    assert.ok(built.coreElements.every(site => Object.hasOwn(expected, site.kind)), type);
  }
  assert.equal(regionExample({ type: 'cover' }).coreElements, undefined);
  assert.equal(buildRegion(regionExample({ type: 'cover', shape: 'hole' })).version, 'region-2');
});
