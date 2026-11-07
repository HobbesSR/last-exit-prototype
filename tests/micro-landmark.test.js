import test from 'node:test';
import assert from 'node:assert/strict';
import { LANDMARK_KINDS, LANDMARK_SITE } from '../map/micro/placeables/landmark-site.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { regionExample } from '../map/micro/region-examples.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { createGenerationContext } from '../shared/map/context.ts';
import { placeElement } from '../shared/map/element.ts';
import { shapeOf } from '../shared/shape.ts';

const SIZE = 40;

/** A landmark's roof cells, laid out from its envelope origin, as the silhouette a map draws. */
function silhouette(kind) {
  const placed = LANDMARK_SITE.build({ kind, seed: 1 }, SIZE);
  assert.ok(!('refused' in placed), `${kind} builds`);
  const [element] = placed.elements;
  const [roof] = element.template.roofs ?? [];
  assert.ok(roof, `${kind} declares a roof`);
  const width = element.template.w / SIZE, height = element.template.h / SIZE;
  return { width, height, cells: new Set(roof.cells.map(c => `${c.x},${c.y}`)), count: roof.cells.length };
}

test('each landmark silhouette is a distinct non-rectangular roof contour, not a colour', () => {
  const shapes = Object.fromEntries(LANDMARK_KINDS.map(kind => [kind, silhouette(kind)]));
  // An L-plan kiosk: 6 × 4 over a 3 × 3 bay.
  assert.deepEqual([shapes['gas-station'].width, shapes['gas-station'].height], [6, 7]);
  assert.equal(shapes['gas-station'].count, 33);
  assert.equal(shapes['gas-station'].cells.size, 33);
  // A comb-plan deck: an 11 × 3 span over three 3 × 3 bays, the gaps between them open ground.
  assert.deepEqual([shapes['collapsed-parking'].width, shapes['collapsed-parking'].height], [11, 6]);
  assert.equal(shapes['collapsed-parking'].count, 60);
  assert.ok(!shapes['collapsed-parking'].cells.has('3,3'), 'the first gap is not roofed');
  assert.ok(!shapes['collapsed-parking'].cells.has('7,3'), 'the second gap is not roofed');
  // A notched plan: 10 × 6 with its south-west 2 × 2 corner missing.
  assert.deepEqual([shapes['ruined-restaurant'].width, shapes['ruined-restaurant'].height], [10, 6]);
  assert.equal(shapes['ruined-restaurant'].count, 56);
  assert.ok(!shapes['ruined-restaurant'].cells.has('0,5'), 'the missing corner is not roofed');
  // Every roof is smaller than its bounding box, and no two are the same set.
  for (const shape of Object.values(shapes)) assert.ok(shape.count < shape.width * shape.height, 'a non-rectangular contour');
  const signatures = Object.values(shapes).map(shape => `${shape.width}x${shape.height}:${[...shape.cells].sort().join('|')}`);
  assert.equal(new Set(signatures).size, LANDMARK_KINDS.length);
});

test('a landmark region keeps the portal promise, and a hunter reaches every door in it', () => {
  const { clearance } = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' });
  for (const kind of LANDMARK_KINDS) {
    const brief = { ...regionExample({ type: 'landmark', northPortal: true }), parameters: { kind } };
    const result = buildRegion(brief);
    assert.ok(result.elements.length, `${kind} places geometry`);
    assert.equal(result.manifest.landmarks, 1, kind);
    const blockers = result.elements.flatMap(element => elementShapes(element));
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers }, { search: 'thorough' }).errors, [], kind);
    const gates = result.elements.flatMap(element => element.template.parts
      .filter(part => part.part === 'gate')
      .map(part => ({ x: element.x + part.x, y: element.y + part.y })));
    assert.ok(gates.length >= 1, `${kind} has an outside door`);
    const mask = createAccessMask(result.brief), root = portalStands(result.brief)[0].points[0];
    for (const gate of gates) assert.ok(findRegionRoute(mask, blockers, root, gate, clearance.contestant),
      `${kind} door is reachable from a portal`);
  }
});

test('a landmark is collision and sight geometry first, appearance second', () => {
  const geometry = map => JSON.stringify({
    obstacles: map.obstacles.map(obstacle => ({ kind: obstacle.kind, shape: shapeOf(obstacle) })).sort(),
    gates: map.gates.map(gate => [gate.x, gate.y, gate.w, gate.h]).sort(),
    roofs: map.roofs.map(roof => ({ bounds: roof.bounds, cells: roof.cells })).sort(),
  });
  for (const kind of LANDMARK_KINDS) {
    const mapped = appearance => {
      const context = createGenerationContext(7);
      const placed = LANDMARK_SITE.build({ kind, seed: 3, ...(appearance ? { appearance } : {}) }, SIZE);
      for (const element of placed.elements) placeElement(context, element.template, element.x, element.y, { nodeId: 'landmark', locked: false });
      return context.map;
    };
    const plain = mapped(undefined), authored = mapped(true);
    assert.equal(geometry(plain), geometry(authored), `${kind} appearance never moves geometry`);
    assert.ok(authored.roofs.every(roof => roof.appearance), `${kind} roofs carry their appearance`);
  }
});

test('the block district generates landmark lots from a seeded plan', () => {
  const cells = [];
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) cells.push({ x, y });
  const brief = { id: 'block-landmarks', seed: 1, type: 'block', cellSize: SIZE, cells,
    zones: [{ tier: 2, bonus: 0, lootChance: 0.04, cells }],
    portals: [{ id: 'west', axis: 'v', x: 0, y: 12, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 12, length: 3 }] };
  const plan = planBlock(brief);
  assert.ok(plan.lots.some(lot => lot.type === 'landmark'), 'a landmark lot is planned');
  const built = buildRegion(brief), labels = built.elements.map(element => element.label);
  assert.ok(labels.some(label => label.includes('landmark-')), `a generated block places a landmark: ${labels.join(', ')}`);
  assert.deepEqual(validatePortalReach({ ...built.brief, blockers: built.elements.flatMap(element => elementShapes(element)) },
    { search: 'thorough' }).errors, []);
  // A block that switches landmarks off is the previous content.
  assert.ok(!buildRegion({ ...brief, parameters: { landmarks: false } }).elements.some(element => element.label.includes('landmark-')));
});

test('a landmark brief names its kind, and refuses an unknown one', () => {
  const brief = regionExample({ type: 'landmark' });
  assert.throws(() => buildRegion({ ...brief, parameters: { kind: 'gasworks' } }), /Landmark kind must be one of/);
  for (const kind of LANDMARK_KINDS) assert.ok(buildRegion({ ...brief, parameters: { kind } }).elements.length, kind);
});
