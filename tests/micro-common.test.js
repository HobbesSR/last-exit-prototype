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

/**
 * Every module a source names: `from` clauses of imports and re-exports, side-effect
 * imports, dynamic imports and triple-slash references, in any quote style. Type-only
 * imports are erased before Node loads a module, so a loader hook would miss the very
 * dependency this guards against; the scan reads the source instead. It errs towards
 * matching, so a false match fails loudly rather than a real import passing silently.
 */
function importedModules(source) {
  const specifier = /\b(?:from|import)\s*\(?\s*(['"`])([^'"`]+)\1|\brequire\s*\(\s*(['"`])([^'"`]+)\3|\/\/\/\s*<reference\s+(?:path|types)\s*=\s*(['"])([^'"]+)\5/g;
  return [...source.matchAll(specifier)].map(m => m[2] ?? m[4] ?? m[6]);
}

test('the import scan sees every import form', () => {
  const forms = [
    `import { a } from './single.ts';`, `import { a } from "./double.ts";`, 'import type { A } from `./tick.ts`;',
    `import './side-effect.ts';`, `import "./side-effect-double.ts";`, `const m = await import("./dynamic.ts");`,
    `const n = import( './dynamic-spaced.ts' );`, `export * from "./reexport.ts";`, `export { b } from '../outside.ts';`,
    `import x = require('./required.ts');`, `/// <reference types="sat" />`, `/// <reference path="../vendor.d.ts" />`,
    `import {\n  a,\n  b,\n} from\n  '../multiline.ts';`,
  ];
  assert.deepEqual(forms.map(importedModules), [
    ['./single.ts'], ['./double.ts'], ['./tick.ts'], ['./side-effect.ts'], ['./side-effect-double.ts'], ['./dynamic.ts'],
    ['./dynamic-spaced.ts'], ['./reexport.ts'], ['../outside.ts'], ['./required.ts'], ['sat'], ['../vendor.d.ts'], ['../multiline.ts'],
  ]);
});

// The space imports only itself, so a consumer at either level pulls in nothing else.
// contract.ts still reaches the engine through RegionResult until C1 (#84) splits it, so
// no other file here may import it.
test('the shared map space imports nothing outside itself', () => {
  const files = readdirSync('shared/map/common');
  assert.ok(files.length > 0);
  for (const file of files) {
    if (file === 'contract.ts') continue;
    const allowed = path => /^\.\/[\w-]+\.ts$/.test(path) && files.includes(path.slice(2)) && path !== './contract.ts';
    assert.deepEqual(importedModules(readFileSync(`shared/map/common/${file}`, 'utf8')).filter(path => !allowed(path)), [], file);
  }
});
