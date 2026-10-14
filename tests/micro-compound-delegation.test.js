import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildCompound, buildCompoundGeneration, COMPOUND_EXECUTION_REGISTRY } from '../map/micro/strategies/compound.ts';
import { executionLeaves, flattenDelegationResult } from '../map/micro/delegation-execute.ts';
import { buildBlock, planBlock } from '../map/micro/strategies/block.ts';
import { prepareDelegation, validateBriefPartition } from '../map/micro/delegation.ts';
import { saveDelegationSnapshot, readDelegationSnapshot, delegationSnapshotResult } from '../map/micro/delegation-snapshot.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { measurement } from '../map/macro/src/chain/measurement.ts';
import { liveMapFromBuilt } from '../map/live.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, n) =>
  ({ x: n % w, y: Math.floor(n / w) })).filter(cell => keep(cell.x, cell.y));
const brief = (id, cells, portals, extra = {}) => ({ id, seed: 1, type: 'compound', cellSize: SIZE, cells,
  zones: [{ tier: 1, bonus: 0, lootChance: 0.3, cells }], portals, ...extra });
const concave = () => brief('compound-concave', cellsOf(40, 34, (x, y) => y < 20 || x < 20), [
  { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
  { id: 'east', axis: 'v', x: 40, y: 8, length: 2 },
]);
const blockers = region => region.elements.flatMap(element => elementShapes(element));
const placed = region => region.elements.flatMap(element => elementShapes(element, true));
const roundTrip = value => JSON.parse(JSON.stringify(value));
const ring = region => region.elements.filter(element => /^compound-(room|gate)/.test(element.label));
const ringBox = elements => {
  const boxes = elements.map(element => ({ x: element.x / SIZE, y: element.y / SIZE,
    w: element.template.w / SIZE, h: element.template.h / SIZE }));
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, w: Math.max(...boxes.map(box => box.x + box.w)) - x,
    h: Math.max(...boxes.map(box => box.y + box.h)) - y };
};
const gateYardStand = (element, box) => {
  const side = element.label.at(-1);
  const point = { x: element.x + element.template.w / 2, y: element.y + element.template.h / 2 };
  if (side === 'N') point.y = (box.y - 1) * SIZE;
  if (side === 'S') point.y = (box.y + box.h + 1) * SIZE;
  if (side === 'W') point.x = (box.x - 1) * SIZE;
  if (side === 'E') point.x = (box.x + box.w + 1) * SIZE;
  return point;
};

test('concave compound offers exterior cover while preserving its ring and actual hunter access', () => {
  const original = concave(), node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.ok(node.offers?.some(offer => offer.reasonTags?.includes('unused-exterior-yard')));
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover' && child.retained.elements.length > 0),
    'cover visibly occupies an accepted exterior patch');
  assert.equal(createHash('sha256').update(JSON.stringify(ring(node.retained))).digest('hex'),
    '42cc68d57dac7f163a5495f1e7f1445bb3c824a76762ec957d83b8780e929bd4',
    'the original 17-piece ring stays fixed');
  assert.deepEqual(ring(flat), ring(node.retained));
  assert.deepEqual(node.retained.brief.portals.filter(portal => original.portals.some(p => p.id === portal.id))
    .sort((a, b) => a.id.localeCompare(b.id)), [...original.portals].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assert.deepEqual(validateFillConstraints(flat.brief, placed(flat)), []);
  assert.deepEqual(validatePortalReach({ ...flat.brief, blockers: blockers(flat) }).errors, []);
  const finalBlockers = blockers(flat);
  for (const leaf of executionLeaves(node)) {
    assert.deepEqual(validateFillConstraints(leaf.brief, placed(leaf)), [], leaf.brief.id);
    assert.deepEqual(validatePortalReach({ ...leaf.brief, blockers: finalBlockers }).errors, [], leaf.brief.id);
  }
  for (const crossing of node.preparation.crossings)
    assert.equal(executionLeaves(node).filter(leaf => leaf.brief.portals.some(portal => portal.id === crossing.portal.id)).length, 2);

  const access = createAccessMask(flat.brief), radius = hunterClearance(SIZE);
  const start = portalStands(flat.brief)[0].points[0], box = ringBox(ring(flat));
  const targets = [
    ...ring(flat).filter(element => element.label.startsWith('compound-room')).map(element => ({
      label: element.label, point: { x: element.x + element.template.w / 2, y: element.y + element.template.h / 2 } })),
    { label: 'court', point: { x: (box.x + box.w / 2) * SIZE, y: (box.y + box.h / 2) * SIZE } },
    ...ring(flat).filter(element => element.label.startsWith('compound-gate')).map(element => ({
      label: `${element.label} yard stand`, point: gateYardStand(element, box) })),
    ...portalStands(flat.brief).flatMap(({ portal, points }) => points.map(point => ({ label: portal.id, point }))),
  ];
  for (const target of targets)
    assert.ok(findRegionRoute(access, finalBlockers, start, target.point, radius), `hunter reaches ${target.label}`);
  const adapter = buildCompound(original);
  assert.deepEqual(adapter.brief, original);
  assert.deepEqual(adapter.elements, flat.elements);
  assert.deepEqual(adapter.loot, flat.loot);
  assert.equal(adapter.manifest.rooms, node.retained.manifest.rooms);
  assert.equal(adapter.manifest.compoundGates, node.retained.manifest.compoundGates);
});

