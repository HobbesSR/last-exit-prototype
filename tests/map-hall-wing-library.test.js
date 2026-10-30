import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readLibraryFile } from '../map/tools/library-files.mts';
import { resolution } from '../map/macro/src/chain/resolution.ts';
import { regions } from '../map/macro/src/chain/regions.ts';
import { briefs, chainZones } from '../map/macro/src/chain/briefs.ts';
import { buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const sides = [['n',0,-1,'h:0'], ['e',1,0,'v:6'], ['s',0,1,'h:6'], ['w',-1,0,'v:0']];
const isHall = (x,y) => x >= 0 && x < 6 && y >= 0 && y < 5 && (y < 2 || x < 3);
const names = ['diamond-12x6','diamond-24x12','diamond-36x18'];
const paths = names.map(n => resolve(`map/macro/content/${n}.json`));
const libraries = paths.map(p => readLibraryFile(p));
const find = (list, id) => { const value = list.find(item => item.id === id); assert.ok(value, id); return value; };

test('all resolved libraries contain the L variant alongside their rectangular hall, with compatible prescriptions', () => {
  for (let i = 0; i < libraries.length; i++) {
    const library = libraries[i], piece = find(library.setPieces, 'pillar-hall-winged');
    const owner = library.setPieceClasses.find(c => c.setPieces.includes('pillar-hall'));
    assert.ok(owner.setPieces.includes(piece.id));
    assert.ok(library.setPieces.some(p => p.id === 'pillar-hall'));
    assert.equal(piece.primaryRegionClass, 'hall');
    assert.equal(piece.tiles.length, 30);
    const original = find(library.tiles, 'hall-ground');
    const field = find(library.tiles, find(library.tileSets, 'fields').members[0]);
    assert.equal(field.defaultCellClass, 'open');
    assert.ok(Object.values(field.segments).every(s => s.passability === 'any' && Object.keys(s).length === 1));
    for (const slot of piece.tiles) {
      const {dx:x,dy:y,tileSetId} = slot;
      if (!isHall(x,y)) { assert.equal(tileSetId, 'fields'); continue; }
      const mask = sides.filter(([,dx,dy]) => isHall(x+dx,y+dy)).map(([d]) => d).join('');
      assert.equal(tileSetId, `hall-ground-inward-${mask}-tiles`);
      const tile = find(library.tiles, find(library.tileSets, tileSetId).members[0]);
      assert.equal(tile.defaultCellClass, 'hall');
      for (const [d,dx,dy,prefix] of sides) for (let k=0;k<6;k++) {
        const key = `${prefix},${k}`;
        if (isHall(x+dx,y+dy)) assert.equal(tile.segments[key].passability, 'not-passable-hint', `${names[i]} ${x},${y} ${d}`);
        else assert.deepEqual(tile.segments[key], original.segments[key], `${names[i]} exposed ${x},${y} ${d}`);
      }
    }
    const tool = resolve('map/tools/author-inward-grounds.mts');
    const content = resolve('map/macro/content');
    const result = spawnSync(process.execPath, [tool, '--primitives', `${content}/common-primitives@5.json`, '--common', `${content}/common-set-pieces@5.json`, '--district', `${content}/district-set-pieces@4.json`, '--local-library', paths[i], '--check'], { encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('a placed winged variant becomes an L-shaped hall brief with real portals and structural wings', () => {
  const library = libraries[0], piece = find(library.setPieces, 'pillar-hall-winged');
  const ox=25, oy=12, slots=[];
  for (let y=-1;y<=5;y++) for (let x=-1;x<=6;x++) {
    const slot = piece.tiles.find(t => t.dx === x && t.dy === y);
    const set = find(library.tileSets, slot?.tileSetId ?? 'fields');
    slots.push({col:ox+x,row:oy+y,design:set.members[0],orientation:0});
  }
  const params = { mode:'playground', zoneWidth:12, zoneHeight:6, exitCount:2, contestantCount:8, hunterCount:3, lootChance:0.04, lootTierStep:0.09 };
  for (const seed of ['1', '7', '533']) {
  const layout = { seed, params, library:library.name, slots, setPieces:[] };
  const resolved = resolution(layout, library), found = regions(resolved, layout.seed);
  const region = found.regions.find(r => r.class === 'hall');
  assert.ok(region);
  assert.equal(region.cells.length, 21 * 36);
  const input = briefs(layout, resolved, found, chainZones(params), library, 40).find(b => b.id === region.id);
  assert.ok(input.portals.length > 0);
  assert.equal(input.internalGuaranteed.length, 0);
  const result = buildRegion(input);
  const wings = result.elements.filter(e => e.label.startsWith('hall-wing-'));
  assert.ok(wings.some(e => e.template.parts.length > 0), seed);
  assert.deepEqual(validatePortalReach({ ...input, blockers:result.elements.flatMap(e => elementShapes(e)) }).errors, [], seed);
  }
});
