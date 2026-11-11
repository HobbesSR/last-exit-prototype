import test from 'node:test';
import assert from 'node:assert/strict';
import { regionalLightingFields } from '../map/micro/lighting.ts';
import { stampBuiltMap } from '../map/micro/adapter.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { HUT } from './helpers/hut-template.js';
import { shapeOf } from '../shared/shape.ts';
import { getCanonicalFields, resolveGroundAppearance, sampleSpatialLight } from '../public/appearance.js';

const cell = (x, y) => ({ x, y });

function region(id, seed, type, cells, extra = {}) {
  return {
    version: 'region-2',
    brief: { id, seed, type, cellSize: 100, cells, zones: [], portals: [], ...extra },
    elements: [], coreElements: [], loot: [], manifest: { cells: cells.length },
  };
}

function fixture(seedOffset = 0) {
  const regions = [];
  const types = ['market', 'park', 'depot', 'plant', 'ruins', 'transit', 'landmark', 'compound', 'rubble', 'arrival', 'checkpoint', 'hut'];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
    const index = y * 4 + x;
    if (x === 1 && y === 0) continue;
    const cells = x === 0 && y === 0 ? [cell(0, 0), cell(1, 0)] : [cell(x, y)];
    const extra = types[index] === 'landmark' ? { coreElements: { exit: 1 } } : {};
    const built = region(`region-${String(index).padStart(2, '0')}`, index + 11 + seedOffset, types[index], cells, extra);
    if (index === 0) {
      built.elements.push({ label: 'test-hut', x: 12000, y: 6000, template: HUT });
      built.loot.push({ x: 12125, y: 6125, tier: 1 });
    }
    regions.push(built);
  }
  return { cellSize: 100, regions, pairs: [] };
}

const origin = { x: 200, y: 300 };

test('regional fields are deterministic across region and cell traversal order, translate with origin, and do not mutate inputs', () => {
  const map = fixture();
  const before = structuredClone(map);
  const original = regionalLightingFields(map, origin);
  const reordered = structuredClone(map);
  reordered.regions.reverse();
  for (const item of reordered.regions) item.brief.cells.reverse();
  assert.deepEqual(regionalLightingFields(reordered, origin), original);
  assert.deepEqual(map, before, 'field generation leaves built regions untouched');

  const shifted = regionalLightingFields(map, { x: origin.x + 725, y: origin.y - 140 });
  assert.equal(shifted.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(shifted[i].bounds.x, original[i].bounds.x + 725);
    assert.equal(shifted[i].bounds.y, original[i].bounds.y - 140);
    assert.equal(shifted[i].bounds.w, original[i].bounds.w);
    assert.equal(shifted[i].bounds.h, original[i].bounds.h);
  }
  const focal = original.find(field => field.focalEdge);
  const shiftedFocal = shifted.find(field => field.id === focal.id);
  assert.ok(focal, 'landmark/core region creates a focal edge');
  assert.deepEqual(shiftedFocal.focalEdge, {
    ...focal.focalEdge,
    x: focal.focalEdge.x + 725,
    y: focal.focalEdge.y - 140,
  }, 'focal edge translates with its field bounds');

  const negative = structuredClone(map);
  for (const item of negative.regions) for (const c of item.brief.cells) { c.x -= 5; c.y -= 2; }
  assert.deepEqual(regionalLightingFields(negative, { x: origin.x + 500, y: origin.y + 200 }), original,
    'negative contract cells translate correctly into the same world bounds');
});

test('regional field count is bounded by six and appearance variation uses region identity seeds', () => {
  const map = fixture();
  const fields = regionalLightingFields(map, origin);
  assert.ok(fields.length <= 6);
  assert.ok(fields.length > 1);
  const otherSeededAppearance = regionalLightingFields(fixture(1), origin);
  assert.notDeepEqual(otherSeededAppearance, fields, 'changing region seeds changes the named presentation recipe');
});

