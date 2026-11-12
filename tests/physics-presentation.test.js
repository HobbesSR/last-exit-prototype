import test from 'node:test';
import assert from 'node:assert/strict';
import { describeContent, readPresentation } from '../shared/presentation.ts';
import { contentById, defaultContent } from '../shared/simulation/content.ts';

const geometry = {
  contestant: { headRadius: 21 * 43 / 64, bodyRadius: 0.8 * 21 * 43 / 64, hurtRadius: 12 },
  gladiator: { headRadius: 25 * 65 / 80, bodyRadius: 0.8 * 25 * 65 / 80, hurtRadius: 23 },
};

test('geometry is a detached, deeply frozen display projection included in described content', () => {
  const content = structuredClone(defaultContent());
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

test('reading a descriptor accepts omitted geometry from older recordings and validates a present geometry field completely', () => {
  const old = { ...structuredClone(describeContent(defaultContent())) };
  delete old.actorGeometry;
  assert.equal(Object.hasOwn(readPresentation(old), 'actorGeometry'), false);
  const withGeometry = actorGeometry => ({ ...old, actorGeometry });
  assert.deepEqual(readPresentation(withGeometry(geometry)).actorGeometry, geometry);
  for (const invalid of [null, undefined, {}, [], { contestant: geometry.contestant },
    { ...geometry, contestant: { ...geometry.contestant, headRadius: 0 } },
    { ...geometry, contestant: { ...geometry.contestant, bodyRadius: -1 } },
    { ...geometry, gladiator: { ...geometry.gladiator, hurtRadius: Infinity } },
    { ...geometry, gladiator: { ...geometry.gladiator, hurtRadius: '23' } },
  ]) assert.equal(readPresentation(withGeometry(invalid)), null);
});
