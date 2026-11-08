import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, generateMacro, validateLibrary } from '../map/chain.ts';
import { sparseSidesLibrary } from '../map/sparse-sides.ts';
import { adjacencyCompatibility, setPieceSeamProblems } from '../map/macro/src/chain/placement.ts';

/**
 * #851: the experimental sparse-sides libraries (map/sparse-sides.ts, 42.40), offered by the Map
 * Lab and switched off everywhere else. Macro only: building is the comparison's job.
 */
const SCHEMES = [];
for (const fill of ['bundled', 'sparse']) for (const setPieces of ['bundled', 'inner', 'alternate', 'face'])
  SCHEMES.push({ fill, setPieces });

const LINE = { N: 'h:0', E: 'v:6', S: 'h:6', W: 'v:0' };
const side = (tile, s) => Array.from({ length: 6 }, (_, i) => {
  const p = tile.segments?.[`${LINE[s]},${i}`]?.passability;
  return p === 'passable' ? 'P' : p === 'not-passable-hint' ? 'h' : p === 'any' ? 'a' : '.';
}).join('');

test('every sparse-sides library is valid, its set pieces fit inside, and the bundled ones are untouched', () => {
  const before = JSON.stringify(CHAIN_LIBRARIES);
  for (const bundled of CHAIN_LIBRARIES) for (const scheme of SCHEMES) {
    const library = sparseSidesLibrary(bundled, scheme);
    const name = `${bundled.name} ${scheme.fill}/${scheme.setPieces}`;
    assert.deepEqual(validateLibrary(library).errors, [], name);
    assert.deepEqual(setPieceSeamProblems(library), [], name);
    assert.equal(library.fitPlacedSetPieces, true, name);
    // A side changes whole: no tile gains a passable segment, or a side that is neither as authored nor all hinted.
    const authored = new Map(bundled.tiles.map(tile => [tile.id, tile]));
    for (const tile of library.tiles) {
      const source = authored.get(tile.id) ?? authored.get(tile.id.replace(/-(open|sp)-[nesw]+$/, ''));
      assert.ok(source, `${name}: ${tile.id} derives from a bundled tile`);
      for (const s of Object.keys(LINE))
        assert.ok([side(source, s), 'hhhhhh'].includes(side(tile, s)), `${name}: ${tile.id} ${s} is ${side(tile, s)}`);
    }
  }
  assert.equal(JSON.stringify(CHAIN_LIBRARIES), before);
  assert.equal(CHAIN_LIBRARIES.some(library => 'fitPlacedSetPieces' in library), false);
});

test('one opening per face leaves every set piece at least one open outer side and hints its inner seams', () => {
  const library = sparseSidesLibrary(CHAIN_LIBRARIES[0], { fill: 'bundled', setPieces: 'face' });
  const sets = new Map(library.tileSets.map(set => [set.id, set]));
  const tiles = new Map(library.tiles.map(tile => [tile.id, tile]));
  const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  for (const piece of library.setPieces) {
    const at = new Set(piece.tiles.map(slot => `${slot.dx},${slot.dy}`));
    let open = 0;
    for (const slot of piece.tiles) {
      // Only fixed-orientation slots are rewritten, and the inward and station tiles are fixed at 0.
      if (slot.orientation) continue;
      for (const member of sets.get(slot.tileSetId).members) for (const [s, [dx, dy]] of Object.entries(STEP)) {
        const pattern = side(tiles.get(member), s);
        if (at.has(`${slot.dx + dx},${slot.dy + dy}`)) assert.notEqual(pattern, 'hhhPPP', `${piece.id} ${slot.dx},${slot.dy} ${s} is inner`);
        else if (pattern.includes('P')) open++;
      }
    }
    const rotated = piece.tiles.some(slot => slot.orientation);
    assert.ok(open > 0 || rotated, `${piece.id} keeps an opening`);
  }
});

test('placement fits set pieces placed side by side when the library asks (#856), and the 12 x 6 map places', () => {
  const library = sparseSidesLibrary(CHAIN_LIBRARIES[0], { fill: 'sparse', setPieces: 'face' });
  const map = generateMacro('size-12-1', { zoneWidth: 12, zoneHeight: 6 }, library);
  const fits = adjacencyCompatibility(library);
  const option = slot => ({ templateId: slot.design, orientation: slot.orientation, difficulty: 0, weight: 1 });
  const slots = new Map(map.layout.slots.map(slot => [`${slot.col},${slot.row}`, slot]));
  const owner = new Map(map.layout.setPieces.flatMap(instance => instance.slots.map(slot => [`${slot.col},${slot.row}`, instance.id])));
  // Without the fit (#856), closed borders beside open ones failed every attempt on this seed (42.40).
  for (const [key, id] of owner) {
    const [col, row] = key.split(',').map(Number);
    for (const [dc, dr, relation] of [[1, 0, 'E'], [0, 1, 'S']]) {
      const other = `${col + dc},${row + dr}`;
      if (!owner.has(other) || owner.get(other) === id) continue;
      assert.ok(fits(option(slots.get(key)), relation, option(slots.get(other))), `${id} at ${key} and ${owner.get(other)} at ${other}`);
    }
  }
  assert.ok(map.layout.setPieces.length > 0);
});
