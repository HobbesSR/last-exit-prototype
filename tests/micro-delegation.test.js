import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDelegation, validateBriefPartition, patchFootprintKey } from '../map/micro/delegation.ts';
import { inheritBriefMargins } from '../map/micro/margins.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { rect } from '../shared/shape.ts';
import { clearFootprint } from '../map/kernel/margins.ts';

const cells = (x, y, w, h) => Array.from({ length: w * h }, (_, i) => ({ x: x + i % w, y: y + Math.floor(i / w) }));
const keys = list => list.map(c => `${c.x},${c.y}`).sort();
const policy = extra => ({ receiving: () => null, ...extra });
const offer = (key, owned, extra = {}) => ({ key, cells: owned, type: 'open', ...extra });
function brief(owned = cells(0, 0, 9, 6), extra = {}) {
  return { id: 'parent', seed: 271, type: 'hut', cellSize: 40, cells: owned,
    zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: owned.filter(c => c.x < 5) },
      { tier: 3, bonus: 2, lootChance: 0.25, cells: owned.filter(c => c.x >= 5) }].filter(z => z.cells.length),
    portals: [], ...extra };
}
const allBriefs = result => [result.retained, ...result.children.map(c => c.brief)];
function assertPartition(parent, result) {
  const children = allBriefs(result);
  assert.deepEqual(validateBriefPartition(parent, children), []);
  assert.deepEqual(keys(children.flatMap(c => c.cells)), keys(parent.cells));
  assert.equal(new Set(children.flatMap(c => keys(c.cells))).size, parent.cells.length);
  for (const crossing of result.crossings) {
    const pair = children.filter(c => c.portals.some(p => p.id === crossing.portal.id));
    assert.equal(pair.length, 2);
    assert.deepEqual(pair[0].portals.find(p => p.id === crossing.portal.id), pair[1].portals.find(p => p.id === crossing.portal.id));
  }
}

test('whole-cell patches make an exact paired partition with stable identity and advisory input', () => {
  const parent = brief(undefined, { parameters: { parentOnly: 7 }, guidance: { weather: 'dry' }, coreElements: { spawn: 1 } });
  const west = offer('west / yard', cells(0, 0, 2, 6), { reasonTags: ['spare', 'side', 'spare'], parameters: { density: 2 } });
  const east = offer('east', cells(7, 0, 2, 6), { guidance: { weather: 'wet' } });
  const prepared = prepareDelegation(parent, [east, west], policy());
  assertPartition(parent, prepared);
  assert.deepEqual(prepared.children.map(c => c.key), ['east', 'west / yard']);
  assert.equal(prepared.crossings.length, 2);
  assert.deepEqual(prepared.children[1].brief.delegation, { sourceBuilder: 'hut', reasonTags: ['side', 'spare'] });
  assert.deepEqual(prepared.children[1].brief.parameters, { density: 2 });
  assert.equal(Object.hasOwn(prepared.children[1].brief, 'guidance'), false);
  assert.deepEqual(prepared.retained.guidance, parent.guidance);
  assert.deepEqual(prepared.children[0].brief.guidance, { weather: 'wet' });
  const forwarded = prepareDelegation(parent, [{ ...west, guidance: parent.guidance }], policy());
  assert.deepEqual(forwarded.children[0].brief.guidance, parent.guidance, 'the offering builder may deliberately forward advice');
  assert.equal(prepared.children.every(c => c.brief.coreElements === undefined), true);
  assert.equal(prepared.children.every(c => c.brief.zones.every(z => z.cells.every(cell => c.brief.cells.some(o => o.x === cell.x && o.y === cell.y)))), true);
  assert.deepEqual(prepareDelegation({ ...parent, cells: [...parent.cells].reverse(), zones: [...parent.zones].reverse() },
    [west, east].map(o => ({ ...o, cells: [...o.cells].reverse() })).reverse(), policy()), prepared);
  const rejected = prepareDelegation(parent, [offer('a', cells(0, 0, 2, 6)), offer('b', cells(7, 0, 2, 6))],
    policy({ receiving: (_brief, candidate) => candidate.key === 'a' ? 'needs a larger yard' : null }));
  assert.deepEqual(rejected.rejected, [{ key: 'a', reason: 'Receiving builder for a: needs a larger yard' }]);
  assert.equal(rejected.children[0].key, 'b');
  assert.equal(rejected.children[0].brief.id, prepareDelegation(parent, [offer('b', cells(7, 0, 2, 6))], policy()).children[0].brief.id);
  assert.equal(rejected.children[0].brief.seed, prepareDelegation(parent, [offer('b', cells(7, 0, 2, 6))], policy()).children[0].brief.seed);
  const repeatedOwner = allBriefs(prepared).map(c => structuredClone(c));
  repeatedOwner[1].id = repeatedOwner[0].id;
  assert.match(validateBriefPartition(parent, repeatedOwner).join(' '), /unique identities/);
  const overlap = allBriefs(prepared).map(c => structuredClone(c));
  overlap[1].cells.push(overlap[0].cells[0]);
  assert.match(validateBriefPartition(parent, overlap).join(' '), /disjoint|perimeter|connected/);
  const omitted = allBriefs(prepared).map(c => structuredClone(c));
  omitted[0].cells = omitted[0].cells.slice(1);
  assert.match(validateBriefPartition(parent, omitted).join(' '), /exhaust|perimeter/);
  const outside = allBriefs(prepared).map(c => structuredClone(c));
  outside[0].cells.push({ x: 20, y: 20 });
  assert.match(validateBriefPartition(parent, outside).join(' '), /inside|connected/);
});

