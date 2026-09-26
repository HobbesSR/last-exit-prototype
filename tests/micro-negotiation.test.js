import test from 'node:test';
import assert from 'node:assert/strict';
import { planExample, decompositionExample } from '../shared/map/micro/decomposition/example.ts';
import { negotiatePortals } from '../shared/map/micro/sdk.ts';
import { executeDecomposition } from '../shared/map/micro/execute.ts';
import { realizeDecomposition, validateRealization } from '../shared/map/micro/decomposition/realize.ts';
import { buildInterfaces } from '../shared/map/micro/decomposition/interfaces.ts';
import { validateBoundaryComposition } from '../shared/map/micro/boundary.ts';
import { elementShapes } from '../shared/map/micro/geometry.ts';
import { rect } from '../shared/shape.ts';

const plan = planExample(decompositionExample('neck'));
const parts = [...plan.pieces, ...plan.residuals.filter(r => r.role === 'residual')];
const parent = (ports = []) => ({ cells: parts.flatMap(p => p.cells), cellSize: plan.context.cellSize, bodyProfile: 'cell', ports });
// Entry regions get no loot: loot beside a required port currently breaks entry placement (#19).
const dispatch = part => 'generator' in part || part.role === 'residual' ? { builder: part.role === 'room' ? 'depot' : 'entry', ...(part.role === 'room' ? {} : { entry: { count: 0 }, loot: { budget: 0, tier: 1 } }) } : null;
const left = { id: 'west-gate', side: 'W', start: { x: 0, y: 2 }, length: 2, required: 'hunter', allowed: 'hunter' };
const right = { id: 'east-gate', side: 'E', start: { x: 23, y: 2 }, length: 2, required: 'hunter', allowed: 'hunter' };

test('a contestant-only policy produces paired squeeze contracts that generate and validate', () => {
  const policy = { crossing: () => ({ required: 'contestant', allowed: 'contestant', others: 'sealed' }), connect: 'contestant' };
  const result = negotiatePortals(parent(), parts, plan.interfaces, policy);
  const open = Object.values(result.ports).flat().filter(p => p.required !== 'none');
  assert.equal(open.length, 4, 'two crossings, one port on each side');
  assert.ok(open.every(p => p.required === 'contestant' && p.allowed === 'contestant'));
  assert.equal(result.components.contestant.length, 1);
  assert.equal(result.components.hunter.length, parts.length, 'no hunter crossing was promised');
  assert.throws(() => negotiatePortals(parent(), parts, plan.interfaces, { ...policy, connect: 'hunter' }), /disconnected for hunter/);
  const executed = executeDecomposition(plan, { seed: 5, bodyProfile: 'cell', dispatch, portals: policy });
  assert.equal(executed.layout.connections.filter(c => executed.layout.regions.find(r => r.spec.id === c.a).ports.find(p => p.id === c.portA).required === 'contestant').length, 2);
});

test('unstated seams emit no contract, and a policy that promises nothing cannot claim connectivity', () => {
  const sealed = negotiatePortals(parent(), parts, plan.interfaces, { crossing: () => ({ required: 'hunter', allowed: 'hunter', others: 'sealed' }) });
  const unstated = negotiatePortals(parent(), parts, plan.interfaces, { crossing: () => ({ required: 'hunter', allowed: 'hunter', others: 'unstated' }) });
  const count = r => Object.values(r.ports).flat().length;
  assert.ok(count(unstated) <= count(sealed));
  assert.ok(Object.values(unstated.ports).flat().every(p => p.required === 'hunter'), 'only the chosen crossings are stated');
  const open = negotiatePortals(parent(), parts, plan.interfaces, { crossing: () => null });
  assert.equal(Object.values(open.ports).flat().length, 0);
  assert.ok(open.crossings.every(c => c.run === null));
  assert.throws(() => negotiatePortals(parent(), parts, plan.interfaces, { crossing: () => null, connect: 'contestant' }), /disconnected/);
  assert.throws(() => negotiatePortals(parent(), parts, plan.interfaces, { crossing: () => ({ required: 'hunter', allowed: 'contestant', others: 'sealed' }) }), /Invalid crossing terms/);
});

