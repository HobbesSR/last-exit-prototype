import test from 'node:test';
import assert from 'node:assert/strict';
import { SETS, inventory, matches, membership, resolve, setsFor, stem } from './sets.mjs';

// The catalog stays complete as files are added (31, "Test sets"): a new test file names its set.
test('every unit and browser test file belongs to exactly one set', () => {
  const files = inventory();
  for (const tier of ['fast', 'slow', 'browser']) {
    assert.ok(files[tier].length > 0, `${tier} files found`);
    const wrong = [...membership(files[tier], tier)].filter(([, sets]) => sets.length !== 1)
      .map(([file, sets]) => `${file}: ${sets.length ? sets.join(', ') : 'no set'}`);
    assert.deepEqual(wrong, [], `add each to one set in tests/sets.mjs (${tier})`);
  }
});

test('every member pattern names at least one file, so a rename is noticed', () => {
  const files = inventory();
  const stale = Object.entries(SETS).flatMap(([name, set]) => ['fast', 'slow', 'browser'].flatMap(tier =>
    (set[tier] ?? []).filter(pattern => !files[tier].some(file => matches(pattern, stem(file))))
      .map(pattern => `${name} ${tier} ${pattern}`)));
  assert.deepEqual(stale, []);
});

test('a selector narrows a set by name, and an unknown set is refused', () => {
  const depot = resolve('micro:depot', 'fast');
  assert.ok(depot.length > 3 && depot.every(file => file.includes('micro-depot')), depot.join(' '));
  const compound = resolve('micro:compound', 'slow');
  assert.ok(compound.length > 2 && compound.every(file => file.startsWith('tests/slow/micro-compound')), compound.join(' '));
  assert.throws(() => resolve('nonsense', 'fast'), /Unknown test set "nonsense"/);
});

test('changed paths map to the sets they should prompt', () => {
  assert.deepEqual(setsFor(['map/micro/strategies/depot.ts']), ['micro']);
  assert.deepEqual(setsFor(['shared/physics/world.ts']), ['physics']);
  assert.deepEqual(setsFor(['map/kernel/scale.ts']).sort(), ['macro', 'micro']);
  assert.deepEqual(setsFor(['server/room-service.js', 'public/palette.js']).sort(), ['client', 'rooms']);
  assert.deepEqual(setsFor(['README.md']), []);
});
