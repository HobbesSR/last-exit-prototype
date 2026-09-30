import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CELL_SCALE, MIN_PORTAL_LENGTH } from '../shared/map/common/scale.ts';
import { boundaryRuns } from '../shared/map/common/run.ts';
import { RUN_CASES, runCaseParts } from '../shared/map/common/run-cases.ts';
import { buildInterfaces, microMetrics } from '../shared/map/micro/sdk.ts';

test('the cell profile reads body scale from the shared map space', () => {
  const metrics = microMetrics({ cellSize: 40, bodyProfile: 'cell' });
  assert.equal(metrics.body.contestant, 40 * CELL_SCALE.contestantRadius);
  assert.equal(metrics.body.hunter, 40 * CELL_SCALE.hunterRadius);
  assert.equal(metrics.doorway, 40 * CELL_SCALE.doorway);
  assert.equal(metrics.squeeze, 40 * CELL_SCALE.squeeze);
  assert.equal(metrics.clearance.hunter, 40 * (CELL_SCALE.hunterRadius + CELL_SCALE.clearanceMargin));
  assert.equal(MIN_PORTAL_LENGTH, 2);
});

for (const runCase of RUN_CASES) test(`runs: ${runCase.name}`, () => {
  const parts = runCaseParts(runCase);
  assert.deepEqual(boundaryRuns(parts), runCase.boundaries);
  assert.deepEqual(buildInterfaces(parts).map(({ a, b, runs }) => ({ a, b, runs })), runCase.boundaries);
});

// The space imports only itself, so a consumer at either level pulls in nothing else.
// contract.ts still reaches the engine through RegionResult until C1 (#84) splits it, so
// no other file here may import it.
test('the shared map space imports nothing outside itself', () => {
  for (const file of readdirSync('shared/map/common')) {
    const imports = [...readFileSync(`shared/map/common/${file}`, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    const allowed = path => /^\.\/[\w-]+\.ts$/.test(path) && path !== './contract.ts';
    assert.deepEqual(file === 'contract.ts' ? [] : imports.filter(path => !allowed(path)), [], file);
  }
});