test('malformed offers fail and infeasible proposals retain their cells with reasons', () => {
  const parent = brief();
  const left = cells(0, 0, 2, 6);
  assert.equal(patchFootprintKey([...left].reverse()), patchFootprintKey(left));
  assert.notEqual(patchFootprintKey(left), patchFootprintKey(cells(0, 0, 3, 6)));
  assert.throws(() => patchFootprintKey([left[0], left[0]]), /Duplicate/);
  for (const bad of [offer('', left), offer('bad', left, { type: '' })])
    assert.throws(() => prepareDelegation(parent, [bad], policy()), /keys|types/);
  assert.throws(() => prepareDelegation(parent, [offer('x', left), offer('x', cells(7, 0, 2, 6))], policy()), /unique/);
  assert.throws(() => prepareDelegation(parent, [offer('x', left), offer('y', [left[0]])], policy()), /disjoint/);
  assert.throws(() => prepareDelegation(parent, [offer('x', [{ x: 20, y: 0 }])], policy()), /inside/);
  assert.throws(() => prepareDelegation(parent, [offer('x', [left[0], left[0]])], policy()), /Duplicate/);
  assert.throws(() => prepareDelegation(parent, [offer('x', left)], policy({ protectedCells: [{ x: 20, y: 0 }] })), /Protected/);
  for (const protectedCells of [[null], [undefined], [{ x: 0.5, y: 0 }], {}])
    assert.throws(() => prepareDelegation(parent, [], policy({ protectedCells })), /Protected cells must have whole addresses/);
  const protectedCell = prepareDelegation(parent, [offer('x', left)], policy({ protectedCells: [left[0]] }));
  assert.deepEqual(protectedCell.children, []);
  assert.match(protectedCell.rejected[0].reason, /protected cells/);
  const protectedRun = prepareDelegation(parent, [offer('x', left)], policy({ protectedRuns: [{ axis: 'v', x: 1, y: 0, length: 6 }] }));
  assert.equal(protectedRun.children.length, 0);
  const center = cells(3, 0, 3, 6);
  const disconnected = prepareDelegation(parent, [offer('bridge', center)], policy());
  assert.equal(disconnected.children.length, 0);
  assert.match(disconnected.rejected[0].reason, /disconnects retained/);
  const invalidReceiver = policy({ receiving: () => '' });
  assert.throws(() => prepareDelegation(parent, [offer('x', left)], invalidReceiver), /nonempty/);
  assert.throws(() => prepareDelegation(parent, [offer('x', left)],
    policy({ receiving: () => { throw new Error('unknown receiving type'); } })), /unknown receiving type/);
});

test('external portals stay whole, transfer only by policy, and split runs are rejected', () => {
  const west = { id: 'west', axis: 'v', x: 0, y: 2, length: 2 };
  const parent = brief(undefined, { portals: [west] });
  const westOffer = offer('edge', cells(0, 0, 2, 6));
  assert.match(prepareDelegation(parent, [westOffer], policy()).rejected[0].reason, /remain retained/);
  const moved = prepareDelegation(parent, [westOffer], policy({ externalPortals: 'whole-child' }));
  assertPartition(parent, moved);
  assert.deepEqual(moved.children[0].brief.portals.find(p => p.id === 'west'), west);
  assert.equal(moved.retained.portals.some(p => p.id === 'west'), false);
  const split = prepareDelegation(parent, [offer('half', cells(0, 0, 9, 3))], policy({ externalPortals: 'whole-child' }));
  assert.equal(split.children.length, 0);
  assert.match(split.rejected[0].reason, /cannot be split/);
});

