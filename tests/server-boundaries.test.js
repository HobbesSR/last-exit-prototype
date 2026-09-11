import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

test('server ownership stays acyclic and transport cannot reach mutable simulation or replay streams', () => {
  const files = readdirSync('server').filter(f => f.endsWith('.js'));
  const graph = new Map();
  for (const name of files) {
    const file = path.resolve('server', name), code = readFileSync(file, 'utf8');
    const imports = [...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    graph.set(file, imports.filter(i => i.startsWith('.')).map(i => path.resolve('server', i)));
    if (name !== 'index.js') assert.ok(!imports.includes('./index.js'), `${name} imports composition root`);
    if (name !== 'match.js') assert.ok(!imports.includes('../shared/simulation.js'), `${name} bypasses match boundary`);
    assert.doesNotMatch(code, /room\.game\b/, `${name} uses diagnostic state in application code`);
    if (!['replay-store.js', 'replay-writer.js'].includes(name)) {
      assert.ok(!imports.some(i => /node:(fs|zlib|stream|crypto)/.test(i) && i !== 'node:crypto'), `${name} owns replay IO`);
      assert.doesNotMatch(code, /writableNeedDrain|\.recorder\b|\.hash\b/, `${name} depends on replay implementation`);
    }
    if (['room-service.js', 'match.js', 'room-views.js'].includes(name)) assert.ok(!imports.includes('ws') && !imports.includes('express'));
  }
  function visit(file, stack = []) {
    assert.ok(!stack.includes(file), `cycle: ${[...stack, file].join(' -> ')}`);
    for (const next of graph.get(file) || []) visit(next, [...stack, file]);
  }
  for (const file of graph.keys()) visit(file);
});
