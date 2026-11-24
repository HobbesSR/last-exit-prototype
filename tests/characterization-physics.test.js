import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { CONTENT, scriptedTrace } from './characterization-physics-scenarios.js';
import { PHYSICS_VERSION } from '../shared/simulation.ts';

// The live engine's frozen characterization (#920). The arenas are stored in the fixture with their
// portal graphs (v8, since the graph holds typed arrays), so these keep their meaning when generation moves.
const expected = deserialize(gunzipSync(readFileSync(new URL('./fixtures/behavior-physics-1.v8.gz', import.meta.url))));

test('the tick cutover checkpoint names the rules version and content it characterizes', () => {
  assert.equal(expected.version, PHYSICS_VERSION, 'a rules version change is a decision that recaptures this fixture');
  assert.equal(expected.content, CONTENT);
  assert.equal(expected.checkpoint, '1283-3d.4d');
});

// The two whole bot matches take about thirty seconds and run in the slow tier
// (slow/characterization-physics-bots.test.js).
test('scripted authoritative snapshots and private projections match the tick cutover checkpoint', async () => {
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const actual = await scriptedTrace(expected.arenas[4217]);
  if (hash(actual) === hash(expected.scripted)) return;
  // Narrow failures to the first checkpoint and view, avoiding an enormous whole-trace diff.
  for (let i = 0; i < Math.max(actual.length, expected.scripted.length); i++) {
    const a = actual[i], e = expected.scripted[i];
    const label = e?.label ?? a?.label ?? i;
    if (!a || !e || a.label !== e.label) assert.deepEqual(a?.label, e?.label, `checkpoint ${i} label`);
    if (hash(a.frame) !== hash(e.frame)) {
      assert.deepEqual(a.frame, e.frame, `${label}: frame`);
      assert.fail(`${label}: frame serialized field order changed`);
    }
    assert.deepEqual(a.core, e.core, `${label}: core snapshot`);
    for (let j = 0; j < Math.max(a.views.length, e.views.length); j++) {
      if (hash(a.views[j] ?? null) !== hash(e.views[j] ?? null)) {
        assert.deepEqual(a.views[j], e.views[j], `${label}: view ${j}`);
        assert.fail(`${label}: view ${j} serialized field order changed`);
      }
    }
  }
  assert.fail('trace hashes differ outside checkpoint frames and views');
});