test('a later offer cannot invalidate an already accepted receiving interface', () => {
  const parent = brief();
  const prepared = prepareDelegation(parent, [offer('a', cells(0, 0, 3, 3)), offer('b', cells(0, 3, 3, 3))],
    policy({ receiving: (child, candidate) => candidate.key === 'a' && child.portals.length > 1 ? 'only accepts a pocket' : null }));
  assertPartition(parent, prepared);
  assert.deepEqual(prepared.children.map(c => c.key), ['a']);
  assert.equal(prepared.children[0].brief.portals.length, 1);
  assert.deepEqual(prepared.rejected, [{ key: 'b', reason: 'Receiving builder for a: only accepts a pocket' }]);
});

test('clear and fill inheritance, internal runs, and a third owner preserve nearby obligations', () => {
  const parent = brief(undefined, { fillCells: cells(0, 1, 9, 4), clearCells: cells(-1, 0, 1, 6),
    internalGuaranteed: [{ axis: 'v', x: 1, y: 1, length: 4 }],
    hints: [{ axis: 'h', x: 0, y: 0, length: 9 }] });
  const result = prepareDelegation(parent, [offer('west', cells(0, 0, 2, 6)), offer('east', cells(7, 0, 2, 6))], policy());
  assertPartition(parent, result);
  const west = result.children.find(c => c.key === 'west').brief;
  assert.deepEqual(west.internalGuaranteed, parent.internalGuaranteed);
  assert.deepEqual(west.hints, [{ axis: 'h', x: 0, y: 0, length: 2 }]);
  for (const child of allBriefs(result)) {
    assert.deepEqual(keys(child.fillCells), keys(child.cells.filter(c => c.y >= 1 && c.y <= 4).filter(c => !child.clearCells.some(m => m.x === c.x && m.y === c.y))));
    assert.deepEqual(inheritBriefMargins(parent, allBriefs(result)).find(c => c.id === child.id), child);
  }
});

test('an explicitly empty fill still has ownership and portal obligations', () => {
  const parent = brief(undefined, { fillCells: [] });
  const result = prepareDelegation(parent, [offer('vacant', cells(7, 0, 2, 6))], policy());
  assertPartition(parent, result);
  for (const child of allBriefs(result)) {
    assert.deepEqual(child.fillCells, []);
    assert.deepEqual(validatePortalReach({ ...child, blockers: [] }).errors, []);
    assert.equal(buildRegion({ ...child, type: 'open' }).elements.length, 0);
  }
});

test('splitting an internal guaranteed seam preserves its footprint without promoting it to a portal', () => {
  const run = { axis: 'v', x: 7, y: 0, length: 6 };
  const parent = brief(undefined, { internalGuaranteed: [run] });
  const result = prepareDelegation(parent, [offer('edge', cells(7, 0, 2, 6))], policy());
  assertPartition(parent, result);
  assert.equal(result.crossings.length, 1);
  for (const child of allBriefs(result)) {
    assert.deepEqual(child.internalGuaranteed, []);
    assert.equal(child.portals.length, 1);
    assert.equal(child.portals[0].length, 2, 'only the independently negotiated crossing is a portal');
    const affected = clearFootprint([run], parent.cells).filter(c => child.cells.some(o => o.x === c.x && o.y === c.y));
    assert.ok(affected.every(c => child.clearCells.some(m => m.x === c.x && m.y === c.y)));
  }
});

test('disconnected fill fragments and a parent beyond 4096 cells remain legal', () => {
  const owned = cells(0, 0, 12, 8);
  const parent = brief(owned, { fillCells: [{ x: 11, y: 0 }, { x: 11, y: 7 }] });
  const split = prepareDelegation(parent, [offer('edge', cells(9, 0, 3, 8))], policy());
  assertPartition(parent, split);
  assert.deepEqual(keys(split.children[0].brief.fillCells), ['11,0', '11,7']);
  assert.deepEqual(validatePortalReach({ ...split.children[0].brief, blockers: [] }).errors, []);
  const large = brief(cells(0, 0, 80, 60));
  const result = prepareDelegation(large, [offer('sliver', cells(78, 0, 2, 60))], policy());
  assert.equal(large.cells.length, 4800);
  assertPartition(large, result);
  assert.equal(result.children.length, 1);
  const many = brief(cells(0, 0, 80, 8));
  const offers = Array.from({ length: 17 }, (_, i) => offer(`p${String(i).padStart(2, '0')}`, cells(i * 4, 0, 2, 4)));
  const uncapped = prepareDelegation(many, offers, policy());
  assertPartition(many, uncapped);
  assert.equal(uncapped.children.length, 17, 'no demonstration-boundary child cap applies');
});

