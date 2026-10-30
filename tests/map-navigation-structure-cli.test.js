import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chainMapToBson, chainMapToJson } from '../map/macro/src/chain/saving.ts';
import { CHAIN_LIBRARY, generate } from '../map/tools/core.ts';

const run = (...args) => spawnSync(process.execPath, ['map/tools/cli.mts', ...args], { encoding: 'utf8' });

test('navigation measures saved JSON and BSON maps deterministically without changing them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'navigation-cli-'));
  try {
    const map = generate('navigation-cli', { mode: 'playground', zoneWidth: 2, zoneHeight: 1 });
    const json = path.join(dir, 'map.json'), bson = path.join(dir, 'map.bson'), report = path.join(dir, 'report.json');
    writeFileSync(json, chainMapToJson(map));
    writeFileSync(bson, chainMapToBson(map));
    const jsonBytes = readFileSync(json), bsonBytes = readFileSync(bson);
    assert.match(run('help').stdout, /navigation FILE \[--out FILE\]/);
    const first = run('navigation', json);
    assert.equal(first.status, 0, first.stderr);
    const measured = JSON.parse(first.stdout);
    assert.equal(measured.version, 'navigation-structure-1');
    assert.deepEqual(measured.roles.map(role => role.body), ['contestant', 'hunter']);
    assert.ok(measured.roles.every(role => role.samples.length > 0));
    const second = run('navigation', json, '--out', report);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), measured);
    const binary = run('navigation', bson);
    assert.equal(binary.status, 0, binary.stderr);
    assert.deepEqual(JSON.parse(binary.stdout), measured);
    assert.deepEqual(readFileSync(json), jsonBytes);
    assert.deepEqual(readFileSync(bson), bsonBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('navigation rejects missing files, invalid input and libraries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'navigation-invalid-'));
  try {
    const invalid = path.join(dir, 'invalid.json'), library = path.join(dir, 'library.json');
    writeFileSync(invalid, '{invalid');
    writeFileSync(library, JSON.stringify(CHAIN_LIBRARY));
    for (const args of [[], [invalid], [path.join(dir, 'missing.json')]]) {
      const result = run('navigation', ...args);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr);
    }
    const result = run('navigation', library);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /saved map, not a library/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
