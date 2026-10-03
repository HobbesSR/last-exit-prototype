import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chainMapToBson, chainMapToJson } from '../map/macro/src/chain/saving.ts';
import { CHAIN_LIBRARY, batch, chainParams, checkMap, generate, readMap, validateLibrary } from '../map/tools/core.ts';
import { GAME_ENGINES } from '../map/tools/engines.ts';
import { REGION_TYPES_VERSION } from '../map/micro/region-types.ts';

/**
 * Step 10a (#144): the CLI and MCP in map/tools/, on the chain and the game's engines.
 * A playground map keeps the subprocess tests fast; one game map covers the default.
 */
const SMALL = { mode: 'playground', zoneWidth: 2, zoneHeight: 1 };

test('the tools build with the game registry and the chain library', () => {
  assert.equal(GAME_ENGINES.version, REGION_TYPES_VERSION);
  assert.deepEqual(validateLibrary(CHAIN_LIBRARY), { valid: true, errors: [] });
  const map = generate('tools-game');
  assert.equal(map.layout.params.mode, 'game');
  assert.equal(map.build, REGION_TYPES_VERSION);
  const check = checkMap(map);
  assert.equal(check.valid, true, JSON.stringify(check.defects));
  assert.equal(check.brokenPromises, undefined, 'the slow diagnostic runs only on request');
  // Saved whole in either encoding, or as the Layout alone, it reads back the same map.
  for (const saved of [JSON.parse(chainMapToJson(map)), chainMapToBson(map), JSON.parse(chainMapToJson(map, { results: false }))])
    assert.deepEqual(readMap(saved), map);
});

test('params take the game defaults, and refuse what placement cannot use', () => {
  assert.deepEqual(chainParams({ exits: '3', contestants: 24 }), { ...chainParams(), exitCount: 3, contestantCount: 24 });
  assert.throws(() => chainParams({ mode: 'arena' }), /mode must be game or playground/);
  assert.throws(() => chainParams({ zoneWidth: 2.5 }), /zoneWidth must be a whole number/);
  assert.throws(() => chainParams({ lootChance: -1 }), /lootChance must be a number of at least 0/);
  assert.throws(() => chainParams({ columns: 4 }), /columns is not a map param/);
  assert.throws(() => generate('x', SMALL, { version: 2 }), /invalid library/);
});

test('a batch reports its sample size, and diagnoses on request', () => {
  const report = batch('tools-batch', 2, SMALL, undefined, { diagnose: true });
  assert.equal(report.valid, true, JSON.stringify([report.defective, report.failures]));
  assert.equal(report.generated, 2);
  assert.equal(report.diagnosed, true);
  assert.equal(report.metrics.regions.samples, 2);
  assert.equal(report.metrics.defects.max, 0);
  // A seed placement can't serve is a failure, not a thrown batch.
  const failed = batch('tools-fail', 1, { ...SMALL, mode: 'game' });
  assert.equal(failed.valid, false);
  assert.equal(failed.generated, 0);
  assert.match(failed.failures[0].error, /game mode requires 12 x 6 tile zones/);
});