test('small compounds retain sensible rings without giving away their court or approaches', () => {
  for (const [w, h] of [[17, 16], [24, 18]]) {
    const cells = cellsOf(w, h), original = brief(`compound-${w}x${h}`, cells, [
      { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
      { id: 'east', axis: 'v', x: w, y: 8, length: 2 },
    ]);
    const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
    assert.equal(node.actualBuilder, 'compound');
    assert.ok(ring(node.retained).length >= 6);
    assert.equal(node.retained.manifest.compoundGates, 2);
    assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
    assert.deepEqual(validatePortalReach({ ...flat.brief, blockers: blockers(flat) }).errors, []);
  }
});

test('concave seed 18 reaches the actual center of every chosen gate', () => {
  const original = { ...concave(), seed: 18 };
  const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  const access = createAccessMask(flat.brief), finalBlockers = blockers(flat), radius = hunterClearance(SIZE);
  const start = portalStands(flat.brief)[0].points[0], box = ringBox(ring(flat));
  const gates = ring(flat).filter(element => element.label.startsWith('compound-gate'));
  assert.equal(gates.length, 2);
  for (const gate of gates)
    assert.ok(findRegionRoute(access, finalBlockers, start, gateYardStand(gate, box), radius),
      `hunter reaches the actual center outside ${gate.label}`);
  assert.deepEqual(validatePortalReach({ ...flat.brief, blockers: finalBlockers }).errors, []);
});

test('inherited nonfill strip rejects the authored 12 by 6 compound exterior offer', () => {
  // compound@252,36 of generate('issue330-before-12x6'), stored because later content moves it (fixtures README).
  const original = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/compound-330-strip-brief.json.gz', import.meta.url))));
  const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.ok(node.offers?.length, 'the exterior patch remains a candidate');
  assert.equal(node.children?.length ?? 0, 0, 'the conflicting patch stays retained');
  assert.ok(node.preparation.rejected.some(({ reason }) => reason.includes('No compatible hunter crossing')));
  assert.equal(node.retained.brief.cells.length, original.cells.length);
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assert.deepEqual(validateFillConstraints(flat.brief, placed(flat)), []);
  assert.deepEqual(validatePortalReach({ ...flat.brief, blockers: blockers(flat) }).errors, []);
  for (const leaf of executionLeaves(node))
    assert.deepEqual(validatePortalReach({ ...leaf.brief, blockers: blockers(flat) }).errors, [], leaf.brief.id);
});

test('split fill excludes exterior patches that cannot contain cover', () => {
  const original = concave();
  original.fillCells = original.cells.filter(cell => cell.x >= 3 && cell.x < 25 && cell.y >= 2 && cell.y < 20);
  const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.actualBuilder, 'compound');
  assert.equal(node.offers?.length ?? 0, 0);
  assert.equal(node.children?.length ?? 0, 0);
  assert.equal(node.retained.brief.cells.length, original.cells.length);
  assert.deepEqual(validatePortalReach({ ...flat.brief, blockers: blockers(flat) }).errors, []);
});

test('inherited cover infeasibility rejects a narrow exterior component without losing cells', () => {
  const cells = cellsOf(40, 34), original = brief('compound-1', cells, [
    { id: 'west', axis: 'v', x: 0, y: 8, length: 2 },
    { id: 'east', axis: 'v', x: 40, y: 8, length: 2 },
  ]);
  const node = buildCompoundGeneration(original);
  // The explicit 4x30 before-evidence witness remains infeasible even when
  // production screening retains a narrower route sliver without offering it.
  const prepared = prepareDelegation(original, [{ key: 'exterior-witness', type: 'cover',
    cells: cellsOf(4, 30).map(cell => ({ x: cell.x + 2, y: cell.y + 2 })), reasonTags: ['unused-exterior-yard'] }],
  { blockers: placed(node.retained), receiving: COMPOUND_EXECUTION_REGISTRY.cover.receiving });
  assert.equal(prepared.children.length, 0);
  assert.equal(prepared.retained.cells.length, original.cells.length);
  assert.ok(prepared.rejected.some(({ reason }) => reason.includes('cover has no usable placement')));
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assert.deepEqual(validatePortalReach({ ...node.input, blockers: blockers(flattenDelegationResult(node)) }).errors, []);
});

test('compound delegation is canonical across cell, portal and zone order', () => {
  const original = concave();
  original.zones = [
    { tier: 1, bonus: 0, lootChance: 0, cells: original.cells.filter(cell => cell.x < 20) },
    { tier: 3, bonus: 0, lootChance: 0, cells: original.cells.filter(cell => cell.x >= 20) },
  ];
  const reversed = structuredClone(original);
  reversed.cells.reverse();
  reversed.portals.reverse();
  reversed.zones.reverse();
  for (const zone of reversed.zones) zone.cells.reverse();
  assert.deepEqual(buildCompoundGeneration(reversed), buildCompoundGeneration(original));
});

