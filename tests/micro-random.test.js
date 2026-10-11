import test from 'node:test';
import assert from 'node:assert/strict';
import { delegationSeed, draw } from '../map/micro/random.ts';

test('draw preserves the established per-cell values', () => {
  assert.equal(draw(0, 0, 0, 0), 0);
  assert.equal(draw(1, 2, 3, 4), 0.1354578617028892);
  assert.equal(draw(42, -7, 19, 3), 0.42065305379219353);
  assert.equal(draw(2147483647, 12345, 67890, 99), 0.6059422593098134);
});

test('delegation seeds are deterministic and independent of request order', () => {
  const pairs = [[123, 'yard-east'], [123, 'yard-west'], [456, 'yard-east']];
  const forward = new Map(pairs.map(([seed, key]) => [`${seed}/${key}`, delegationSeed(seed, key)]));
  const reverse = new Map([...pairs].reverse().map(([seed, key]) => [`${seed}/${key}`, delegationSeed(seed, key)]));
  assert.deepEqual(reverse, forward);
  assert.equal(delegationSeed(123, 'yard-east'), 1379261077);
  assert.equal(delegationSeed(456, 'yard-east'), 1584202046);
  assert.notEqual(delegationSeed(123, 'yard-east'), delegationSeed(123, 'yard-west'));
});

test('delegation keys hash their UTF-8 representation', () => {
  assert.equal(delegationSeed(7, 'yard-東'), delegationSeed(7, 'yard-\u6771'));
  assert.equal(delegationSeed(7, 'yard-東'), 879651270);
  assert.notEqual(delegationSeed(7, 'yard-東'), delegationSeed(7, 'yard-east'));
});

test('delegation seed rejects invalid parent seeds and keys', () => {
  for (const seed of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => delegationSeed(seed, 'child'), /safe integer/);
  for (const key of ['', null, 42])
    assert.throws(() => delegationSeed(1, key), /nonempty string/);
});
