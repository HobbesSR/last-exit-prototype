import test from 'node:test';
import assert from 'node:assert/strict';
import { describeContent, readPresentation } from '../shared/presentation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { p1Content } from './helpers/scenario.js';

const geometry = {
  contestant: { headRadius: 21 * 43 / 64, bodyRadius: 0.8 * 21 * 43 / 64, hurtRadius: 12 },
  gladiator: { headRadius: 25 * 65 / 80, bodyRadius: 0.8 * 25 * 65 / 80, hurtRadius: 23 },
};

test('geometry is an optional detached, deeply frozen display projection', () => {
  const old = describeContent(p1Content());
  assert.equal(Object.hasOwn(old, 'actorGeometry'), false);
  assert.equal(Object.hasOwn(readPresentation(old), 'actorGeometry'), false);

  const content = p1Content();
  content.actorPhysics = { geometry: structuredClone(geometry), acceleration: 180, braking: 220 };
  const described = describeContent(content);
  assert.deepEqual(described.actorGeometry, geometry);
  assert.equal(Object.hasOwn(described, 'actorPhysics'), false);
  assert.ok(Object.isFrozen(described.actorGeometry));
  assert.ok(Object.isFrozen(described.actorGeometry.contestant));
  assert.ok(Object.isFrozen(described.actorGeometry.gladiator));
  content.actorPhysics.geometry.contestant.headRadius = 99;
  assert.equal(described.actorGeometry.contestant.headRadius, geometry.contestant.headRadius);

  const wire = structuredClone(described);
  const parsed = readPresentation(wire, 'content-7');
  wire.actorGeometry.gladiator.bodyRadius = 99;
  assert.deepEqual(parsed.actorGeometry, geometry);
  assert.ok(Object.isFrozen(parsed.actorGeometry.gladiator));
});

test('a present geometry field must validate completely', () => {
  const old = describeContent(p1Content());
  const withGeometry = actorGeometry => ({ ...old, actorGeometry });
  assert.deepEqual(readPresentation(withGeometry(geometry)).actorGeometry, geometry);
  for (const invalid of [null, undefined, {}, [], { contestant: geometry.contestant },
    { ...geometry, contestant: { ...geometry.contestant, headRadius: 0 } },
    { ...geometry, contestant: { ...geometry.contestant, bodyRadius: -1 } },
    { ...geometry, gladiator: { ...geometry.gladiator, hurtRadius: Infinity } },
    { ...geometry, gladiator: { ...geometry.gladiator, hurtRadius: '23' } },
  ]) assert.equal(readPresentation(withGeometry(invalid)), null);
});
