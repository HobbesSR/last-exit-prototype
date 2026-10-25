import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuilderCanvas } from '../map/micro/sdk.ts';
import { rect, circle } from '../shared/shape.ts';

const cells = Array.from({ length: 24 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6) }));
const brief = (extra = {}) => ({ id: 'canvas', seed: 1, type: 'cover', cellSize: 40, cells,
  zones: [{ tier: 1, bonus: 0, lootChance: 0, cells }], portals: [], ...extra });
const piece = (x, y, label = 'piece') => ({ label, x, y,
  template: { w: 40, h: 40, parts: [{ part: 'obstacle', kind: 'crate', shape: rect(5, 5, 30, 30) }] } });

test('an assembly records intent and elements together, in supplied order, owning its inputs', () => {
  const canvas = createBuilderCanvas(brief());
  const elements = [piece(0, 0, 'first'), piece(40, 0, 'second')];
  const areas = [rect(0, 0, 80, 40)];
  assert.equal(canvas.commit({ elements, areas }), true);
  elements[0].template.parts.length = 0;
  areas[0].w = 200;
  assert.deepEqual(canvas.elements.map(e => e.label), ['first', 'second']);
  assert.equal(canvas.elements[0].template.parts.length, 1);
  assert.equal(canvas.addressed.areas[0].w, 80);
  assert.equal(canvas.addressed.unaddressed().length, 22);
});

test('late assembly failures leave no geometry or partial addressed marks', () => {
  const canvas = createBuilderCanvas(brief());
  assert.equal(canvas.markEmpty([rect(80, 0, 40, 40)]), true);
  const before = structuredClone(canvas.addressed.areas);
  assert.equal(canvas.commit({ elements: [piece(0, 0), piece(80, 0)] }), false);
  assert.equal(canvas.commit({ elements: [piece(0, 0)], areas: [rect(0, 0, 40, 40), rect(20, 0, 40, 40)] }), false);
  assert.equal(canvas.commit({ elements: [piece(0, 0), piece(240, 0)] }), false);
  assert.deepEqual(canvas.elements, []);
  assert.deepEqual(canvas.addressed.areas, before);
  assert.equal(canvas.addressed.addressed(0, 0), false);
  assert.equal(canvas.commit({ elements: [piece(0, 0)] }), true);
});

test('collider intent can share cells, but cannot hide a collision with an earlier assembly', () => {
  const canvas = createBuilderCanvas(brief());
  assert.equal(canvas.commit({ elements: [piece(0, 0)], areas: [circle(10, 10, 3)] }), true);
  assert.equal(canvas.commit({ elements: [piece(0, 0)], areas: [circle(30, 30, 3)] }), false);
  assert.equal(canvas.elements.length, 1);
  assert.equal(canvas.markEmpty([rect(40, 0, 40, 40)]), true);
});

test('fill, protected geometry and access are separate constraints', () => {
  const canvas = createBuilderCanvas(brief({ fillCells: cells.filter(c => c.x < 5), clearCells: [{ x: 5, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }, { x: 6, y: 0 }] }),
    [rect(80, 0, 40, 40)]);
  assert.equal(canvas.commit({ elements: [piece(200, 0)] }), false, 'original ownership outside fill is unavailable');
  assert.equal(canvas.commit({ elements: [piece(80, 0)] }), false, 'protected route stays empty');
  assert.equal(canvas.markEmpty([rect(80, 0, 40, 40)]), true, 'empty intent can address a route');
  assert.equal(canvas.commit({ elements: [piece(0, 0)], access: [rect(240, 0, 40, 40)] }), true, 'known-clear access may extend beyond ownership');
  assert.equal(canvas.commit({ elements: [piece(40, 0)], access: [rect(280, 0, 40, 40)] }), false);
});

test('a roof and intent may cover a protected route; only what stands is kept off it', () => {
  const canvas = createBuilderCanvas(brief(), [rect(40, 40, 40, 40)]);
  // A roofed shell over the route whose only collider stands beside it.
  const shell = { label: 'shell', x: 0, y: 0, template: { w: 120, h: 120, encloses: true,
    roofs: [{ cells: [{ x: 0, y: 0 }, { x: 1, y: 1 }], cellSize: 40 }],
    parts: [{ part: 'obstacle', kind: 'building', shape: rect(5, 5, 30, 30) }] } };
  assert.equal(canvas.commit({ elements: [shell] }), true, 'roof, footprint and intent cross the route');
  const blocked = createBuilderCanvas(brief(), [rect(40, 40, 40, 40)]);
  assert.equal(blocked.commit({ elements: [piece(40, 40)], areas: [rect(160, 0, 40, 40)] }), false, 'a collider on the route is refused');
});

test('access reservations reject blocked standing room and protect later commits', () => {
  const canvas = createBuilderCanvas(brief());
  assert.equal(canvas.commit({ elements: [piece(0, 0)], access: [rect(5, 5, 20, 20)] }), false);
  assert.equal(canvas.commit({ elements: [piece(0, 0)], access: [rect(40, 0, 40, 40)] }), true);
  assert.equal(canvas.commit({ elements: [piece(40, 0)] }), false);
  assert.equal(canvas.commit({ elements: [piece(80, 0)], access: [rect(5, 5, 20, 20)] }), false);
  assert.equal(canvas.elements.length, 1);
});

