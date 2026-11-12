import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_MESSAGE, CLIENT_MESSAGE_TYPES, SERVER_MESSAGE, SERVER_MESSAGE_TYPES } from '../shared/protocol.ts';

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

test('every wire message and HTTP payload sent or handled in server/ or public/ uses shared/protocol.ts names and checked builders', () => {
  const serverSources = readdirSync('server')
    .filter(f => f.endsWith('.js'))
    .map(f => [`server/${f}`, readFileSync(path.resolve('server', f), 'utf8')]);
  const publicSources = readdirSync('public')
    .filter(f => f.endsWith('.js'))
    .map(f => [`public/${f}`, readFileSync(path.resolve('public', f), 'utf8')]);
  const allSources = [...serverSources, ...publicSources];

  const clientKeys = new Set(Object.keys(CLIENT_MESSAGE));
  const serverKeys = new Set(Object.keys(SERVER_MESSAGE));
  const usedServerClientKeys = new Set();
  const usedPublicClientKeys = new Set();
  const usedPublicServerKeys = new Set();

  const serverBuilderByKey = {
    WELCOME: ['playerWelcomeMessage', 'spectatorWelcomeMessage', 'devWelcomeMessage'],
    READY: ['readyMessage'],
    STATE: ['stateMessage'],
    LOBBY: ['lobbyMessage'],
    CHOOSE: ['chooseReplyMessage'],
    TELEPORT: ['teleportReplyMessage'],
    PAUSED: ['pausedMessage'],
    SAVED: ['savedMessage'],
    REPLAY_STATUS: ['replayStatusMessage'],
    ERROR: ['errorMessage'],
    PING: ['pingMessage'],
  };
  assert.deepEqual(new Set(Object.keys(serverBuilderByKey)), serverKeys, 'every SERVER_MESSAGE key maps to checked builder(s)');
  const calledServerBuilders = new Set();

  const wireTypesPattern = [...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES]
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const rawTypeCompare = new RegExp(`\\b(?:data|msg|raw)\\??\\.type\\s*[!=]==?\\s*['"\`](?:${wireTypesPattern})['"\`]`);

  for (const [label, code] of allSources) {
    for (const [, key] of code.matchAll(/\bCLIENT_MESSAGE\.([A-Z0-9_]+)\b/g)) {
      assert.ok(clientKeys.has(key), `${label} references unknown CLIENT_MESSAGE.${key}`);
      if (label.startsWith('server/')) usedServerClientKeys.add(key);
      if (label.startsWith('public/')) usedPublicClientKeys.add(key);
    }
    for (const [, key] of code.matchAll(/\bSERVER_MESSAGE\.([A-Z0-9_]+)\b/g)) {
      assert.ok(serverKeys.has(key), `${label} references unknown SERVER_MESSAGE.${key}`);
      if (label.startsWith('public/')) usedPublicServerKeys.add(key);
    }
    if (label.startsWith('server/')) {
      for (const builders of Object.values(serverBuilderByKey)) {
        for (const builder of builders) {
          if (new RegExp(`\\b${builder}\\s*\\(`).test(code)) calledServerBuilders.add(builder);
        }
      }
      assert.doesNotMatch(code, /\btype:\s*SERVER_MESSAGE\./, `${label} constructs a raw SERVER_MESSAGE literal instead of using a checked builder`);
    }
    assert.doesNotMatch(code, rawTypeCompare, `${label} compares wire message type to a raw string literal`);
    assert.doesNotMatch(code, /\bsend\s*\(\s*session\b[^;\n]*\btype:\s*['"`]/, `${label} sends a wire message with a raw string literal type`);
    assert.doesNotMatch(code, /JSON\.stringify\s*\(\s*\{\s*type:\s*['"`]/, `${label} serializes a wire message with a raw string literal type`);
  }

  for (const key of clientKeys) {
    assert.ok(usedPublicClientKeys.has(key), `CLIENT_MESSAGE.${key} is not sent in public/`);
    assert.ok(usedServerClientKeys.has(key), `CLIENT_MESSAGE.${key} is not handled in server/`);
  }
  for (const [key, builders] of Object.entries(serverBuilderByKey)) {
    for (const builder of builders) {
      assert.ok(calledServerBuilders.has(builder), `Checked builder ${builder} for SERVER_MESSAGE.${key} is not called in server/`);
    }
    assert.ok(usedPublicServerKeys.has(key), `SERVER_MESSAGE.${key} is not handled in public/`);
  }

  const httpApiCode = readFileSync(path.resolve('server', 'http-api.js'), 'utf8');
  const httpBuilders = [
    'healthResponse',
    'profileResponse',
    'profileToggleResponse',
    'clientConfigResponse',
    'roomsResponse',
    'createRoomResponse',
    'replaysResponse',
    'httpErrorResponse',
  ];
  for (const builder of httpBuilders) {
    assert.match(httpApiCode, new RegExp(`\\.json\\(\\s*${builder}\\s*\\(`), `server/http-api.js must use ${builder}()`);
  }
  for (const [, arg] of httpApiCode.matchAll(/\.json\(\s*([A-Za-z0-9_{}[\]'"`]+)/g)) {
    assert.ok(httpBuilders.includes(arg), `server/http-api.js calls .json(${arg}...) without a checked HTTP response builder`);
  }
});
