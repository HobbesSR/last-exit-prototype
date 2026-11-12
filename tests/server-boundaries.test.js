import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_MESSAGE, SERVER_MESSAGE } from '../shared/protocol.ts';

test('server ownership stays acyclic and transport cannot reach mutable simulation or replay streams', () => {
  const files = readdirSync('server').filter(f => f.endsWith('.js'));
  const graph = new Map();
  for (const name of files) {
    const file = path.resolve('server', name), code = readFileSync(file, 'utf8');
    const imports = [...code.matchAll(/from\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    graph.set(file, imports.filter(i => i.startsWith('.')).map(i => path.resolve('server', i)));
    if (name !== 'index.js') assert.ok(!imports.includes('./index.js'), `${name} imports composition root`);
    if (name !== 'match.js') assert.ok(!imports.includes('../shared/simulation.ts'), `${name} bypasses match boundary`);
    assert.doesNotMatch(code, /room\.game\b/, `${name} uses diagnostic state in application code`);
    // Static delivery of the shared modules reads source files from disk. That is asset IO, not
    // replay IO: it owns no recording state, so it stays subject to the second assertion.
    if (!['replay-store.js', 'replay-writer.js', 'replay-worker.js', 'shared-assets.js', 'vendor-modules.js'].includes(name)) {
      assert.ok(!imports.some(i => /node:(fs|zlib|stream|crypto)/.test(i) && i !== 'node:crypto'), `${name} owns replay IO`);
    }
    if (!['replay-store.js', 'replay-writer.js', 'replay-worker.js'].includes(name)) {
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

test('every wire message sent or handled in server/ or public/ is named in shared/protocol.ts', () => {
  const serverFiles = ['room-service.js', 'room-views.js', 'room-directory.js', 'latency.js'].map(f => [
    `server/${f}`,
    readFileSync(path.resolve('server', f), 'utf8'),
  ]);
  const clientCode = readFileSync(path.resolve('public', 'client.js'), 'utf8');
  const allSources = [...serverFiles, ['public/client.js', clientCode]];

  const clientKeys = new Set(Object.keys(CLIENT_MESSAGE));
  const serverKeys = new Set(Object.keys(SERVER_MESSAGE));
  const usedServerClientKeys = new Set();
  const usedServerServerKeys = new Set();

  for (const [label, code] of allSources) {
    for (const [, key] of code.matchAll(/\bCLIENT_MESSAGE\.([A-Z0-9_]+)\b/g)) {
      assert.ok(clientKeys.has(key), `${label} references unknown CLIENT_MESSAGE.${key}`);
      if (label.startsWith('server/')) usedServerClientKeys.add(key);
    }
    for (const [, key] of code.matchAll(/\bSERVER_MESSAGE\.([A-Z0-9_]+)\b/g)) {
      assert.ok(serverKeys.has(key), `${label} references unknown SERVER_MESSAGE.${key}`);
      if (label.startsWith('server/')) usedServerServerKeys.add(key);
    }
    assert.doesNotMatch(code, /\b(?:data|msg|raw)\??\.type\s*[!=]==?\s*['"`]/, `${label} compares wire message type to a raw string literal`);
    assert.doesNotMatch(code, /\bsend\s*\([^;\n]*\btype:\s*['"`]/, `${label} sends a wire message with a raw string literal type`);
    assert.doesNotMatch(code, /JSON\.stringify\s*\(\s*\{\s*type:\s*['"`]/, `${label} serializes a wire message with a raw string literal type`);
  }

  const usedClientSendKeys = new Set([...clientCode.matchAll(/\bCLIENT_MESSAGE\.([A-Z0-9_]+)\b/g)].map(m => m[1]));
  const usedClientRecvKeys = new Set([...clientCode.matchAll(/\bSERVER_MESSAGE\.([A-Z0-9_]+)\b/g)].map(m => m[1]));

  for (const key of clientKeys) {
    assert.ok(usedClientSendKeys.has(key), `CLIENT_MESSAGE.${key} is not sent in public/client.js`);
    assert.ok(usedServerClientKeys.has(key), `CLIENT_MESSAGE.${key} is not handled in server/`);
  }
  for (const key of serverKeys) {
    assert.ok(usedServerServerKeys.has(key), `SERVER_MESSAGE.${key} is not sent in server/`);
    assert.ok(usedClientRecvKeys.has(key), `SERVER_MESSAGE.${key} is not handled in public/client.js`);
  }
});
