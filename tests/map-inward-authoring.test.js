import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tool = resolve('map/tools/author-inward-grounds.mts');
const names = ['common-primitives@5.json', 'common-set-pieces@5.json', 'district-set-pieces@4.json'];
const source = names.map(name => resolve('map/macro/content', name));
const localName = 'diamond-36x18.json';
const localSource = resolve('map/macro/content', localName);
const args = files => ['--primitives', files[0], '--common', files[1], '--district', files[2]];
const invoke = (files, extra = []) => spawnSync(process.execPath, [tool, ...args(files), ...extra], { encoding: 'utf8' });
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function withCopies(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'last-exit-inward-'));
  const files = names.map((name, i) => { const file = join(dir, name); copyFileSync(source[i], file); return file; });
  try { fn(files, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function withLocalCopies(fn) {
  withCopies((files, dir) => {
    const localFile = join(dir, localName);
    copyFileSync(localSource, localFile);
    fn([...files, localFile], dir);
  });
}

const invokeWithLocal = (files, extra = []) => invoke(files, ['--local-library', files[3], ...extra]);

test('committed inward variants and blueprint references reconstruct from original grounds', () => {
  const result = invoke(source, ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /81 inward variants and 1504 blueprint references/);
});

test('committed large-library local joins reconstruct with the included modules', () => {
  const result = invokeWithLocal([...source, localSource], ['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /81 inward variants and 3513 blueprint references/);
});

test('a later schema 1 content revision can pin its matching primitives revision', () => withCopies(files => {
  const primitives = json(files[0]);
  primitives.version++;
  save(files[0], primitives);
  for (const file of files.slice(1)) {
    const blueprint = json(file);
    blueprint.version++;
    blueprint.includes.find(ref => ref.name === 'common-primitives').version = primitives.version;
    save(file, blueprint);
  }
  const result = invoke(files);
  assert.equal(result.status, 0, result.stderr);
}));

test('custom same-class singleton grounds and adjacent slots retain their authored identity', () => withCopies((files, dir) => {
  const primitives = json(files[0]);
  const custom = structuredClone(primitives.tiles.find(tile => tile.id === 'block-ground'));
  custom.id = 'custom-block-ground';
  custom.segments['h:0,3'].passability = 'any';
  primitives.tiles.push(custom);
  const customSet = { id: 'custom-block-tiles', members: [custom.id] };
  primitives.tileSets.push(customSet);
  save(files[0], primitives);
  const common = json(files[1]);
  const probe = { id: 'custom-ground-probe', primaryRegionClass: 'block', tiles: [
    { dx: 0, dy: 0, tileSetId: 'block-grounds' },
    { dx: 1, dy: 0, tileSetId: customSet.id },
    { dx: 2, dy: 0, tileSetId: customSet.id },
    { dx: 5, dy: 0, tileSetId: customSet.id },
  ] };
  common.setPieces.push(probe);
  save(files[1], common);
  const check = invoke(files);
  assert.equal(check.status, 0, check.stderr);
  const out = join(dir, 'regenerated');
  const result = invoke(files, ['--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  const generated = json(join(out, names[0]));
  assert.deepEqual(generated.tiles.find(tile => tile.id === custom.id), custom);
  assert.deepEqual(generated.tileSets.find(set => set.id === customSet.id), customSet);
  const slots = json(join(out, names[1])).setPieces.find(piece => piece.id === probe.id).tiles;
  assert.deepEqual(slots, probe.tiles);
}));

test('an edited original exterior prescription is detected and regenerated on exposed sides', () => withCopies((files, dir) => {
  const primitives = json(files[0]);
  primitives.tiles.find(tile => tile.id === 'block-ground').segments['h:0,3'].passability = 'any';
  save(files[0], primitives);
  const stale = invoke(files);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /differs/);
  const out = join(dir, 'regenerated');
  const result = invoke(files, ['--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  const generated = json(join(out, names[0]));
  const exposed = generated.tiles.find(tile => tile.id === 'block-ground-inward-es');
  assert.equal(exposed.segments['h:0,3'].passability, 'any');
  assert.equal(exposed.segments['v:6,3'].passability, 'not-passable-hint');
  assert.equal(exposed.segments['h:6,3'].passability, 'not-passable-hint');
  assert.equal(invoke([join(out, names[0]), join(out, names[1]), join(out, names[2])]).status, 0);
}));

test('regeneration writes equivalent modules into a separate directory', () => withCopies((files, dir) => {
  const out = join(dir, 'generated');
  const result = invoke(files, ['--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  names.forEach((name, i) => assert.deepEqual(json(join(out, name)), json(files[i]), name));
  files.forEach((file, i) => assert.deepEqual(json(file), json(source[i]), 'input remains unchanged'));
  const again = invoke(files, ['--out-dir', out]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /refusing to overwrite existing output/);
}));

test('regeneration repairs a changed variant and slot reference in copied modules', () => withCopies((files, dir) => {
  const primitives = json(files[0]);
  primitives.tiles.find(tile => tile.id === 'block-ground-inward-es').segments['v:6,3'].passability = 'passable';
  save(files[0], primitives);
  const common = json(files[1]);
  common.setPieces.find(piece => piece.id === 'city-block').tiles[0].tileSetId = 'block-grounds';
  save(files[1], common);
  const out = join(dir, 'regenerated');
  const result = invoke(files, ['--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  names.forEach((name, i) => assert.deepEqual(json(join(out, name)), json(source[i]), name));
}));

test('check detects changed originals, variants, membership, and blueprint slot references', () => {
  const cases = [
    ['original', 0, value => { delete value.tiles.find(tile => tile.id === 'block-ground').segments['h:0,3']; }],
    ['variant', 0, value => { value.tiles.find(tile => tile.id === 'block-ground-inward-es').segments['h:0,0'].passability = 'passable'; }],
    ['set member', 0, value => { value.tileSets.find(set => set.id === 'block-ground-inward-es-tiles').members = ['block-ground']; }],
    ['missing variant', 0, value => { value.tiles = value.tiles.filter(tile => tile.id !== 'block-ground-inward-es'); }],
    ['extra variant', 0, value => { value.tiles.push({ ...value.tiles.find(tile => tile.id === 'block-ground-inward-es'), id: 'block-ground-inward-n' }); }],
    ['slot reference', 1, value => { value.setPieces.find(piece => piece.id === 'city-block').tiles[0].tileSetId = 'block-grounds'; }],
  ];
  for (const [label, index, mutate] of cases) withCopies(files => {
    const value = json(files[index]);
    mutate(value);
    save(files[index], value);
    const result = invoke(files);
    assert.notEqual(result.status, 0, `${label} must fail`);
    assert.match(result.stderr, /lacks|changed|differs/, `${label}: ${result.stderr}`);
  });
});

test('regeneration refuses an output directory resolving to any input file', () => withCopies((files, dir) => {
  const result = invoke(files, ['--out-dir', dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite input/);
  files.forEach((file, i) => assert.deepEqual(json(file), json(source[i])));
}));

// Every same-class ground slot in the 36x18 library's five local quarters (#530).
const LOCAL_JOINS = [
  ['market-quarter', 'market', 270], ['market-quarter', 'park', 90], ['market-quarter', 'hall', 90],
  ['industrial-quarter', 'plant', 240], ['industrial-quarter', 'depot', 180],
  ['city-centre', 'block', 240], ['city-centre', 'market', 72], ['city-centre', 'park', 108],
  ['military-quarter', 'compound', 312], ['military-quarter', 'checkpoint', 78],
  ['ruined-quarter', 'ruins', 224], ['ruined-quarter', 'park', 84],
];

test('optional library authors local same-class joins and preserves every other slot', () => withLocalCopies((files, dir) => {
  const original = json(files[3]);
  const output = join(dir, 'generated');
  const result = invokeWithLocal(files, ['--out-dir', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /81 inward variants and 3513 blueprint references/);
  const generated = json(join(output, localName));
  const target = (kind, slot) => slot.tileSetId === `${kind}-grounds` || slot.tileSetId.startsWith(`${kind}-ground-inward-`);
  const pieces = [...new Set(LOCAL_JOINS.map(([id]) => id))];
  for (const [id, kind, count] of LOCAL_JOINS) {
    const before = original.setPieces.find(piece => piece.id === id);
    const after = generated.setPieces.find(piece => piece.id === id);
    assert.equal(before.tiles.filter(slot => target(kind, slot)).length, count, id);
    assert.equal(after.tiles.filter(slot => slot.tileSetId.startsWith(`${kind}-ground-inward-`)).length, count, id);
    for (const [index, slot] of after.tiles.entries()) {
      if (!LOCAL_JOINS.some(([pieceId, targetKind]) => pieceId === id && target(targetKind, before.tiles[index])))
        assert.deepEqual(slot, before.tiles[index], `${id} slot ${index}`);
    }
  }
  assert.deepEqual(generated.setPieces.filter(piece => !pieces.includes(piece.id)),
    original.setPieces.filter(piece => !pieces.includes(piece.id)));
  assert.deepEqual({ ...generated, setPieces: original.setPieces }, original);
  assert.equal(invokeWithLocal([
    ...names.map(name => join(output, name)), join(output, localName)], ['--check']).status, 0);
}));

test('optional library check detects stale local references', () => withLocalCopies((files, dir) => {
  const output = join(dir, 'generated');
  assert.equal(invokeWithLocal(files, ['--out-dir', output]).status, 0);
  const generatedFiles = [...names, localName].map(name => join(output, name));
  const current = json(generatedFiles[3]);
  for (const [id, kind] of LOCAL_JOINS) {
    const library = structuredClone(current);
    const slot = library.setPieces.find(piece => piece.id === id).tiles
      .find(slot => slot.tileSetId.startsWith(`${kind}-ground-inward-`));
    slot.tileSetId = `${kind}-grounds`;
    save(generatedFiles[3], library);
    const result = invokeWithLocal(generatedFiles, ['--check']);
    assert.notEqual(result.status, 0, id);
    assert.match(result.stderr, /differs/);
  }
}));

test('optional library variants retain exposed original prescriptions', () => withLocalCopies((files, dir) => {
  const primitives = json(files[0]);
  primitives.tiles.find(tile => tile.id === 'compound-ground').segments['h:0,3'].passability = 'any';
  save(files[0], primitives);
  const output = join(dir, 'generated');
  const result = invokeWithLocal(files, ['--out-dir', output]);
  assert.equal(result.status, 0, result.stderr);
  const variant = json(join(output, names[0])).tiles.find(tile => tile.id === 'compound-ground-inward-es');
  assert.equal(variant.segments['h:0,3'].passability, 'any');
  assert.equal(variant.segments['v:6,3'].passability, 'not-passable-hint');
  assert.equal(variant.segments['h:6,3'].passability, 'not-passable-hint');
}));

test('optional library requires the library format version, some name and its matching primitive pin', () => withLocalCopies((files, dir) => {
  const library = json(files[3]);
  library.name = 'custom-large-library';
  save(files[3], library);
  assert.equal(invokeWithLocal(files, ['--out-dir', join(dir, 'custom')]).status, 0);
  library.version = 2;
  save(files[3], library);
  assert.match(invokeWithLocal(files, ['--check']).stderr, /format version 3/);
  library.version = 3;
  delete library.name;
  save(files[3], library);
  assert.match(invokeWithLocal(files, ['--check']).stderr, /named local library/);
  library.name = 'custom-large-library';
  library.includes.find(ref => ref.name === 'common-primitives').version++;
  save(files[3], library);
  assert.match(invokeWithLocal(files, ['--check']).stderr, /expected common-primitives@5 include/);
}));

test('optional library refuses an output resolving to the fourth input', () => withLocalCopies((files, dir) => {
  const result = invokeWithLocal(files, ['--out-dir', dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite input/);
  assert.deepEqual(json(files[3]), json(localSource));
}));