test('a crossing is placed only on a run that can carry the body it promises', () => {
  const a = { id: 'a', cells: [] }, b = { id: 'b', cells: [{ x: 3, y: 0 }] };
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) a.cells.push({ x, y });
  const boundary = { cells: [...a.cells, ...b.cells], cellSize: 40, bodyProfile: 'cell', ports: [] };
  const interfaces = buildInterfaces([a, b]);
  assert.throws(() => negotiatePortals(boundary, [a, b], interfaces, { crossing: () => ({ required: 'hunter', allowed: 'hunter', others: 'sealed' }) }), /no run that can carry a hunter/);
  const sealed = negotiatePortals(boundary, [a, b], interfaces, { crossing: () => ({ required: 'none', allowed: 'none', others: 'sealed' }) });
  assert.deepEqual(sealed.ports.a.map(p => [p.side, p.required]), [['E', 'none']]);
  assert.deepEqual(sealed.ports.b.map(p => [p.side, p.required]), [['W', 'none']]);
  const spanning = { id: 'north', side: 'N', start: { x: 0, y: 0 }, length: 4, required: 'none', allowed: 'none' };
  assert.throws(() => negotiatePortals({ ...boundary, ports: [spanning] }, [a, b], interfaces, { crossing: () => null }), /spans children/);
});

test('external obligations pass whole to their owner and are proven across the combined geometry', () => {
  const result = negotiatePortals(parent([left, right]), parts, plan.interfaces, { crossing: () => ({ required: 'hunter', allowed: 'hunter', others: 'sealed' }) });
  const owner = parts.find(p => p.cells.some(c => c.x === 0 && c.y === 2)).id;
  assert.deepEqual(result.ports[owner][0], left, 'inherited unchanged and listed first');
  assert.throws(() => negotiatePortals(parent([left, right]), parts, plan.interfaces, { crossing: () => null }), /obligations are held by children/);

  const realized = realizeDecomposition(plan, { seed: 11, ports: [left, right] });
  assert.deepEqual(realized.external, [left, right]);
  assert.deepEqual(validateRealization(realized), []);
  assert.equal(realized.portals.length, 2, 'external ports are not reported as inter-child portals');
  const dropped = structuredClone(realized), region = dropped.regions.find(r => r.spec.id === owner);
  region.spec.ports = region.spec.ports.filter(p => p.id !== left.id); region.ports = region.ports.filter(p => p.id !== left.id);
  assert.ok(validateRealization(dropped).some(e => /drops or changes inherited requirement west-gate/.test(e)));
  assert.equal(realizeDecomposition(plan).external, undefined, 'artifacts without obligations keep their earlier shape');

  // Where the sampled lattice misses a doorway barely wider than the hunter, the obligation
  // is proven by chaining children's own routes through crossings they proved from both sides.
  const children = r => r.regions.map(region => ({ ...region.spec, blockers: region.elements.flatMap(e => elementShapes(e)) }));
  const composed = validateBoundaryComposition(parent([left, right]), children(realized));
  assert.deepEqual(composed.errors, []);
  assert.ok(composed.bridged.some(b => b.role === 'hunter' && b.from === 'west-gate' && b.to === 'east-gate' && b.via.length === 3));
  const walled = children(realized), corridor = walled.find(c => c.id === 'neck:0:strip');
  corridor.blockers.push(rect(11.5 * 40, 5 * 40, 8, 3 * 40));
  const broken = validateBoundaryComposition(parent([left, right]), walled);
  assert.ok(broken.errors.some(e => e.startsWith('neck:0:strip:')));
  assert.ok(broken.errors.some(e => /parent: Required hunter port east-gate is disconnected/.test(e)), 'no bridge through a child that failed its own check');
});

