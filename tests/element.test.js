import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import { HUT, REGION_ELEMENTS, REGION_PROPS } from '../shared/map/templates.ts';
import { CORNER_CLEARANCE } from '../shared/map/structures.ts';
import { polygon, convex, bounds, fieldsOf } from '../shared/shape.ts';
import { canOccupy } from '../shared/movement.ts';

// Anchored near the middle of the diamond, because `canOccupy` also enforces the arena boundary.
const CENTRE = { x: 12000, y: 6000 };
const stamp = (x, y, placement = {}) => {
  const context = createGenerationContext(7);
  placeElement(context, HUT, x, y, { nodeId: 'n', ...placement });
  return context;
};
const collidable = context => ({ width: 24000, height: 12000, obstacles: context.map.obstacles, gates: [] });

test('an element stamps the same assembly wherever it is anchored', () => {
  const here = stamp(CENTRE.x, CENTRE.y), there = stamp(CENTRE.x + 3000, CENTRE.y + 1500);
  assert.deepEqual(here.map.obstacles.map(o => o.kind),
    ['building', 'window', 'window', 'building', 'building', 'building', 'building', 'building'],
    'parts are emitted in the order the template declares, which the id counter depends on');
  for (const [i, part] of there.map.obstacles.entries()) {
    assert.equal(part.x - here.map.obstacles[i].x, 3000);
    assert.equal(part.y - here.map.obstacles[i].y, 1500);
    assert.deepEqual([part.w, part.h, part.kind], [here.map.obstacles[i].w, here.map.obstacles[i].h, here.map.obstacles[i].kind]);
  }
});

test('an enclosing element registers a building and tags everything inside it', () => {
  const context = stamp(CENTRE.x, CENTRE.y, { locked: true });
  const [building] = context.map.buildings;
  assert.deepEqual({ x: building.x, y: building.y, w: building.w, h: building.h },
    { x: CENTRE.x, y: CENTRE.y, w: 250, h: 250 }, 'the building box is the template footprint');
  assert.ok(context.map.obstacles.every(o => o.buildingId === building.id), 'every wall belongs to it');
  assert.equal(context.map.gates[0].buildingId, building.id);
  assert.deepEqual(context.spots, [{ x: 12125, y: 6125, nodeId: 'n', buildingId: building.id }]);
  assert.deepEqual(context.reservations, [{ x: 11970, y: 5970, w: 310, h: 350 }]);
  // Locking is a property of the instance, so one template serves locked and unlocked doors alike.
  assert.equal(context.map.gates[0].locked, true);
  assert.equal(stamp(CENTRE.x, CENTRE.y).map.gates[0].locked, false);
});

test('the stamped shell is solid, and only its doorway and windows behave otherwise', () => {
  const map = collidable(stamp(CENTRE.x, CENTRE.y));
  assert.equal(canOccupy(map, 12125, 6125), true, 'the interior is clear');
  assert.equal(canOccupy(map, 12125, 6241), true, 'the doorway gap passes a body');
  assert.equal(canOccupy(map, 12040, 6241), false, 'the south wall beside it does not');
  assert.equal(canOccupy(map, 12095, 6009, 4), false, 'a window stops a body');
  assert.equal(canOccupy(map, 12095, 6009, 4, false, true), true, 'and passes a shot');
});

// The point of describing parts as shapes rather than boxes: a template may hold geometry the
// generator has never emitted, and it becomes collidable without a new case anywhere.
test('a template part of any shape becomes real geometry, not just a box', () => {
  const context = createGenerationContext(3);
  const tower = { w: 120, h: 120, parts: [{ part: 'obstacle', kind: 'container', shape: polygon(60, 60, [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }]) }] };
  placeElement(context, tower, CENTRE.x, CENTRE.y, { nodeId: 'n' });
  const [part] = context.map.obstacles;
  assert.deepEqual({ x: part.x, y: part.y, w: part.w, h: part.h }, { x: 12010, y: 6010, w: 100, h: 100 },
    'the record carries the extent, so footprint tests that read raw fields stay correct');
  assert.equal(part.buildingId, undefined, 'a non-enclosing element registers no building');
  const map = collidable(context);
  assert.equal(canOccupy(map, 12060, 6060), false, 'the polygon is solid');
  assert.equal(canOccupy(map, 12060, 6200), true, 'and only where it stands');
});

const catalogue = [
  ...Object.entries(REGION_ELEMENTS).flatMap(([region, set]) => set.map((template, i) => [`${region}[${i}]`, template])),
  ...Object.entries(REGION_PROPS).map(([region, template]) => [`${region} cover`, template]),
];

// A template too large for a block corner is rejected by `clearFootprint` everywhere, so it never
// appears on any map and nothing reports it. WAREHOUSE and COMPOUND were both born that way.
test('every catalogue template fits a block corner, or it would never appear on any map', () => {
  for (const [region, set] of Object.entries(REGION_ELEMENTS)) {
    assert.ok(set.length > 0, `${region} has no elements`);
    assert.ok(set.some(t => t.encloses), `${region} needs an enclosing structure: indoor loot is where cells concentrate`);
  }
  for (const [name, template] of catalogue) assert.ok(template.w <= CORNER_CLEARANCE || template.h <= CORNER_CLEARANCE,
    `${name}: a ${template.w}x${template.h} element clears the reserved block centre in neither axis`);
});

// `docs/29`: SAT only separates convex bodies, and a concave one separates in the wrong direction
// rather than failing loudly, so generated content is checked at build time instead of trusted.
// This is that check -- the catalogue is where a concave body would now enter the world.
test('every polygon part in the catalogue is convex, and every part lies inside its footprint', () => {
  for (const [name, template] of catalogue) {
    for (const [i, part] of template.parts.entries()) {
      if (part.part !== 'obstacle') continue;
      if (part.shape.kind === 'polygon') assert.ok(convex(part.shape.points), `${name} part ${i} is not convex`);
      const box = bounds(part.shape);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= template.w && box.y + box.h <= template.h,
        `${name} part ${i} spills outside the ${template.w}x${template.h} footprint the placer reserves for it`);
      // `clearFootprint` and the block-corner arithmetic read an obstacle's raw x/y/w/h as a box, so
      // a part whose record is not its own bounds is placed correctly and then tested against the
      // wrong rectangle. A circle part fails here on purpose: `shapeOf` reads a circle's x/y as its
      // centre, so its record cannot also be its top-left box until that convention is revisited.
      const record = fieldsOf(part.shape);
      assert.deepEqual({ x: record.x, y: record.y, w: record.w, h: record.h }, box,
        `${name} part ${i}: the record written for this shape is not its own bounds`);
    }
  }
});
