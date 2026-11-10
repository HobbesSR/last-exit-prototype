import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_LIBRARIES, generateMacro, validateLibrary } from '../map/chain.ts';
import { adjacencyCompatibility, setPieceSeamProblems } from '../map/macro/src/chain/placement.ts';

/**
 * #851's sparser tile sides, adopted as the bundled content in #895 (`common-primitives@7`,
 * `common-set-pieces@7`, `district-set-pieces@6`; 52.1, 42.44): `sparse` fill and `alternate`
 * set-piece borders. Macro only. The experiment's other schemes are in 42.40.
 */
const LINE = { N: 'h:0', E: 'v:6', S: 'h:6', W: 'v:0' };
const SIDES = ['N', 'E', 'S', 'W'], STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const side = (tile, s) => Array.from({ length: 6 }, (_, i) => {
  const p = tile.segments?.[`${LINE[s]},${i}`]?.passability;
  return p === 'passable' ? 'P' : p === 'not-passable-hint' ? 'h' : p === 'any' ? 'a' : '.';
}).join('');
const HALF = ['hhhPPP', 'PPPhhh'];

test('the bundled libraries are valid, fit their set pieces, and fillable tiles keep sparse sides', () => {
  for (const library of CHAIN_LIBRARIES) {
    assert.deepEqual(validateLibrary(library).errors, [], library.name);
    assert.deepEqual(setPieceSeamProblems(library), [], library.name);
    assert.equal(library.fitPlacedSetPieces, true, `${library.name} fits pieces placed side by side (#856)`);
    // No fillable tile keeps two or more half-and-half sides unless it is a family's 10% fallback.
    const families = new Set(library.tiles.filter(tile => /-open-[nesw]+$/.test(tile.id)).map(tile => tile.id.replace(/-open-[nesw]+$/, '')));
    for (const tile of library.tiles) if (tile.fillable !== false && !/-open-[nesw]+$/.test(tile.id) && SIDES.filter(s => HALF.includes(side(tile, s))).length >= 2)
      assert.ok(families.has(tile.id), `${library.name}: ${tile.id} has a sparse family`);
  }
});

/**
 * Piece-frame sides of each slot, inner or outer, by the slot's members turned as the slot turns
 * them. Slots whose orientation placement chooses are skipped: sparse sides leave them as authored.
 */
function pieceSides(library, piece) {
  const sets = new Map(library.tileSets.map(set => [set.id, set]));
  const tiles = new Map(library.tiles.map(tile => [tile.id, tile]));
  const at = new Set(piece.tiles.map(slot => `${slot.dx},${slot.dy}`));
  const inner = [], outer = [];
  for (const slot of piece.tiles) for (const id of sets.get(slot.tileSetId).members) {
    const member = tiles.get(id);
    const orientation = slot.orientation ?? (member.orientations.length === 1 ? member.orientations[0] : undefined);
    if (orientation === undefined) continue;
    for (const s of SIDES) {
      // A slot turned clockwise by `orientation` shows its tile's side (s - turns) on the piece's side s.
      const pattern = side(member, SIDES[(SIDES.indexOf(s) - orientation / 90 + 8) % 4]);
      (at.has(`${slot.dx + STEP[s][0]},${slot.dy + STEP[s][1]}`) ? inner : outer).push({ where: `${slot.dx},${slot.dy} ${s}`, pattern });
    }
  }
  return { inner, outer };
}

test('set pieces hint their inner half-and-half seams and keep an outer opening', () => {
  for (const library of CHAIN_LIBRARIES) for (const piece of library.setPieces) {
    const { inner, outer } = pieceSides(library, piece);
    const name = `${library.name}: ${piece.id}`;
    for (const { where, pattern } of inner) assert.ok(!HALF.includes(pattern), `${name} ${where} is an inner seam`);
    if (outer.length) assert.ok(outer.some(({ pattern }) => pattern.includes('P') || pattern.includes('a')), `${name} keeps an opening`);
  }
});

test('placement fits set pieces placed side by side (#856), and the 12 x 6 map places', () => {
  const library = CHAIN_LIBRARIES[0];
  const map = generateMacro('size-12-1', { zoneWidth: 12, zoneHeight: 6 }, library);
  const fits = adjacencyCompatibility(library);
  const option = slot => ({ templateId: slot.design, orientation: slot.orientation, difficulty: 0, weight: 1 });
  const slots = new Map(map.layout.slots.map(slot => [`${slot.col},${slot.row}`, slot]));
  const owner = new Map(map.layout.setPieces.flatMap(instance => instance.slots.map(slot => [`${slot.col},${slot.row}`, instance.id])));
  // Without the fit, closed borders beside open ones fail most attempts (42.40).
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