test('a third owner receives clearance at another pair’s crossing endpoint', () => {
  const parent = brief();
  const prepared = prepareDelegation(parent, [
    offer('northwest', cells(0, 0, 3, 3)), offer('southwest', cells(0, 3, 3, 3)),
  ], policy());
  assertPartition(parent, prepared);
  const briefs = allBriefs(prepared);
  assert.equal(prepared.crossings.length, 3);
  let thirdOwnerCells = 0;
  for (const crossing of prepared.crossings) {
    const footprint = clearFootprint([crossing.portal], parent.cells);
    for (const child of briefs) {
      const affected = footprint.filter(c => child.cells.some(o => o.x === c.x && o.y === c.y));
      if (child.id !== crossing.a && child.id !== crossing.b) thirdOwnerCells += affected.length;
      assert.ok(affected.every(c => child.clearCells.some(m => m.x === c.x && m.y === c.y)), `${child.id} missing ${crossing.portal.id}`);
    }
  }
  assert.ok(thirdOwnerCells > 0, 'a third owner actually intersects a crossing footprint');
});

test('planning and placed blocker handoffs yield independently buildable child briefs', () => {
  const parent = brief();
  const patch = offer('side', cells(7, 0, 2, 6));
  const planned = prepareDelegation(parent, [patch], policy());
  const placed = prepareDelegation(parent, [patch], policy({ blockers: [rect(120, 80, 40, 40)] }));
  for (const result of [planned, placed]) {
    assertPartition(parent, result);
    const child = result.children[0].brief;
    const built = buildRegion(child);
    assert.equal(built.brief.id, child.id);
    assert.deepEqual(validatePortalReach({ ...child, blockers: [] }).errors, []);
  }
  const blocked = prepareDelegation(parent, [patch], policy({ blockers: [rect(275, 0, 10, 240)] }));
  assert.equal(blocked.children.length, 0);
  assert.match(blocked.rejected[0].reason, /crossing|geometry|clearance/i);
});

test('the same child interface builds real cover before or after independent parent placement', () => {
  const parent = brief(cells(0, 0, 20, 12));
  const patch = offer('yard', cells(12, 0, 8, 12), { type: 'cover' });
  const planned = prepareDelegation(parent, [patch], policy());
  const afterPlacement = prepareDelegation(parent, [patch], policy({ blockers: [rect(120, 80, 80, 80)] }));
  assert.deepEqual(afterPlacement.children[0].brief, planned.children[0].brief);
  const input = JSON.parse(JSON.stringify(planned.children[0].brief));
  const built = buildRegion(input);
  assert.ok(built.elements.length > 0, 'child produces themed collision geometry from its interface alone');
  assert.deepEqual(buildRegion(afterPlacement.children[0].brief), built);
  const blockers = built.elements.flatMap(e => elementShapes(e));
  assert.deepEqual(validateFillConstraints(input, blockers), []);
  assert.deepEqual(validatePortalReach({ ...input, blockers }).errors, []);
});

test('decomposition A–B route survives a later patch split; isolated local promises fail composition', () => {
  const original = brief(undefined, { portals: [
    { id: 'A', axis: 'v', x: 0, y: 2, length: 2 }, { id: 'B', axis: 'v', x: 9, y: 2, length: 2 }] });
  const left = brief(cells(0, 0, 4, 6), { id: 'left', type: 'open', portals: [original.portals[0], { id: 'AB', axis: 'v', x: 4, y: 2, length: 2 }] });
  const right = brief(cells(4, 0, 5, 6), { id: 'right', type: 'open', portals: [original.portals[1], { id: 'AB', axis: 'v', x: 4, y: 2, length: 2 }] });
  assert.deepEqual(validateBriefPartition(original, [left, right]), []);
  const later = prepareDelegation(right, [offer('B-edge', cells(7, 0, 2, 6))], policy({ externalPortals: 'whole-child' }));
  assertPartition(right, later);
  const leaves = [left, ...allBriefs(later)];
  assert.deepEqual(validateBriefPartition(original, leaves), []);
  for (const leaf of leaves) assert.deepEqual(validatePortalReach({ ...leaf, blockers: [] }).errors, [], leaf.id);
  const noPair = leaves.map(c => structuredClone(c));
  const crossing = later.crossings[0].portal.id;
  for (const leaf of noPair) leaf.portals = leaf.portals.filter(p => p.id !== crossing);
  for (const leaf of noPair) assert.deepEqual(validatePortalReach({ ...leaf, blockers: [] }).errors, [], leaf.id);
  assert.ok(validateBriefPartition(original, noPair).some(e => /paired|crossing|disconnect/i.test(e)));
});
