import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('bundled block inventory runs and reports each authored library', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['tools/block-library-audit.mjs'], { encoding: 'utf8' }));
  assert.deepEqual(report.libraries.map(library => library.name), ['12x6', '24x12', '36x18']);
  for (const library of report.libraries) {
    assert.deepEqual(library.failures, []);
    assert.ok(library.setPieces.length > 0, `${library.name} reports its block set pieces`);
  }
});