test('template reservations protect later pieces and every assembly component must fit', () => {
  for (const change of [
    e => { e.template.parts.push({ part: 'reserve', x: 240, y: 0, w: 40, h: 40 }); },
    e => { e.template.parts.push({ part: 'spot', x: 260, y: 20 }); },
    e => { e.template.encloses = true; e.template.w = 280; },
    e => { e.template.roofs = [{ cells: [{ x: 6, y: 0 }], cellSize: 40 }]; },
    e => { e.template.parts.push({ part: 'gate', x: 260, y: 20, w: 30, h: 30 }); },
  ]) {
    const canvas = createBuilderCanvas(brief()), element = piece(0, 0);
    change(element);
    assert.equal(canvas.commit({ elements: [element], areas: [circle(20, 20, 5)] }), false);
    assert.equal(canvas.elements.length, 0);
    assert.equal(canvas.addressed.areas.length, 0);
  }
  const canvas = createBuilderCanvas(brief()), element = piece(0, 0);
  element.template.parts.push({ part: 'reserve', x: 40, y: 0, w: 40, h: 40 });
  assert.equal(canvas.commit({ elements: [element] }), true);
  assert.equal(canvas.commit({ elements: [piece(40, 0)] }), false);
});

test('an owned bounding box cannot hide geometry bridging a hole', () => {
  const canvas = createBuilderCanvas(brief({ cells: cells.filter(c => c.x !== 1 || c.y !== 1) }));
  const element = piece(0, 0);
  element.template.parts[0].shape = rect(20, 20, 80, 80);
  assert.equal(canvas.commit({ elements: [element], areas: [rect(0, 0, 40, 40)] }), false);
  assert.equal(canvas.addressed.areas.length, 0);
});

test('batch parts may overlap, and a refused batch never retains its access reservations', () => {
  const canvas = createBuilderCanvas(brief());
  assert.equal(canvas.commit({ elements: [piece(0, 0), piece(10, 0)], areas: [rect(0, 0, 50, 40)] }), true);
  assert.equal(canvas.commit({ elements: [piece(0, 0)], access: [rect(80, 0, 40, 40)] }), false);
  assert.equal(canvas.commit({ elements: [piece(80, 0)] }), true);
  assert.equal(canvas.elements.length, 3);
});

test('fits reads the fill and every protection, committed access included', () => {
  const canvas = createBuilderCanvas(brief({ fillCells: cells.filter(c => c.x < 5) }), [rect(80, 0, 40, 40)]);
  assert.equal(canvas.fits(rect(0, 0, 40, 40)), true);
  assert.equal(canvas.fits(rect(200, 0, 40, 40)), false, 'outside the reduced fill');
  assert.equal(canvas.fits(rect(60, 0, 40, 40)), false, 'on a supplied protection');
  assert.equal(canvas.commit({ elements: [piece(0, 0)], access: [rect(0, 80, 40, 40)] }), true);
  assert.equal(canvas.fits(rect(0, 80, 40, 40)), false, 'on committed access');
  assert.equal(canvas.fits(rect(0, 0, 40, 40)), true, 'committed geometry is spacing, not a protection');
});

test('spaced keeps a clearance from committed extents, never from addressed intent', () => {
  const canvas = createBuilderCanvas(brief());
  assert.equal(canvas.markEmpty([rect(160, 0, 40, 40)]), true);
  assert.equal(canvas.spaced(rect(160, 0, 40, 40), 40), true, 'empty intent is not an extent');
  assert.equal(canvas.commit({ elements: [piece(0, 0)] }), true);
  assert.equal(canvas.spaced(rect(40, 0, 40, 40)), true, 'touching a template box is not overlap');
  assert.equal(canvas.spaced(rect(40, 0, 40, 40), 40), false);
  assert.equal(canvas.spaced(rect(80, 0, 40, 40), 40), true, 'a clearance-wide gap is enough');
  assert.equal(canvas.spaced(rect(20, 0, 40, 40)), false);
  // A world-absolute record names its extent; its template box spans the region.
  const record = { label: 'wall', x: 0, y: 0, template: { w: 240, h: 160, parts: [{ part: 'obstacle', kind: 'ruin-wall', shape: rect(200, 120, 40, 40) }] } };
  assert.equal(canvas.commit({ elements: [record], areas: [rect(200, 120, 40, 40)], extents: [rect(200, 120, 40, 40)] }), true);
  assert.equal(canvas.spaced(rect(120, 80, 40, 40)), true);
  assert.equal(canvas.spaced(rect(120, 80, 40, 40), 50), false);
  assert.equal(canvas.commit({ elements: [piece(400, 0)], extents: [rect(80, 120, 40, 40)] }), false);
  assert.equal(canvas.spaced(rect(80, 120, 40, 40)), true, 'a refused commit records no extent');
});
