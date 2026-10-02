import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRegions } from '../map/micro/compose.ts';
import { diagnoseBuiltMap } from '../map/micro/diagnose.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { rect } from '../shared/shape.ts';

/**
 * Three 12 × 10 regions in a row, west to east, at 40 world units a cell. The middle one
 * shares a three-segment portal with each neighbour, so it carries the portal promise
 * (51 stage 5); the outer two have one portal each, and carry none.
 */
const SIZE = 40, W = 12, H = 10;
function briefs() {
  const region = (id, x0, portals) => {
    const cells = [];
    for (let y = 0; y < H; y++) for (let x = x0; x < x0 + W; x++) cells.push({ x, y });
    return { id, seed: 1, type: 'example-open', cellSize: SIZE, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells }], portals };
  };
  const west = { id: 'a~b~v:12,4', axis: 'v', x: W, y: 4, length: 3 }, east = { id: 'b~c~v:24,4', axis: 'v', x: 2 * W, y: 4, length: 3 };
  return [region('a', 0, [west]), region('b', W, [{ ...west }, { ...east }]), region('c', 2 * W, [{ ...east }])];
}
const empty = brief => ({ version: 'region-2', brief, elements: [], coreElements: [], loot: [], manifest: {} });
const wall = (label, x, y, w, h) => ({ label, x, y, template: { w, h, parts: [{ part: 'obstacle', shape: rect(0, 0, w, h), kind: 'ruin-wall' }] } });
const withElements = (results, id, elements) => results.map(r => r.brief.id === id ? { ...r, elements } : r);

test('a map whose builders kept their promises is diagnosed clean', () => {
  assert.deepEqual(diagnoseBuiltMap(composeRegions(briefs().map(empty))), []);
  // The example builders keep theirs, checked the same way.
  assert.deepEqual(diagnoseBuiltMap(composeRegions(briefs().map(brief => buildRegion(brief)))), []);
});

test('a region split by its builder\'s geometry is named, with the portal cut off', () => {
  // A wall from top to bottom of the middle region leaves its east portal unreachable from its west one.
  const split = withElements(briefs().map(empty), 'b', [wall('split', 18 * SIZE, 0, 20, H * SIZE)]);
  const found = diagnoseBuiltMap(composeRegions(split));
  assert.deepEqual(found.map(d => d.region), ['b']);
  assert.ok(found[0].errors.some(e => /Portal b~c~v:24,4 is unreachable from portal a~b~v:12,4/.test(e)), found[0].errors.join(' '));
});

test('a sealed pocket inside a region is the builder\'s business, and is allowed', () => {
  // A closed box of walls away from both portals: the pocket inside it is unreachable, and nothing is named.
  const box = [wall('n', 16 * SIZE, 40, 160, 10), wall('s', 16 * SIZE, 190, 160, 10), wall('w', 16 * SIZE, 40, 10, 160), wall('e', 16 * SIZE + 150, 40, 10, 160)];
  assert.deepEqual(diagnoseBuiltMap(composeRegions(withElements(briefs().map(empty), 'b', box))), []);
  // A region with one portal has no promise to break, however its builder walls it.
  assert.deepEqual(diagnoseBuiltMap(composeRegions(withElements(briefs().map(empty), 'a', [wall('shut', 10 * SIZE, 0, 20, H * SIZE)]))), []);
});
