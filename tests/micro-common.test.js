import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CELL_SCALE, MIN_PORTAL_LENGTH } from '../map/kernel/scale.ts';
import { boundaryRuns } from '../map/kernel/run.ts';
import { RUN_CASES, runCaseParts } from '../map/kernel/run-cases.ts';
import { buildInterfaces, microMetrics } from '../map/micro/sdk.ts';

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
test('the shared map space imports nothing outside itself', () => {
  const files = readdirSync('map/kernel');
  assert.ok(files.includes('contract.ts'));
  for (const file of files) {
    const allowed = path => /^\.\/[\w-]+\.ts$/.test(path) && files.includes(path.slice(2));
    assert.deepEqual(importedModules(readFileSync(`map/kernel/${file}`, 'utf8')).filter(path => !allowed(path)), [], file);
  }
});

/** Each source file under `dir`, with the repository paths its relative imports reach. */
function reachedFrom(dir) {
  return readdirSync(dir, { recursive: true }).map(f => `${dir}/${f.split(path.sep).join('/')}`)
    .filter(f => /\.(ts|mts|js|mjs)$/.test(f) && !/\/(node_modules|test-results)\//.test(f))
    .map(file => [file, importedModules(readFileSync(file, 'utf8'))
      .map(spec => spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec)]);
}

// Map generation builds on the game core, never the reverse (docs 22): nothing in shared/
// imports map/ until integration wires the two together.
test('the game core imports nothing from map/', () => {
  for (const [file, reached] of reachedFrom('shared'))
    assert.deepEqual(reached.filter(target => /^\/?map\//.test(target)), [], file);
});

// Macro and micro don't import each other (50), except that macro may call the SDK (22). The
// tools show both halves, so they join them in map/tools/ (#144), and neither half imports the tools.
test('macro and micro meet only in map/tools/', () => {
  for (const [dir, others] of [['map/macro', /^map\/(micro\/(?!sdk\.ts$)|tools\/)/], ['map/micro', /^map\/(macro|tools)\//]])
    for (const [file, reached] of reachedFrom(dir)) assert.deepEqual(reached.filter(target => others.test(target)), [], file);
});
