import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMicroRegion, validateMicroRegion } from '../shared/map/micro/index.ts';
import { microExample } from '../shared/map/micro/examples.ts';
import { createRegionMask, capsule, travelClear } from '../shared/map/micro/geometry.ts';
import { regionCollisionMap, stampMicroRegion } from '../shared/map/micro/adapter.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { circle, polygon, rect } from '../shared/shape.ts';
import { canOccupy, movePlayer } from '../shared/movement.ts';

test('containment checks whole convex bodies against holes, not only their corners', () => {
  const spec = microExample(); spec.cells = spec.cells.filter(c => c.x !== 10 || c.y !== 8);
  const mask = createRegionMask(spec);
  // Corners are outside the missing cell, but the body spans it.
  assert.equal(mask.contains(rect(390, 310, 60, 60)), false);
  assert.equal(mask.contains(polygon(390, 310, [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }])), false);
  assert.equal(mask.contains(circle(420, 300, 10)), true);
  assert.equal(mask.contains(rect(-1, 0, 40, 40)), false);
});

test('swept routes cannot tunnel through a thin diagonal obstacle', () => {
  const mask = createRegionMask(microExample());
  const a = { x: 100, y: 100 }, b = { x: 200, y: 100 };
  const thin = polygon(150, 90, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 7, y: 20 }, { x: 5, y: 20 }]);
  assert.equal(travelClear(mask, [thin], a, a, 12), true);
  assert.equal(travelClear(mask, [thin], b, b, 12), true);
  assert.equal(travelClear(mask, [thin], a, b, 12), false);
  assert.equal(capsule(a, a, 12).length, 1);
});

test('explicit squeeze passes the contestant and blocks the actual hunter in game collision', () => {
  const spec = microExample('ruins', 19);
  spec.ports.push({ id: 'squeeze', side: 'N', start: { x: 10, y: 0 }, length: 2, required: 'contestant', allowed: 'contestant' });
  const result = generateMicroRegion(spec), map = regionCollisionMap(result), port = result.ports.find(p => p.id === 'squeeze');
  const x = 12000 + port.centre.x, y = 6000 + port.centre.y + 4;
  assert.equal(canOccupy(map, x, y, 12), true);
  assert.equal(canOccupy(map, x, y, 23), false);
  const actor = { role: 'contestant', x, y: y + 35, status: 'active', boost: 0, stun: 0 };
  for (let i = 0; i < 10; i++) movePlayer(map, actor, { y: -1 });
  assert.ok(actor.y < 6000, 'real movement crosses the opening');
});

test('region edges are not automatically walls and no-port regions are supported', () => {
  const spec = microExample('ruins', 20); spec.ports = []; spec.loot = { budget: 0, tier: 1 };
  const result = generateMicroRegion(spec);
  assert.equal(result.ports.length, 0);
  assert.ok(result.elements.every(e => !e.label.startsWith('port:')));
  assert.deepEqual(result.loot, []);
  assert.deepEqual(validateMicroRegion(result), []);
});

test('impossible floors and mismatched region ownership fail before emitting an artifact', () => {
  for (const mutate of [
    s => { s.ports[0].allowed = 'contestant'; },
    s => { s.ports[0].start.x = 1; },
    s => { s.ports.push(structuredClone(s.ports[0])); },
    s => { s.cells.push(s.cells[0]); },
    s => { s.cells = s.cells.filter(c => c.x !== 12); },
    s => { s.parameters.density = NaN; },
  ]) { const spec = microExample(); mutate(spec); assert.throws(() => generateMicroRegion(spec)); }
  // A contiguous one-cell neck does not admit a hunter, despite a connected cell graph.
  const narrow = microExample();
  narrow.cells = narrow.cells.filter(c => c.x < 10 || c.x > 13 || c.y === 8);
  assert.throws(() => generateMicroRegion(narrow), /cannot connect/);
});

test('artifact validation detects sealed routes, missing boundary geometry and invalid bodies independently', () => {
  const original = generateMicroRegion(microExample('depot', 123));
  const cut = structuredClone(original);
  cut.elements.push({ label: 'illegal partition', x: 0, y: 0, template: { w: 960, h: 720, parts: [{ part: 'obstacle', shape: rect(475, 0, 10, 720), kind: 'building' }] } });
  assert.ok(validateMicroRegion(cut).some(e => /disconnected/.test(e)));
  const missing = structuredClone(original); missing.elements.shift();
  assert.ok(validateMicroRegion(missing).some(e => /Boundary contract/.test(e)));
  const invalid = structuredClone(original);
  invalid.elements.push({ label: 'bad body', x: 0, y: 0, template: { w: 10, h: 10, parts: [{ part: 'obstacle', shape: rect(20, 20, -5, 10), kind: 'crate' }] } });
  assert.ok(validateMicroRegion(invalid).some(e => /valid convex shape/.test(e)));
});

test('macro reservations remain empty and stamping preserves roofs, unlocked doors and budgeted loot', () => {
  const spec = microExample('courtyard', 911);
  spec.reservations = [{ x: 400, y: 400, w: 160, h: 160 }];
  const result = generateMicroRegion(spec), context = createGenerationContext(911);
  stampMicroRegion(context, result, { x: 12000, y: 6000 }, 'micro-test');
  assert.ok(context.map.buildings.length > 0);
  assert.equal(context.map.gates.length, result.manifest.gates);
  assert.ok(context.map.gates.every(g => !g.locked && g.buildingId));
  assert.equal(context.spots.length, result.loot.length);
  assert.ok(context.map.obstacles.every(o => Number.isFinite(o.x) && Number.isFinite(o.w)));
  const invalid = structuredClone(result); invalid.loot.push({ x: 480, y: 480, tier: 1 });
  const before = structuredClone(context.map);
  assert.throws(() => stampMicroRegion(context, invalid, { x: 12000, y: 6000 }, 'bad'));
  assert.deepEqual(context.map, before, 'invalid region stamping is atomic');
});