test('stampBuiltMap emits fields by default without changing geometry, RNG draws, or IDs', () => {
  const map = fixture();
  const disabled = createGenerationContext(7462);
  const defaulted = createGenerationContext(7462);
  const enabled = createGenerationContext(7462);
  const authored = { id: 'authored-light', bounds: { x: 3, y: 4, w: 5, h: 6 }, tint: 'sodiumAmber' };
  disabled.map.appearance = { surfaces: [], lighting: { fields: [authored] } };
  defaulted.map.appearance = structuredClone(disabled.map.appearance);
  enabled.map.appearance = structuredClone(disabled.map.appearance);

  // Empty ownership suppresses lighting, while retaining identical elements and loot.
  const unowned = structuredClone(map);
  for (const region of unowned.regions) region.brief.cells = [];
  stampBuiltMap(disabled, unowned, origin);
  stampBuiltMap(defaulted, map, origin);
  stampBuiltMap(enabled, map, origin);
  assert.deepEqual(enabled.map, defaulted.map, 'ordinary emission consistently includes regional fields');
  const enabledWithoutFields = structuredClone(enabled.map);
  enabledWithoutFields.appearance.lighting.fields = enabledWithoutFields.appearance.lighting.fields.slice(0, 1);
  assert.deepEqual(enabledWithoutFields, disabled.map, 'ownership-derived appearance adds only lighting fields');
  assert.deepEqual(enabled.map.appearance.lighting.fields[0], authored, 'existing authored fields stay first');
  assert.deepEqual(enabled.map.appearance.lighting.fields.slice(1), regionalLightingFields(map, origin), 'generated fields append to authored fields');
  assert.deepEqual(enabled.map.obstacles.map(shapeOf), disabled.map.obstacles.map(shapeOf));
  assert.deepEqual(enabled.map.buildings, disabled.map.buildings);
  assert.deepEqual(enabled.map.gates, disabled.map.gates);
  assert.deepEqual(enabled.spots, disabled.spots);
  const disabledSequence = [disabled.random(), disabled.nextId('probe-'), disabled.nextId('next-')];
  const defaultSequence = [defaulted.random(), defaulted.nextId('probe-'), defaulted.nextId('next-')];
  const enabledSequence = [enabled.random(), enabled.nextId('probe-'), enabled.nextId('next-')];
  assert.deepEqual(disabledSequence, enabledSequence);
  assert.deepEqual(defaultSequence, enabledSequence);
  assert.ok(enabled.map.obstacles.length > 0 && enabled.map.buildings.length > 0 && enabled.map.gates.length > 0);
  assert.equal(enabled.spots.length, 1);
  assert.ok(enabled.map.appearance.lighting.fields.length > 0);
});

test('generated regional fields resolve through lighting samples and spatial ground splitting', () => {
  const fields = regionalLightingFields(fixture(), origin);
  const left = sampleSpatialLight(fields, origin.x + 50, origin.y + 50, { lighting: true });
  const right = sampleSpatialLight(fields, origin.x + 350, origin.y + 50, { lighting: true });
  assert.ok(left.weight > 0);
  assert.ok(right.weight > 0);

  const boundary = sampleSpatialLight(fields, origin.x + 400 / 3, origin.y + 75, { lighting: true });
  const reversed = sampleSpatialLight([...fields].reverse(), origin.x + 400 / 3, origin.y + 75, { lighting: true });
  assert.deepEqual(boundary, reversed, 'canonical field order makes generated blend independent of array order');
  assert.ok(boundary.contributions.length > 1, 'sample blends overlapping generated regional fields');
  assert.ok(boundary.weight <= 0.65);
  assert.equal(Number((boundary.weight + boundary.neutral).toFixed(6)), 1);

  const appearance = {
    surfaces: [{ id: 'district-crossing', bounds: { x: origin.x, y: origin.y + 20, w: 400, h: 40 }, material: 'coolConcrete', segmentSpan: 100 }],
    lighting: { fields },
  };
  const lit = resolveGroundAppearance(appearance, { lighting: true });
  const fills = lit.find(item => item.id === 'district-crossing').ops.filter(op => op.op === 'fillRect');
  assert.equal(fills.length, 4);
  assert.ok(new Set(fills.map(op => op.color)).size > 1, 'segments receive their local generated field color');

  const unlit = resolveGroundAppearance(appearance, { lighting: false });
  const unlitFills = unlit.find(item => item.id === 'district-crossing').ops.filter(op => op.op === 'fillRect');
  assert.equal(unlitFills.length, 1);
});

test('canonical cache is keyed by array identity and a fresh array sees changed fields', () => {
  const fields = regionalLightingFields(fixture(), origin);
  const cached = getCanonicalFields(fields);
  assert.equal(getCanonicalFields(fields), cached);
  const changed = [...fields, { id: 'extra-field', bounds: { x: 0, y: 0, w: 1, h: 1 } }];
  const fresh = getCanonicalFields(changed);
  assert.notEqual(fresh, cached);
  assert.equal(fresh.length, cached.length + 1);
  assert.equal(getCanonicalFields(fields).length, cached.length, 'the original immutable array keeps its own cached view');
});