function run(file, args = [], input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

test('the CLI generates, saves, reloads and validates a chain map', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'map-tools-'));
  try {
    const json = path.join(dir, 'map.json'), bson = path.join(dir, 'layout.bson'), library = path.join(dir, 'library.json');
    const flags = ['--mode', 'playground', '--zone-width', '2', '--zone-height', '1'];
    assert.match((await run('map/tools/cli.mts', ['help'])).out, /generate --seed SEED/);
    assert.equal((await run('map/tools/cli.mts', ['generate', '--seed', 'cli', ...flags, '--out', json])).code, 0);
    assert.equal(JSON.parse(readFileSync(json, 'utf8')).wire, 6);
    assert.equal((await run('map/tools/cli.mts', ['generate', '--seed', 'cli', ...flags, '--layout-only', 'true', '--out', bson])).code, 0);
    for (const file of [json, bson]) {
      const checked = await run('map/tools/cli.mts', ['validate', file]);
      assert.equal(checked.code, 0, checked.err);
      assert.equal(JSON.parse(checked.out).valid, true);
    }
    // A library validates as one, and a map read with another library is refused by name.
    assert.equal((await run('map/tools/cli.mts', ['library', '--out', library])).code, 0);
    assert.equal(JSON.parse((await run('map/tools/cli.mts', ['validate', library])).out).valid, true);
    const other = JSON.parse(readFileSync(library, 'utf8'));
    other.tiles = other.tiles.slice().reverse();
    writeFileSync(library, JSON.stringify(other));
    const refused = await run('map/tools/cli.mts', ['validate', json, '--library', library]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /made with a different library/);
    assert.equal((await run('map/tools/cli.mts', ['nope'])).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP generates a map, validates it, and bounds what it runs', async () => {
  const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'map_generate', { seed: 'mcp', params: SMALL }),
    call(4, 'library_validate', { library: CHAIN_LIBRARY }),
    call(5, 'map_batch', { count: 6, diagnose: true }),
    call(6, 'map_generate', {}),
    { jsonrpc: '2.0', id: 7, method: 'nope' },
  ];
  // The server answers each line in turn and exits when its input ends, so no wait is guessed.
  const first = await run('map/tools/mcp.mts', [], `${requests.map(r => JSON.stringify(r)).join('\n')}\nnot json\n`);
  const replies = new Map(first.out.trim().split('\n').map(line => JSON.parse(line)).map(m => [m.id, m]));
  const body = id => JSON.parse(replies.get(id).result.content[0].text);
  assert.ok(replies.get(1).result.capabilities.tools);
  assert.deepEqual(replies.get(2).result.tools.map(tool => tool.name), ['map_generate', 'map_validate', 'library_validate', 'map_batch', 'library_get']);
  const generated = body(3);
  assert.equal(generated.map.wire, 6);
  assert.deepEqual(generated.defects, []);
  assert.equal(body(4).valid, true);
  assert.equal(replies.get(5).result.isError, true);
  assert.match(body(5).error, /a diagnosed batch takes at most 5 maps/);
  assert.match(body(6).error, /seed must be a string or number/);
  assert.equal(replies.get(7).error.code, -32601);
  assert.equal(replies.get(null).error.code, -32700);

  const second = await run('map/tools/mcp.mts', [], `${JSON.stringify(call(1, 'map_validate', { map: generated.map, diagnose: true }))}\n`);
  const validated = JSON.parse(JSON.parse(second.out).result.content[0].text);
  assert.equal(validated.valid, true);
  assert.deepEqual(validated.brokenPromises, []);
});

test("the Map Lab's server serves both halves, strips types, and nothing else", async (t) => {
  const child = spawn(process.execPath, ['map/tools/server.mts', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const [chunk] = await once(child.stdout, 'data');
  const base = /http:\/\/\S+/.exec(String(chunk))[0];
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
  assert.match(await page.text(), /Map Lab/);
  for (const served of ['/map/tools/lab/app.ts', '/map/tools/core.ts', '/map/chain.ts', '/map/engines.ts', '/map/macro/src/chain/map.ts', '/map/micro/compose.ts', '/map/kernel/contract.ts', '/shared/shape.ts']) {
    const response = await fetch(`${base}${served}`);
    assert.equal(response.status, 200, served);
    assert.match(response.headers.get('content-type'), /javascript/, served);
  }
  // Types are erased, and the bare `sat` resolves to its wrapped module, for workers too.
  const shape = await (await fetch(`${base}/shared/shape.ts`)).text();
  assert.match(shape, /from ["']\/vendor\/sat\.mjs["']/);
  assert.doesNotMatch(shape, /from ["']sat["']/);
  assert.match(await (await fetch(`${base}/vendor/sat.mjs`)).text(), /export default module\.exports/);
  const library = await fetch(`${base}/map/macro/content/chain-library.json`);
  assert.match(library.headers.get('content-type'), /json/);
  for (const refused of ['/map/tools/server.mts', '/map/tools/cli.mts', '/map/tools/sweep.mts', '/map/macro/package.json', '/map/macro/node_modules/typescript/package.json',
    '/package.json', '/.env.local', '/map/tools/lab/%2e%2e/server.mts', '/%2e%2e/%2e%2e/package.json', '/map/tools/lab/..%5c..%5cserver.mts'])
    assert.ok([403, 404].includes((await fetch(`${base}${refused}`)).status), refused);
});