test('a broad macro yard retains narrow circulation slivers before expensive preparation', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push(
    { id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push(
    { id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const node = buildCompoundGeneration(brief('macro', cells, portals,
    { seed: 3, parameters: { gates: 4 }, zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }] }));
  assert.equal(node.offers.length, 2, 'the twelve two-cell-wide circulation strips are never offered');
  assert.deepEqual(node.offers.map(offer => offer.cells.length), [12264, 12264]);
  assert.equal(node.children.length, 0, 'the broad side components still require compatible crossings');
  assert.equal(node.retained.brief.cells.length, cells.length);
});

test('depth limit preserves the compound and records terminal empty patch ownership', () => {
  const node = buildCompoundGeneration(concave(), { maxDepth: 0 });
  assert.ok(node.children?.length);
  assert.ok(ring(node.retained).length);
  for (const child of node.children) {
    assert.equal(child.requestedBuilder, 'cover');
    assert.equal(child.actualBuilder, 'empty');
    assert.equal(child.fallbackKind, 'depth-limit');
    assert.deepEqual(child.retained.brief, child.input);
  }
  assert.deepEqual(validateBriefPartition(node.input, executionLeaves(node).map(leaf => leaf.brief)), []);
  assert.deepEqual(validatePortalReach({ ...node.input, blockers: blockers(flattenDelegationResult(node)) }).errors, []);
});

test('an unbuildable compound replaces the full region with empty and retains original requests', () => {
  const original = brief('unbuildable-compound', cellsOf(17, 16), [
    { id: 'south', axis: 'h', x: 7, y: 16, length: 2 },
  ], { fillCells: [], coreElements: { spawn: 1 } });
  const node = buildCompoundGeneration(original), flat = flattenDelegationResult(node);
  assert.equal(node.requestedBuilder, 'compound');
  assert.equal(node.actualBuilder, 'empty');
  assert.equal(node.fallbackKind, 'builder-empty');
  assert.deepEqual(flat.elements, []);
  assert.deepEqual(flat.loot, []);
  assert.deepEqual(flat.brief.coreElements, original.coreElements);
  assert.deepEqual(flat.brief.portals, original.portals);
  assert.equal(flat.manifest.cells, original.cells.length);
  const built = { cellSize: SIZE, regions: [flat], pairs: [] };
  const report = measurement(built, { components: [[original.id]] }, { setPieces: [] }, { setPieceClasses: [] });
  assert.ok(report.defects.some(defect => defect.kind === 'broken-promise' && defect.message.includes('sited 0 spawn')));
  assert.throws(() => liveMapFromBuilt(1, built), /needs .* spawns/);
});

test('a nested block compound lot keeps its prefixed ring and final portal promise', () => {
  const cells = cellsOf(44, 34), original = { ...brief('nested-block', cells, [
    { id: 'west', axis: 'v', x: 0, y: 7, length: 3 },
    { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 },
  ], { seed: 7 }), type: 'block' };
  const lot = planBlock(original).lots.find(child => child.type === 'compound');
  assert.ok(lot, 'seed 7 plans a compound lot');
  const nested = buildCompoundGeneration(lot), child = flattenDelegationResult(nested), block = buildBlock(original);
  assert.equal(nested.actualBuilder, 'compound');
  assert.ok(ring(child).length);
  const prefix = `${lot.id.slice(original.id.length + 1)}/`;
  for (const element of child.elements)
    assert.ok(block.elements.some(placed => placed.label === `${prefix}${element.label}`), `block retains ${element.label}`);
  assert.deepEqual(validatePortalReach({ ...block.brief, blockers: blockers(block) }).errors, []);
});

test('observer sees only the compound ring once and snapshots preserve that event', () => {
  const observed = [], node = buildCompoundGeneration(concave(), { observe: trace => observed.push(trace) });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].label, 'compound');
  assert.deepEqual(node.observerEvents, observed);
  assert.deepEqual(readDelegationSnapshot(roundTrip(saveDelegationSnapshot(node))).observerEvents, observed);
});

test('full and omitted compound snapshots recover the same hierarchy and result', () => {
  const node = buildCompoundGeneration(concave()), flat = flattenDelegationResult(node);
  assert.ok(node.children?.some(child => child.actualBuilder === 'cover'));
  const full = roundTrip(saveDelegationSnapshot(node));
  assert.deepEqual(readDelegationSnapshot(full), node);
  assert.deepEqual(delegationSnapshotResult(full), flat);
  const omitted = roundTrip(saveDelegationSnapshot(node, { omitResults: true }));
  assert.deepEqual(readDelegationSnapshot(omitted, COMPOUND_EXECUTION_REGISTRY), node);
  assert.deepEqual(delegationSnapshotResult(omitted, COMPOUND_EXECUTION_REGISTRY), flat);
});
